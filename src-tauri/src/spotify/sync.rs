//! Two-way sync with Spotify: bulk/single pulls into the local mirror, divergence detection
//! against the last-synced baseline, and the push planner (minimal delta with a full-replace
//! fallback) plus the push strategies built on it.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{
    ensure_token, err, get_json, send_capture, AppState, Paging, PlaylistMeta, PlaylistObj,
    PlaylistSummary, PlaylistTrackObj, API,
};
use super::store::{
    existing_file_for, existing_filenames, load_sync_meta, read_playlist_cached, save_sync_meta,
    sync_meta_of, unique_filename, upsert_sync_meta, write_atomic, write_playlist, PlaylistFile,
    SyncMeta, TrackEntry,
};
use super::store::{clear_staged, read_local};

// Ceiling on pages followed per paginated listing — insurance against a malformed
// self-referencing `next` link looping forever. Far above any real library: 200 pages is
// 20k tracks in one playlist, or 10k playlists.
const MAX_PAGES: usize = 200;

fn pagination_guard(pages: &mut usize) -> Result<(), String> {
    *pages += 1;
    if *pages > MAX_PAGES {
        return Err(format!(
            "Spotify pagination did not terminate after {MAX_PAGES} pages — aborting."
        ));
    }
    Ok(())
}

pub(crate) async fn fetch_tracks(
    state: &AppState,
    client_id: &str,
    playlist_id: &str,
) -> Result<Vec<TrackEntry>, String> {
    // `market=from_token` makes Spotify report `is_playable` (so we can flag greyed-out tracks)
    // relative to the user's country. It also enables track relinking — see `linked_from`.
    let mut url = format!("{API}/playlists/{playlist_id}/items?limit=100&market=from_token");
    let mut out = Vec::new();
    let mut pages = 0;
    loop {
        pagination_guard(&mut pages)?;
        let page: Paging<PlaylistTrackObj> = get_json(state, client_id, &url).await?;

        for entry in page.items {
            let Some(track) = entry.item else { continue }; // skip fully-absent/local tracks
            // Prefer the original (pre-relink) uri so the stored id matches what the playlist
            // really references; fall back to the top-level uri when there's no relink.
            let id = track.linked_from.map(|l| l.uri).unwrap_or(track.uri);
            out.push(TrackEntry {
                id,
                isrc: track.external_ids.and_then(|e| e.isrc),
                title: track.name,
                artists: track.artists.into_iter().map(|a| a.name).collect(),
                added_at: entry.added_at,
                added_by: entry.added_by.map(|a| a.id),
                duration_ms: track.duration_ms,
                is_playable: track.is_playable,
            });
        }

        match page.next {
            Some(next) => url = next,
            None => break,
        }
    }
    Ok(out)
}

pub async fn pull_playlists(
    state: &AppState,
    client_id: String,
    data_dir: PathBuf,
) -> Result<Vec<PlaylistSummary>, String> {
    // One library-mutating pull at a time (see `pull_lock`): concurrent pulls can mint colliding
    // filenames. A pull is already long-running, so serializing it costs nothing meaningful.
    let _pull = state.pull_lock.lock().await;
    // Fail fast (before touching the disk) when not connected; also warms the token cache.
    ensure_token(state, &client_id).await?;

    let playlists_dir = data_dir.join("playlists");
    std::fs::create_dir_all(&playlists_dir).map_err(err)?;

    // Page through the user's playlists.
    let mut all: Vec<PlaylistObj> = Vec::new();
    let mut url = format!("{API}/me/playlists?limit=50");
    let mut pages = 0;
    loop {
        pagination_guard(&mut pages)?;
        let page: Paging<PlaylistObj> = get_json(state, &client_id, &url).await?;
        all.extend(page.items);
        match page.next {
            Some(next) => url = next,
            None => break,
        }
    }

    // Preserve playlist identity across pulls by mapping existing local files by Spotify id:
    // a rename (or two playlists sharing a name) must update the SAME file, not spawn a
    // duplicate or reshuffle which file maps to which playlist. `used_names` is seeded with
    // every existing filename so a newly-minted name can never clobber an unrelated file
    // (including locally-created, not-yet-pushed playlists, which have no Spotify id). The
    // cached file is kept too so an unchanged playlist (matching snapshot_id) can reuse its
    // tracks instead of re-downloading them.
    let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut id_to_cached: std::collections::HashMap<String, (String, std::sync::Arc<PlaylistFile>)> =
        std::collections::HashMap::new();
    for entry in std::fs::read_dir(&playlists_dir).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(fname) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        used_names.insert(fname.clone());
        if let Some(pf) = read_playlist_cached(&path) {
            if !pf.spotify_id.is_empty() {
                id_to_cached.insert(pf.spotify_id.clone(), (fname, pf));
            }
        }
    }

    // Snapshot/last_synced live in the sidecar now; load it once for the cheap-skip gate and
    // batch every update back in one write after the loop.
    let mut meta_store = load_sync_meta(&data_dir);

    let mut summaries = Vec::with_capacity(all.len());

    for pl in all {
        let cached = id_to_cached.get(&pl.id);
        let existing_filename = cached.map(|(f, _)| f.clone());
        let cached_pf = cached.map(|(_, pf)| pf);
        // Skip the (paginated) track download when Spotify's snapshot_id is unchanged since
        // our last sync — the dominant cost of a bulk pull. Reuse the cached tracks and the
        // prior last_synced so an untouched playlist stays byte-identical on disk (no needless
        // git churn). Availability (is_playable) changes don't bump snapshot_id, so the
        // per-playlist Refresh still does a full re-fetch when the user wants one.
        //
        // The known snapshot/last_synced come from the sidecar, falling back to the cached
        // file's own fields so the first sync after the sidecar split doesn't re-download a
        // library that hasn't actually changed.
        let prev = meta_store.get(&pl.id);
        let prev_snapshot = prev
            .map(|m| m.snapshot_id.clone())
            .filter(|s| !s.is_empty())
            .or_else(|| cached_pf.map(|pf| pf.snapshot_id.clone()))
            .unwrap_or_default();
        let prev_last_synced = prev
            .map(|m| m.last_synced.clone())
            .filter(|s| !s.is_empty())
            .or_else(|| cached_pf.map(|pf| pf.last_synced.clone()))
            .unwrap_or_default();
        let reusable = cached_pf.and_then(|pf| {
            (!pl.snapshot_id.is_empty() && prev_snapshot == pl.snapshot_id)
                .then(|| (pf.tracks.clone(), prev_last_synced.clone()))
        });

        let (tracks, last_synced) = match reusable {
            Some(reused) => reused,
            None => match fetch_tracks(state, &client_id, &pl.id).await {
                Ok(tracks) => (tracks, chrono::Utc::now().to_rfc3339()),
                Err(e) => {
                    // A single inaccessible playlist (e.g. a Spotify-owned algorithmic list the
                    // Web API does not expose) must not abort the whole pull — record and skip.
                    summaries.push(PlaylistSummary {
                        spotify_id: pl.id,
                        name: pl.name,
                        track_count: 0,
                        file: None,
                        error: Some(e),
                    });
                    continue;
                }
            },
        };
        let track_count = tracks.len();

        // Reuse the file already mapped to this Spotify id (handles renames); only mint a new
        // unique filename for playlists we haven't stored before.
        let filename = existing_filename
            .unwrap_or_else(|| unique_filename(&pl.name, &mut used_names));
        let model = PlaylistFile {
            spotify_id: pl.id.clone(),
            name: pl.name.clone(),
            description: pl.description.unwrap_or_default(),
            snapshot_id: pl.snapshot_id,
            last_synced,
            cover_url: pl.images.first().map(|i| i.url.clone()),
            tracks,
        };

        let json = serde_json::to_string_pretty(&model).map_err(err)?;
        write_atomic(&playlists_dir.join(&filename), &json)?;
        if !model.spotify_id.is_empty() {
            meta_store.insert(model.spotify_id.clone(), sync_meta_of(&model));
        }

        summaries.push(PlaylistSummary {
            spotify_id: pl.id,
            name: pl.name,
            track_count,
            file: Some(filename),
            error: None,
        });
    }

    save_sync_meta(&data_dir, &meta_store)?;
    Ok(summaries)
}

/// List the user's playlists (metadata only — no track contents). This is the cheap part
/// of a pull: a few `/me/playlists` pages rather than one request per playlist. Lets the
/// user pull playlists individually instead of bursting the whole library at once.
pub async fn list_remote(
    state: &AppState,
    client_id: String,
) -> Result<Vec<PlaylistSummary>, String> {
    let mut out = Vec::new();
    let mut url = format!("{API}/me/playlists?limit=50");
    let mut pages = 0;
    loop {
        pagination_guard(&mut pages)?;
        let page: Paging<PlaylistObj> = get_json(state, &client_id, &url).await?;
        for pl in page.items {
            out.push(PlaylistSummary {
                spotify_id: pl.id,
                name: pl.name,
                track_count: pl.tracks.total,
                file: None,
                error: None,
            });
        }
        match page.next {
            Some(next) => url = next,
            None => break,
        }
    }
    Ok(out)
}

/// Pull a single playlist by Spotify id: fetch its tracks and write its JSON file. If we
/// already have a local file for this playlist it's overwritten in place; otherwise a fresh
/// unique filename is chosen. Only a handful of requests, so it won't trip the rate limit.
pub async fn pull_one(
    state: &AppState,
    client_id: String,
    data_dir: PathBuf,
    spotify_id: String,
) -> Result<PlaylistSummary, String> {
    // Serialize against other pulls so a concurrent bulk pull can't pick the same new filename.
    let _pull = state.pull_lock.lock().await;
    let playlists_dir = data_dir.join("playlists");
    std::fs::create_dir_all(&playlists_dir).map_err(err)?;

    let model = fetch_one(state, &client_id, &spotify_id).await?;

    let filename = match existing_file_for(&playlists_dir, &spotify_id)? {
        Some(existing) => existing, // re-pull overwrites the same file
        None => {
            let mut used = existing_filenames(&playlists_dir)?;
            unique_filename(&model.name, &mut used)
        }
    };

    write_playlist(&data_dir, &filename, &model)?;

    Ok(PlaylistSummary {
        spotify_id,
        name: model.name,
        track_count: model.tracks.len(),
        file: Some(filename),
        error: None,
    })
}

/// Fetch only a playlist's snapshot_id — a tiny response used to cheaply detect whether the
/// playlist changed without downloading all of its tracks.
async fn fetch_snapshot_id(
    state: &AppState,
    client_id: &str,
    playlist_id: &str,
) -> Result<String, String> {
    #[derive(Deserialize)]
    struct SnapResp {
        snapshot_id: String,
    }
    let resp: SnapResp = get_json(
        state,
        client_id,
        &format!("{API}/playlists/{playlist_id}?fields=snapshot_id"),
    )
    .await?;
    Ok(resp.snapshot_id)
}

pub(crate) async fn fetch_one(
    state: &AppState,
    client_id: &str,
    playlist_id: &str,
) -> Result<PlaylistFile, String> {
    let meta: PlaylistMeta =
        get_json(state, client_id, &format!("{API}/playlists/{playlist_id}")).await?;
    let tracks = fetch_tracks(state, client_id, playlist_id).await?;
    Ok(PlaylistFile {
        spotify_id: meta.id,
        name: meta.name,
        description: meta.description.unwrap_or_default(),
        snapshot_id: meta.snapshot_id,
        last_synced: chrono::Utc::now().to_rfc3339(),
        cover_url: meta.images.first().map(|i| i.url.clone()),
        tracks,
    })
}

// ---------------------------------------------------------------------------
// Two-way sync (divergence detection + safe push)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct TrackLite {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
}

#[derive(Serialize)]
pub struct SyncStatus {
    pub remote_changed: bool,
    pub baseline_snapshot: String,
    pub remote_snapshot: String,
    /// Tracks present on Spotify but not in our last-synced baseline.
    pub remote_added: Vec<TrackLite>,
    /// Tracks in our baseline but no longer on Spotify.
    pub remote_removed: Vec<TrackLite>,
}

#[derive(Serialize)]
pub struct PushResult {
    /// "applied" or "conflict".
    pub status: String,
    pub playlist: Option<PlaylistFile>,
    pub conflict: Option<SyncStatus>,
    /// A non-fatal note to show after an otherwise-successful push (e.g. Spotify ignored a
    /// description clear). None when everything applied cleanly.
    #[serde(default)]
    pub warning: Option<String>,
}

/// How to reconcile local edits with changes made on Spotify since the last sync.
/// Deserialized straight from the IPC payload, so an unknown string is rejected at the
/// boundary instead of silently falling into the most destructive branch.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum PushStrategy {
    /// Refuse (return a conflict) if Spotify changed since our last sync.
    Safe,
    /// Apply edits but also keep songs added on Spotify since the baseline.
    Merge,
    /// Make Spotify match the edits exactly, dropping remote-only changes.
    Overwrite,
}

fn lite(t: &TrackEntry) -> TrackLite {
    TrackLite {
        id: t.id.clone(),
        title: t.title.clone(),
        artists: t.artists.clone(),
    }
}

fn build_sync_status(baseline: &PlaylistFile, remote: &PlaylistFile) -> SyncStatus {
    let base: std::collections::HashSet<&str> =
        baseline.tracks.iter().map(|t| t.id.as_str()).collect();
    let rem: std::collections::HashSet<&str> =
        remote.tracks.iter().map(|t| t.id.as_str()).collect();
    // Decide "changed" from the actual track list (membership + order), not snapshot_id.
    // Spotify bumps snapshot_id even when nothing about the contents changed, which otherwise
    // produces phantom "Spotify changed since your last sync" warnings and false push conflicts.
    let base_seq: Vec<&str> = baseline.tracks.iter().map(|t| t.id.as_str()).collect();
    let rem_seq: Vec<&str> = remote.tracks.iter().map(|t| t.id.as_str()).collect();
    SyncStatus {
        remote_changed: base_seq != rem_seq,
        baseline_snapshot: baseline.snapshot_id.clone(),
        remote_snapshot: remote.snapshot_id.clone(),
        remote_added: remote
            .tracks
            .iter()
            .filter(|t| !base.contains(t.id.as_str()))
            .map(lite)
            .collect(),
        remote_removed: baseline
            .tracks
            .iter()
            .filter(|t| !rem.contains(t.id.as_str()))
            .map(lite)
            .collect(),
    }
}

/// Make a playlist exactly match `tracks` (replace first 100, append the rest).
///
/// NOT transactional: Spotify has no batch-or-nothing API, so a failure after the first
/// batch leaves the playlist holding only the tracks applied so far. The error message
/// says so; re-pushing (the staged edit survives until a push succeeds) completes the job.
async fn apply_replace(
    state: &AppState,
    client_id: &str,
    pid: &str,
    tracks: &[TrackEntry],
) -> Result<(), String> {
    let uris: Vec<String> = tracks.iter().map(|t| t.id.clone()).collect();
    let chunks: Vec<&[String]> = uris.chunks(100).collect();
    if chunks.is_empty() {
        let (st, body) = send_capture(
            state,
            client_id,
            state
                .http
                .put(format!("{API}/playlists/{pid}/items"))
                .json(&serde_json::json!({ "uris": [] })),
        )
        .await?;
        if !st.is_success() {
            return Err(format!("Clear failed (HTTP {st}): {}", body.trim()));
        }
    } else {
        for (i, chunk) in chunks.iter().enumerate() {
            let rb = if i == 0 {
                state.http.put(format!("{API}/playlists/{pid}/items"))
            } else {
                state.http.post(format!("{API}/playlists/{pid}/items"))
            };
            let (st, body) =
                send_capture(state, client_id, rb.json(&serde_json::json!({ "uris": chunk })))
                    .await?;
            if !st.is_success() {
                return Err(format!(
                    "Push failed at batch {} of {} (HTTP {st}): {} — Spotify currently has only the first {} track(s) of this push; your local edits are intact, push again to finish.",
                    i + 1,
                    chunks.len(),
                    body.trim(),
                    i * 100,
                ));
            }
        }
    }
    Ok(())
}

/// How to make the playlist match `target`: a wholesale replace, or a minimal remove/add.
enum ChangePlan {
    Replace,
    /// `removed` uris to delete, then `inserts` of (target position, run of new uris).
    Delta {
        removed: Vec<String>,
        inserts: Vec<(usize, Vec<String>)>,
    },
}

/// Pure decision: diff `current` (what's on Spotify now) against `target`. Prefer a minimal
/// edit, but fall back to `Replace` for the cases it can't safely express — a reorder of the
/// retained tracks, duplicate track ids (remove-by-uri would hit every copy), or a near-total
/// rewrite where per-track inserts would cost more calls than just replacing.
fn plan_changes(current: &[TrackEntry], target: &[TrackEntry]) -> ChangePlan {
    use std::collections::HashSet;
    let has_dups = |ts: &[TrackEntry]| {
        let mut seen = HashSet::new();
        !ts.iter().all(|t| seen.insert(t.id.as_str()))
    };
    let current_ids: HashSet<&str> = current.iter().map(|t| t.id.as_str()).collect();
    let target_ids: HashSet<&str> = target.iter().map(|t| t.id.as_str()).collect();

    // The tracks common to both must keep the same relative order; otherwise a reorder is
    // needed and only a wholesale replace expresses that.
    let cur_common: Vec<&str> = current
        .iter()
        .map(|t| t.id.as_str())
        .filter(|id| target_ids.contains(id))
        .collect();
    let tgt_common: Vec<&str> = target
        .iter()
        .map(|t| t.id.as_str())
        .filter(|id| current_ids.contains(id))
        .collect();
    if cur_common != tgt_common || has_dups(current) || has_dups(target) {
        return ChangePlan::Replace;
    }

    let removed: Vec<String> = current
        .iter()
        .filter(|t| !target_ids.contains(t.id.as_str()))
        .map(|t| t.id.clone())
        .collect();

    // Runs of consecutive new tracks, each inserted at its target index. Removals happen
    // first, so by the time we insert at index `pos` (ascending), positions 0..pos already
    // match `target`. A run goes in one POST (Spotify keeps the given order).
    let mut inserts: Vec<(usize, Vec<String>)> = Vec::new();
    let mut i = 0;
    while i < target.len() {
        if current_ids.contains(target[i].id.as_str()) {
            i += 1;
            continue;
        }
        let pos = i;
        let mut uris = Vec::new();
        while i < target.len() && !current_ids.contains(target[i].id.as_str()) {
            uris.push(target[i].id.clone());
            i += 1;
        }
        inserts.push((pos, uris));
    }

    // Delta only pays off when tracks are actually retained (that's whose added_at it
    // preserves) and it isn't more calls than a replace (e.g. most of the list was rewritten).
    let delta_calls = removed.len().div_ceil(100)
        + inserts.iter().map(|(_, u)| u.len().div_ceil(100)).sum::<usize>();
    let replace_calls = target.len().div_ceil(100).max(1);
    if tgt_common.is_empty() || delta_calls > replace_calls + 1 {
        return ChangePlan::Replace;
    }

    ChangePlan::Delta { removed, inserts }
}

/// Apply `target` to the playlist using the minimal edit from `plan_changes` when possible
/// (far fewer API calls for a small edit on a big playlist, and Spotify keeps `added_at` on
/// the tracks left in place), else a full replace.
async fn apply_changes(
    state: &AppState,
    client_id: &str,
    pid: &str,
    current: &[TrackEntry],
    target: &[TrackEntry],
) -> Result<(), String> {
    let (removed, inserts) = match plan_changes(current, target) {
        ChangePlan::Replace => return apply_replace(state, client_id, pid, target).await,
        ChangePlan::Delta { removed, inserts } => (removed, inserts),
    };

    // Remove first so the insert positions line up with the post-removal list.
    for chunk in removed.chunks(100) {
        let items: Vec<serde_json::Value> =
            chunk.iter().map(|u| serde_json::json!({ "uri": u })).collect();
        let (st, b) = send_capture(
            state,
            client_id,
            state
                .http
                .delete(format!("{API}/playlists/{pid}/items"))
                .json(&serde_json::json!({ "items": items })),
        )
        .await?;
        if !st.is_success() {
            return Err(format!(
                "Remove failed (HTTP {st}): {} — your local edits are intact, push again to retry.",
                b.trim()
            ));
        }
    }
    for (pos, uris) in &inserts {
        for (c, chunk) in uris.chunks(100).enumerate() {
            let (st, b) = send_capture(
                state,
                client_id,
                state
                    .http
                    .post(format!("{API}/playlists/{pid}/items"))
                    .json(&serde_json::json!({ "uris": chunk, "position": pos + c * 100 })),
            )
            .await?;
            if !st.is_success() {
                return Err(format!(
                    "Add failed (HTTP {st}): {} — some of your edits may have applied; push again to finish.",
                    b.trim()
                ));
            }
        }
    }
    Ok(())
}

/// Compare the local baseline (last-synced JSON) with Spotify's current state.
pub async fn sync_status(
    state: &AppState,
    client_id: String,
    data_dir: PathBuf,
    file: String,
) -> Result<SyncStatus, String> {
    let baseline = read_local(data_dir.clone(), file.clone())?;

    // A locally-created playlist isn't on Spotify yet — nothing to compare against.
    if baseline.spotify_id.is_empty() {
        return Ok(SyncStatus {
            remote_changed: false,
            baseline_snapshot: String::new(),
            remote_snapshot: String::new(),
            remote_added: Vec::new(),
            remote_removed: Vec::new(),
        });
    }

    // Cheap check first: if the remote snapshot matches our baseline, the playlist hasn't
    // changed — skip downloading all of its tracks (this runs on every editor open).
    let remote_snapshot = fetch_snapshot_id(state, &client_id, &baseline.spotify_id).await?;
    if remote_snapshot == baseline.snapshot_id {
        return Ok(SyncStatus {
            remote_changed: false,
            baseline_snapshot: baseline.snapshot_id.clone(),
            remote_snapshot,
            remote_added: Vec::new(),
            remote_removed: Vec::new(),
        });
    }

    // Snapshot differs — now it's worth the full fetch to compute the exact diff.
    let remote = fetch_one(state, &client_id, &baseline.spotify_id).await?;
    let status = build_sync_status(&baseline, &remote);

    // Spotify can bump snapshot_id without any content change. When the tracks still match,
    // adopt the new snapshot_id so the next cheap check passes — otherwise every editor open
    // would re-download the whole playlist for nothing. This writes only the gitignored
    // sidecar, so the committed playlist file is left untouched.
    if !status.remote_changed && remote.snapshot_id != baseline.snapshot_id {
        let _ = upsert_sync_meta(
            &data_dir,
            &baseline.spotify_id,
            SyncMeta {
                snapshot_id: remote.snapshot_id.clone(),
                last_synced: baseline.last_synced.clone(),
                cover_url: baseline.cover_url.clone(),
            },
        );
    }

    Ok(status)
}

/// Push edited tracks to Spotify, reconciling with remote changes per `strategy`.
// The parameter list mirrors the IPC payload one-to-one; bundling it into a struct would
// just move the field list without removing it.
#[allow(clippy::too_many_arguments)]
pub async fn push_playlist(
    state: &AppState,
    client_id: String,
    data_dir: PathBuf,
    staging_dir: PathBuf,
    file: String,
    name: String,
    description: String,
    tracks: Vec<TrackEntry>,
    strategy: PushStrategy,
) -> Result<PushResult, String> {
    let baseline = read_local(data_dir.clone(), file.clone())?;
    let pid = baseline.spotify_id.clone();

    // First push of a locally-created playlist: create it on Spotify, then add the tracks.
    // Creation goes through POST /me/playlists; the older POST /users/{id}/playlists is
    // deprecated and answers 403 Forbidden.
    if pid.is_empty() {
        let (st, body) = send_capture(
            state,
            &client_id,
            state
                .http
                .post(format!("{API}/me/playlists"))
                .json(&serde_json::json!({
                    "name": name,
                    "description": description,
                    "public": false,
                })),
        )
        .await?;
        if !st.is_success() {
            return Err(format!("Create on Spotify failed (HTTP {st}): {}", body.trim()));
        }
        let created: PlaylistMeta = serde_json::from_str(&body).map_err(err)?;
        let new_pid = created.id;
        if !tracks.is_empty() {
            apply_replace(state, &client_id, &new_pid, &tracks).await?;
        }
        let updated = fetch_one(state, &client_id, &new_pid).await?;
        write_playlist(&data_dir, &file, &updated)?;
        clear_staged(staging_dir, file)?;
        return Ok(PushResult {
            status: "applied".into(),
            playlist: Some(updated),
            conflict: None,
            warning: None,
        });
    }

    // Cheap divergence gate: if Spotify's snapshot_id still matches our baseline, the remote
    // hasn't changed since our last sync, so there's nothing to conflict with and no
    // remote-added tracks to merge — skip the full track download entirely (same trick
    // `sync_status` uses). Only pull the whole playlist when the snapshot actually moved.
    let remote_snapshot = fetch_snapshot_id(state, &client_id, &pid).await?;
    let (target, current, remote_name, remote_description) = if remote_snapshot == baseline.snapshot_id {
        // No divergence: every strategy reduces to the user's edits (no remote additions),
        // and the remote currently equals our baseline — so use baseline tracks as `current`
        // for the delta below without a second download.
        (tracks, baseline.tracks.clone(), baseline.name.clone(), baseline.description.clone())
    } else {
        let remote = fetch_one(state, &client_id, &pid).await?;
        let status = build_sync_status(&baseline, &remote);
        // Treat the playlist as diverged if the snapshot changed OR the track membership
        // differs from our baseline (defensive: don't rely on snapshot_id alone).
        let diverged = status.remote_changed
            || !status.remote_added.is_empty()
            || !status.remote_removed.is_empty();

        let target: Vec<TrackEntry> = match strategy {
            PushStrategy::Safe => {
                if diverged {
                    return Ok(PushResult {
                        status: "conflict".into(),
                        playlist: None,
                        conflict: Some(status),
                        warning: None,
                    });
                }
                tracks
            }
            PushStrategy::Merge => {
                // Keep the user's edits, and append any tracks added on Spotify since the
                // baseline that the user hasn't already included (don't re-add their removals).
                let base_ids: std::collections::HashSet<String> =
                    baseline.tracks.iter().map(|t| t.id.clone()).collect();
                let local_ids: std::collections::HashSet<String> =
                    tracks.iter().map(|t| t.id.clone()).collect();
                let mut merged = tracks;
                for rt in &remote.tracks {
                    if !base_ids.contains(&rt.id) && !local_ids.contains(&rt.id) {
                        merged.push(rt.clone());
                    }
                }
                merged
            }
            PushStrategy::Overwrite => tracks,
        };
        (target, remote.tracks, remote.name, remote.description)
    };

    // Diff against what's on Spotify now: remove/add only what changed (preserving added_at
    // on untouched tracks), falling back to a full replace for reorders/dups/rewrites.
    apply_changes(state, &client_id, &pid, &current, &target).await?;

    // Push title/description changes (last-write-wins; metadata isn't part of the
    // track-level conflict check). Only call Spotify when something actually differs.
    if name != remote_name || description != remote_description {
        update_details(state, &client_id, &pid, &name, &description).await?;
    }

    let updated = fetch_one(state, &client_id, &pid).await?;
    // Spotify's change-details endpoint silently ignores a blank description (it returns 200 but
    // keeps the existing text — there's no way to clear a description to empty via the Web API).
    // Detect that so the "cleared" edit doesn't look like it mysteriously reverted, and tell the
    // user rather than pretending it applied.
    let warning = (description.trim().is_empty() && !updated.description.trim().is_empty()).then(
        || {
            "Spotify doesn't allow clearing a description to blank via its API, so the previous \
             one was kept."
                .to_string()
        },
    );
    write_playlist(&data_dir, &file, &updated)?;
    clear_staged(staging_dir, file)?;
    Ok(PushResult {
        status: "applied".into(),
        playlist: Some(updated),
        conflict: None,
        warning,
    })
}

/// Change a playlist's name and/or description on Spotify (PUT /playlists/{id}).
async fn update_details(
    state: &AppState,
    client_id: &str,
    pid: &str,
    name: &str,
    description: &str,
) -> Result<(), String> {
    let (st, b) = send_capture(
        state,
        client_id,
        state
            .http
            .put(format!("{API}/playlists/{pid}"))
            .json(&serde_json::json!({ "name": name, "description": description })),
    )
    .await?;
    if !st.is_success() {
        return Err(format!("Update name/description failed (HTTP {st}): {}", b.trim()));
    }
    Ok(())
}

/// Re-pull a single playlist from Spotify, overwriting the local file. Kept for an
/// explicit "re-sync from Spotify" action.
pub async fn refresh_playlist(
    state: &AppState,
    client_id: String,
    data_dir: PathBuf,
    file: String,
) -> Result<PlaylistFile, String> {
    let pf = read_local(data_dir.clone(), file.clone())?;
    let updated = fetch_one(state, &client_id, &pf.spotify_id).await?;
    write_playlist(&data_dir, &file, &updated)?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str) -> TrackEntry {
        TrackEntry {
            id: id.into(),
            isrc: None,
            title: id.into(),
            artists: vec![],
            added_at: None,
            added_by: None,
            duration_ms: None,
            is_playable: None,
        }
    }

    fn tracks(ids: &[&str]) -> Vec<TrackEntry> {
        ids.iter().map(|id| t(id)).collect()
    }

    fn temp_data_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("setlist-meta-{tag}-{nanos}"));
        std::fs::create_dir_all(p.join("playlists")).unwrap();
        p
    }

    #[test]
    fn sidecar_keeps_volatile_fields_out_of_committed_json() {
        let dir = temp_data_dir("split");
        let model = PlaylistFile {
            spotify_id: "pid1".into(),
            name: "Road Trip".into(),
            description: "d".into(),
            snapshot_id: "snap1".into(),
            last_synced: "2026-01-01T00:00:00Z".into(),
            cover_url: Some("https://img/cover.jpg".into()),
            tracks: tracks(&["a", "b"]),
        };
        write_playlist(&dir, "road.json", &model).unwrap();

        // The committed JSON is content-only: no volatile fields, none of their values.
        let raw = std::fs::read_to_string(dir.join("playlists").join("road.json")).unwrap();
        assert!(raw.contains("\"name\"") && raw.contains("pid1"));
        for needle in ["snapshot_id", "last_synced", "cover_url", "snap1", "cover.jpg"] {
            assert!(!raw.contains(needle), "committed JSON leaked {needle}: {raw}");
        }

        // The volatile fields live in the gitignored sidecar instead.
        let sidecar = std::fs::read_to_string(dir.join("cache").join("sync-meta.json")).unwrap();
        assert!(sidecar.contains("snap1") && sidecar.contains("cover.jpg"));

        // read_local hydrates them straight back from the sidecar.
        let pf = read_local(dir.clone(), "road.json".into()).unwrap();
        assert_eq!(pf.snapshot_id, "snap1");
        assert_eq!(pf.last_synced, "2026-01-01T00:00:00Z");
        assert_eq!(pf.cover_url.as_deref(), Some("https://img/cover.jpg"));

        // A snapshot bump rewrites only the sidecar; the committed JSON is untouched, so it
        // produces no git change.
        let before = std::fs::metadata(dir.join("playlists").join("road.json")).unwrap().len();
        upsert_sync_meta(
            &dir,
            "pid1",
            SyncMeta { snapshot_id: "snap2".into(), ..sync_meta_of(&pf) },
        )
        .unwrap();
        let after = read_local(dir.clone(), "road.json".into()).unwrap();
        assert_eq!(after.snapshot_id, "snap2");
        let raw2 = std::fs::read_to_string(dir.join("playlists").join("road.json")).unwrap();
        assert_eq!(raw, raw2, "committed JSON must not change on a snapshot bump");
        assert_eq!(before, raw2.len() as u64);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_only_is_a_delta() {
        let plan = plan_changes(&tracks(&["a", "b", "c"]), &tracks(&["a", "c"]));
        match plan {
            ChangePlan::Delta { removed, inserts } => {
                assert_eq!(removed, vec!["b"]);
                assert!(inserts.is_empty());
            }
            _ => panic!("expected delta"),
        }
    }

    #[test]
    fn interspersed_adds_get_correct_positions() {
        // current [a,b,c] -> target [a,X,b,Y,Z,c]: insert X at 1, run [Y,Z] at 3.
        let plan = plan_changes(&tracks(&["a", "b", "c"]), &tracks(&["a", "X", "b", "Y", "Z", "c"]));
        match plan {
            ChangePlan::Delta { removed, inserts } => {
                assert!(removed.is_empty());
                assert_eq!(inserts, vec![(1, vec!["X".into()]), (3, vec!["Y".into(), "Z".into()])]);
            }
            _ => panic!("expected delta"),
        }
    }

    #[test]
    fn add_and_remove_together() {
        let plan = plan_changes(&tracks(&["a", "b", "c"]), &tracks(&["a", "c", "d"]));
        match plan {
            ChangePlan::Delta { removed, inserts } => {
                assert_eq!(removed, vec!["b"]);
                assert_eq!(inserts, vec![(2, vec!["d".into()])]);
            }
            _ => panic!("expected delta"),
        }
    }

    #[test]
    fn reorder_falls_back_to_replace() {
        // Same membership, swapped order of retained tracks.
        let plan = plan_changes(&tracks(&["a", "b", "c"]), &tracks(&["c", "b", "a"]));
        assert!(matches!(plan, ChangePlan::Replace));
    }

    #[test]
    fn duplicate_ids_fall_back_to_replace() {
        let plan = plan_changes(&tracks(&["a", "a", "b"]), &tracks(&["a", "b"]));
        assert!(matches!(plan, ChangePlan::Replace));
    }

    #[test]
    fn near_total_rewrite_falls_back_to_replace() {
        // current [a..a149] (1 track) -> target of 150 fresh tracks: 150 inserts vs 2 replace
        // calls -> replace wins.
        let current = tracks(&["keep"]);
        let target_ids: Vec<String> = (0..150).map(|i| format!("n{i}")).collect();
        let target: Vec<TrackEntry> = target_ids.iter().map(|s| t(s)).collect();
        assert!(matches!(plan_changes(&current, &target), ChangePlan::Replace));
    }

    #[test]
    fn push_strategy_deserializes_from_ipc_strings() {
        // The frontend sends these exact strings; anything else must be rejected at the
        // IPC boundary rather than silently falling back to a destructive default.
        assert!(matches!(
            serde_json::from_str::<PushStrategy>("\"safe\"").unwrap(),
            PushStrategy::Safe
        ));
        assert!(matches!(
            serde_json::from_str::<PushStrategy>("\"merge\"").unwrap(),
            PushStrategy::Merge
        ));
        assert!(matches!(
            serde_json::from_str::<PushStrategy>("\"overwrite\"").unwrap(),
            PushStrategy::Overwrite
        ));
        assert!(serde_json::from_str::<PushStrategy>("\"yolo\"").is_err());
    }
}
