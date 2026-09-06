//! On-disk persistence and the local playlist model: the committed playlist JSON (the app's
//! source of truth), the gitignored sync-metadata sidecar, atomic writes, the mtime-validated
//! read cache, staging of un-pushed edits, and the archive/pin/local-search helpers. Pure
//! filesystem + serde — no network and no `AppState`; the only tie to the client core is the
//! shared `err` stringifier.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::err;

#[derive(Serialize, Deserialize)]
pub struct PlaylistFile {
    pub spotify_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    // snapshot_id/last_synced/cover_url are volatile sync bookkeeping, not playlist content:
    // Spotify bumps snapshot_id (and regenerates cover mosaics) with no real change, so keeping
    // them in the committed file would churn it on every sync. They live in a gitignored sidecar
    // (see `SyncMeta`) and are skipped on serialization, so the committed JSON is content-only.
    // `default` keeps files that do carry these fields inline parseable; they're hydrated back
    // from the sidecar on read either way.
    #[serde(default, skip_serializing)]
    pub snapshot_id: String,
    #[serde(default, skip_serializing)]
    pub last_synced: String,
    #[serde(default, skip_serializing)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub tracks: Vec<TrackEntry>,
}

/// Volatile per-playlist sync bookkeeping, kept out of the committed playlist JSON and stored
/// in `cache/sync-meta.json` (gitignored) keyed by Spotify id. Rebuildable from Spotify, so a
/// fresh clone simply re-populates it on the next pull — losing it costs only a cold first sync
/// (and cover art until then), never real data.
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct SyncMeta {
    #[serde(default)]
    pub snapshot_id: String,
    #[serde(default)]
    pub last_synced: String,
    #[serde(default)]
    pub cover_url: Option<String>,
}

pub(crate) type SyncMetaStore = std::collections::HashMap<String, SyncMeta>;

pub(crate) fn sync_meta_of(pf: &PlaylistFile) -> SyncMeta {
    SyncMeta {
        snapshot_id: pf.snapshot_id.clone(),
        last_synced: pf.last_synced.clone(),
        cover_url: pf.cover_url.clone(),
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TrackEntry {
    pub id: String,
    #[serde(default)]
    pub isrc: Option<String>,
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default)]
    pub added_at: Option<String>,
    #[serde(default)]
    pub added_by: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    // `false` when Spotify can't play the track for this user (greyed out — unavailable in
    // the market, removed, etc.). `None` for older cached playlists pulled before this field
    // existed; treated as playable until the next pull/refresh repopulates it.
    #[serde(default)]
    pub is_playable: Option<bool>,
}

/// Write a data file atomically (temp file + rename). A crash or power loss mid-write must
/// never leave a truncated JSON behind: the loaders skip unparseable files, so a corrupt
/// playlist would silently vanish from the library along with its contents.
pub(crate) fn write_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(".tmp");
    let tmp = PathBuf::from(tmp_name);
    std::fs::write(&tmp, contents).map_err(err)?;
    // On Windows, std::fs::rename replaces an existing destination file.
    std::fs::rename(&tmp, path).map_err(err)
}

// --- Sync-metadata sidecar (cache/sync-meta.json) ---------------------------

fn sync_meta_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cache").join("sync-meta.json")
}

/// Load the whole sidecar (Spotify id → sync metadata). Missing/corrupt → empty map, which is
/// safe: callers treat absent entries as "unknown", at worst forcing a cold re-fetch.
pub(crate) fn load_sync_meta(data_dir: &Path) -> SyncMetaStore {
    std::fs::read_to_string(sync_meta_path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn save_sync_meta(data_dir: &Path, store: &SyncMetaStore) -> Result<(), String> {
    let path = sync_meta_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    write_atomic(&path, &serde_json::to_string_pretty(store).map_err(err)?)
}

/// Upsert one playlist's sync metadata. No-op for locally-created playlists (empty Spotify id)
/// — they have nothing to key on and no meaningful snapshot/cover until first push.
pub(crate) fn upsert_sync_meta(data_dir: &Path, spotify_id: &str, meta: SyncMeta) -> Result<(), String> {
    if spotify_id.is_empty() {
        return Ok(());
    }
    let mut store = load_sync_meta(data_dir);
    store.insert(spotify_id.to_string(), meta);
    save_sync_meta(data_dir, &store)
}

/// Fill a freshly-parsed playlist's volatile fields from the sidecar (no-op if it has no
/// entry yet — e.g. a fresh clone, where the in-file values, if any, are left as-is).
fn hydrate_sync_meta(data_dir: &Path, pf: &mut PlaylistFile) {
    if pf.spotify_id.is_empty() {
        return;
    }
    if let Some(m) = load_sync_meta(data_dir).get(&pf.spotify_id) {
        pf.snapshot_id = m.snapshot_id.clone();
        pf.last_synced = m.last_synced.clone();
        pf.cover_url = m.cover_url.clone();
    }
}

/// Persist a playlist: the content-only committed JSON plus its volatile sync metadata in the
/// sidecar. Single-write callers use this; the bulk pull batches the sidecar itself.
pub(crate) fn write_playlist(data_dir: &Path, file: &str, model: &PlaylistFile) -> Result<(), String> {
    write_atomic(
        &playlist_path(data_dir, file)?,
        &serde_json::to_string_pretty(model).map_err(err)?,
    )?;
    upsert_sync_meta(data_dir, &model.spotify_id, sync_meta_of(model))
}

/// Read + parse a playlist JSON through an (mtime, size)-validated in-memory cache.
/// The library-wide features (sidebar list, song search, cleanup scan, replacement
/// lookup) walk every playlist per call; without this each call re-reads and re-parses
/// the whole library from disk. Writers go through `write_atomic` (rename bumps the
/// mtime), so entries self-invalidate. Returns None for unreadable or non-playlist JSON.
pub(crate) fn read_playlist_cached(path: &std::path::Path) -> Option<std::sync::Arc<PlaylistFile>> {
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::SystemTime;
    type Cache =
        Mutex<std::collections::HashMap<PathBuf, (SystemTime, u64, Arc<PlaylistFile>)>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);

    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    let len = meta.len();
    if let Some((m, l, pf)) = cache.lock().unwrap().get(path) {
        if *m == mtime && *l == len {
            return Some(pf.clone());
        }
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let pf = Arc::new(serde_json::from_str::<PlaylistFile>(&raw).ok()?);
    {
        let mut map = cache.lock().unwrap();
        // Entries self-invalidate on (mtime, size) change, but deleted/renamed playlists would
        // otherwise linger forever (each pinning a full track list via its Arc). Bound the map:
        // once it grows past a generous cap, drop entries whose file no longer exists, and if
        // it's still over, clear it wholesale. The cap is far above any realistic library, so
        // this is a safety valve, not something a normal session ever hits.
        const CAP: usize = 4096;
        if map.len() >= CAP {
            map.retain(|p, _| p.exists());
            if map.len() >= CAP {
                map.clear();
            }
        }
        map.insert(path.to_path_buf(), (mtime, len, pf.clone()));
    }
    Some(pf)
}

/// Set of existing `*.json` filenames in the playlists dir (for unique-name seeding).
pub(crate) fn existing_filenames(dir: &std::path::Path) -> Result<std::collections::HashSet<String>, String> {
    let mut set = std::collections::HashSet::new();
    if dir.exists() {
        for entry in std::fs::read_dir(dir).map_err(err)? {
            let path = entry.map_err(err)?.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(name) = path.file_name() {
                    set.insert(name.to_string_lossy().to_string());
                }
            }
        }
    }
    Ok(set)
}

/// Find the existing local filename whose playlist has the given Spotify id, if any.
pub(crate) fn existing_file_for(
    dir: &std::path::Path,
    spotify_id: &str,
) -> Result<Option<String>, String> {
    if !dir.exists() {
        return Ok(None);
    }
    for entry in std::fs::read_dir(dir).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(pf) = read_playlist_cached(&path) {
            if pf.spotify_id == spotify_id {
                return Ok(path.file_name().map(|n| n.to_string_lossy().to_string()));
            }
        }
    }
    Ok(None)
}

pub(crate) fn unique_filename(name: &str, used: &mut std::collections::HashSet<String>) -> String {
    let base = slugify(name);
    let mut candidate = format!("{base}.json");
    let mut n = 2;
    while used.contains(&candidate) {
        candidate = format!("{base}-{n}.json");
        n += 1;
    }
    used.insert(candidate.clone());
    candidate
}

fn slugify(name: &str) -> String {
    let lowered: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let joined = lowered
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if joined.is_empty() {
        "playlist".to_string()
    } else {
        joined
    }
}

#[derive(Serialize)]
pub struct LocalPlaylist {
    pub file: String,
    pub name: String,
    pub spotify_id: String,
    pub track_count: usize,
    pub snapshot_id: String,
    /// True if there are staged (saved-but-unpushed) edits for this playlist.
    pub modified: bool,
    /// True if the user archived this playlist in Setlist.
    pub archived: bool,
    /// True if the user pinned this playlist (sorted to the top of the list).
    pub pinned: bool,
}

#[derive(Serialize)]
pub struct LocalTrackHit {
    pub file: String,
    pub playlist: String,
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
}

/// Reject anything that isn't a plain file name (guards against path traversal).
/// Must parse as exactly one normal path component; a `:` is additionally banned because
/// on Windows a drive-relative name ("C:foo.json") makes `PathBuf::join` discard the base
/// directory entirely, and "name.json:stream" would address an NTFS alternate data stream.
fn safe_name(file: &str) -> Result<String, String> {
    use std::path::Component;
    let mut components = std::path::Path::new(file).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) if !file.contains(':') => Ok(file.to_string()),
        _ => Err(format!("Invalid playlist file name: {file}")),
    }
}

pub(crate) fn playlist_path(data_dir: &Path, file: &str) -> Result<PathBuf, String> {
    Ok(data_dir.join("playlists").join(safe_name(file)?))
}

fn staged_path(staging_dir: &Path, file: &str) -> Result<PathBuf, String> {
    Ok(staging_dir.join(safe_name(file)?))
}

pub fn list_local(data_dir: PathBuf, staging_dir: PathBuf) -> Result<Vec<LocalPlaylist>, String> {
    let dir = data_dir.join("playlists");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let archived = load_archived(&data_dir);
    let pinned = load_pinned(&data_dir);
    // snapshot_id lives in the sidecar, not in the cached parse; load that store once here.
    let meta_store = load_sync_meta(&data_dir);
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(pf) = read_playlist_cached(&path) else {
            continue; // unreadable or non-playlist json
        };
        let file = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        // The sidebar has to show the staged edit rather than the last-synced file. A rename
        // or an added track lives only in staging until Push, so reading name and count off
        // the canonical JSON showed the pre-edit values next to a "modified" dot — which
        // reads as the edit having silently failed. A staged file that won't parse still
        // counts as modified; only the display falls back to the canonical values.
        let staged_file = staged_path(&staging_dir, &file).ok().filter(|p| p.exists());
        let modified = staged_file.is_some();
        let staged = staged_file
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|raw| parse_staged(&raw).ok());
        let is_archived = archived.contains(&file);
        let is_pinned = pinned.contains(&file);
        out.push(LocalPlaylist {
            file,
            name: staged
                .as_ref()
                .and_then(|s| s.name.clone())
                .unwrap_or_else(|| pf.name.clone()),
            spotify_id: pf.spotify_id.clone(),
            track_count: staged.as_ref().map_or(pf.tracks.len(), |s| s.tracks.len()),
            snapshot_id: meta_store
                .get(&pf.spotify_id)
                .map(|m| m.snapshot_id.clone())
                .unwrap_or_default(),
            modified,
            archived: is_archived,
            pinned: is_pinned,
        });
    }
    // Pinned first, then alphabetical within each group.
    out.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[derive(Serialize)]
pub struct NamedPlaylist {
    pub file: String,
    pub name: String,
    pub tracks: Vec<TrackEntry>,
}

/// Every (non-archived) local playlist with its *effective* track list — staged edits if
/// present, else the canonical mirror. Powers the cleanup/lint scan, which should reflect
/// what you'd push, not just what's on Spotify.
pub fn read_all_local(
    data_dir: PathBuf,
    staging_dir: PathBuf,
) -> Result<Vec<NamedPlaylist>, String> {
    let dir = data_dir.join("playlists");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let archived = load_archived(&data_dir);
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(pf) = read_playlist_cached(&path) else {
            continue; // unreadable or non-playlist json
        };
        let file = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if archived.contains(&file) {
            continue; // archived playlists are out of the active set to keep clean
        }
        let (name, tracks) = match get_staged(staging_dir.clone(), file.clone())? {
            Some(s) => (s.name.unwrap_or_else(|| pf.name.clone()), s.tracks),
            None => (pf.name.clone(), pf.tracks.clone()),
        };
        out.push(NamedPlaylist { file, name, tracks });
    }
    out.sort_by_key(|p| p.name.to_lowercase());
    Ok(out)
}

/// Bare track id: the last uri segment, or the whole uri for `spotify:local:` files
/// (their last segment is the duration, which collides across unrelated songs).
/// Mirrors the frontend's bareId and metrics::bare_id semantics.
fn bare_track_id(uri: &str) -> &str {
    if uri.starts_with("spotify:local:") {
        uri
    } else {
        uri.rsplit(':').next().unwrap_or(uri)
    }
}

/// Files of every (non-archived) local playlist whose effective tracks contain any of the
/// given track uris/ids (bare-id match, so the uri form doesn't matter). Powers the
/// sidebar's "this song is also in…" marks. Cheap after the first call: playlist parsing
/// goes through the mtime-validated read cache.
pub fn playlists_containing(
    data_dir: PathBuf,
    staging_dir: PathBuf,
    track_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    let wanted: Vec<String> = track_ids
        .iter()
        .map(|u| bare_track_id(u).to_string())
        .collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    Ok(read_all_local(data_dir, staging_dir)?
        .into_iter()
        .filter(|p| {
            p.tracks
                .iter()
                .any(|t| wanted.iter().any(|w| w == bare_track_id(&t.id)))
        })
        .map(|p| p.file)
        .collect())
}

pub fn read_local(data_dir: PathBuf, file: String) -> Result<PlaylistFile, String> {
    let raw = std::fs::read_to_string(playlist_path(&data_dir, &file)?).map_err(err)?;
    let mut pf: PlaylistFile = serde_json::from_str(&raw).map_err(err)?;
    hydrate_sync_meta(&data_dir, &mut pf);
    Ok(pf)
}

/// A staged (saved-but-unpushed) edit: the edited track list plus optional name/description
/// overrides. `name`/`description` are `None` when the title/blurb weren't changed, in which
/// case the canonical values stand.
#[derive(Serialize, Deserialize, Clone)]
pub struct StagedEdit {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub tracks: Vec<TrackEntry>,
}

/// Cache an edited track list (and optional name/description overrides) as a staged change
/// — does not touch the canonical JSON or Spotify.
pub fn stage_local(
    staging_dir: PathBuf,
    file: String,
    name: Option<String>,
    description: Option<String>,
    tracks: Vec<TrackEntry>,
) -> Result<(), String> {
    std::fs::create_dir_all(&staging_dir).map_err(err)?;
    let path = staged_path(&staging_dir, &file)?;
    let edit = StagedEdit { name, description, tracks };
    write_atomic(&path, &serde_json::to_string_pretty(&edit).map_err(err)?)
}

/// Two on-disk shapes are accepted: a full `StagedEdit` object, and a bare track array
/// (tracks only, no name/description overrides).
fn parse_staged(raw: &str) -> Result<StagedEdit, serde_json::Error> {
    serde_json::from_str::<StagedEdit>(raw).or_else(|_| {
        serde_json::from_str::<Vec<TrackEntry>>(raw).map(|tracks| StagedEdit {
            name: None,
            description: None,
            tracks,
        })
    })
}

/// Return staged edits for a playlist, if any.
pub fn get_staged(staging_dir: PathBuf, file: String) -> Result<Option<StagedEdit>, String> {
    let path = staged_path(&staging_dir, &file)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(err)?;
    Ok(Some(parse_staged(&raw).map_err(err)?))
}

/// Drop any staged edits for a playlist.
pub fn clear_staged(staging_dir: PathBuf, file: String) -> Result<(), String> {
    let path = staged_path(&staging_dir, &file)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(err)?;
    }
    Ok(())
}

// --- Archive (local curation; the Spotify-side unfollow is a separate action) ---

/// Per-playlist mood goals, keyed by playlist file name.
///
/// Committed, like `archived.json` and `pinned.json`: a goal is curation intent you set
/// deliberately and the app acts on, so it belongs beside the playlists it describes rather
/// than inside a browser profile the uninstaller offers to wipe.
///
/// The shape is owned by the frontend, which defines the dimensions and clamps them on read,
/// so this stores it opaquely rather than restating the model in two languages.
pub fn load_goals(data_dir: &Path) -> serde_json::Value {
    read_json_object(&data_dir.join("goals.json"))
}

pub fn save_goals(data_dir: &Path, goals: &serde_json::Value) -> Result<(), String> {
    write_atomic(
        &data_dir.join("goals.json"),
        &serde_json::to_string_pretty(goals).map_err(err)?,
    )
}

/// View state: shown columns, outlier method, the frozen similarity projection, the hub repo
/// slug. In the data folder so it follows the library rather than the machine, but under
/// gitignored `cache/` -- none of it is curation, and it churns every time a column is toggled.
pub fn load_ui_state(data_dir: &Path) -> serde_json::Value {
    read_json_object(&data_dir.join("cache").join("ui-state.json"))
}

pub fn save_ui_state(data_dir: &Path, state: &serde_json::Value) -> Result<(), String> {
    let dir = data_dir.join("cache");
    std::fs::create_dir_all(&dir).map_err(err)?;
    write_atomic(
        &dir.join("ui-state.json"),
        &serde_json::to_string_pretty(state).map_err(err)?,
    )
}

/// A missing, unreadable or non-object file reads as `{}` -- these stores are conveniences,
/// and none of them is worth failing an app launch over.
fn read_json_object(path: &Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

pub fn load_archived(data_dir: &Path) -> std::collections::HashSet<String> {
    std::fs::read_to_string(data_dir.join("archived.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

fn save_archived(
    data_dir: &Path,
    set: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let mut v: Vec<&String> = set.iter().collect();
    v.sort();
    write_atomic(
        &data_dir.join("archived.json"),
        &serde_json::to_string_pretty(&v).map_err(err)?,
    )
}

pub fn set_archived(data_dir: PathBuf, file: String, archived: bool) -> Result<(), String> {
    let name = safe_name(&file)?;
    let mut set = load_archived(&data_dir);
    if archived {
        set.insert(name);
    } else {
        set.remove(&name);
    }
    save_archived(&data_dir, &set)
}

// --- Pin (local curation; sorts pinned playlists to the top of the list) ---

pub fn load_pinned(data_dir: &Path) -> std::collections::HashSet<String> {
    std::fs::read_to_string(data_dir.join("pinned.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

fn save_pinned(
    data_dir: &Path,
    set: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let mut v: Vec<&String> = set.iter().collect();
    v.sort();
    write_atomic(
        &data_dir.join("pinned.json"),
        &serde_json::to_string_pretty(&v).map_err(err)?,
    )
}

pub fn set_pinned(data_dir: PathBuf, file: String, pinned: bool) -> Result<(), String> {
    let name = safe_name(&file)?;
    let mut set = load_pinned(&data_dir);
    if pinned {
        set.insert(name);
    } else {
        set.remove(&name);
    }
    save_pinned(&data_dir, &set)
}

/// Create a new empty playlist **locally only** — no Spotify call, so it works offline or
/// while rate-limited. It has an empty `spotify_id` to mark it as "not on Spotify yet";
/// the first push creates it on Spotify and fills in the real id.
pub fn create_local(
    data_dir: PathBuf,
    name: String,
    description: String,
) -> Result<LocalPlaylist, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Playlist name can't be empty.".into());
    }

    let playlists_dir = data_dir.join("playlists");
    std::fs::create_dir_all(&playlists_dir).map_err(err)?;
    let mut used = existing_filenames(&playlists_dir)?;
    let filename = unique_filename(&name, &mut used);

    let model = PlaylistFile {
        spotify_id: String::new(), // not on Spotify yet
        name: name.clone(),
        description: description.trim().to_string(),
        snapshot_id: String::new(),
        last_synced: chrono::Utc::now().to_rfc3339(),
        cover_url: None,
        tracks: Vec::new(),
    };
    write_playlist(&data_dir, &filename, &model)?;

    Ok(LocalPlaylist {
        file: filename,
        name,
        spotify_id: String::new(),
        track_count: 0,
        snapshot_id: String::new(),
        modified: false,
        archived: false,
        pinned: false,
    })
}

/// Search across all locally-stored playlists for tracks matching a query
/// (title or artist). Lets you find which playlists already contain a song.
pub fn search_local(data_dir: PathBuf, query: String) -> Result<Vec<LocalTrackHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let dir = data_dir.join("playlists");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(pf) = read_playlist_cached(&path) else {
            continue; // unreadable or non-playlist json
        };
        let file = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        for t in &pf.tracks {
            let hay = format!("{} {}", t.title, t.artists.join(" ")).to_lowercase();
            if hay.contains(&q) {
                out.push(LocalTrackHit {
                    file: file.clone(),
                    playlist: pf.name.clone(),
                    id: t.id.clone(),
                    title: t.title.clone(),
                    artists: t.artists.clone(),
                });
            }
        }
    }
    out.truncate(200);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str) -> TrackEntry {
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

    fn temp_dirs(tag: &str) -> (PathBuf, PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("setlist-store-{tag}-{nanos}"));
        std::fs::create_dir_all(root.join("data").join("playlists")).unwrap();
        std::fs::create_dir_all(root.join("staged")).unwrap();
        (root.join("data"), root.join("staged"))
    }

    #[test]
    fn sidebar_shows_staged_name_and_count_not_the_synced_file() {
        let (data_dir, staging_dir) = temp_dirs("staged-overlay");
        write_playlist(
            &data_dir,
            "jog.json",
            &PlaylistFile {
                spotify_id: "pid1".into(),
                name: "Jogging Music".into(),
                description: String::new(),
                snapshot_id: String::new(),
                last_synced: String::new(),
                cover_url: None,
                tracks: vec![],
            },
        )
        .unwrap();

        // Before Save there is nothing staged: the canonical values stand.
        let listed = list_local(data_dir.clone(), staging_dir.clone()).unwrap();
        assert_eq!(listed[0].name, "Jogging Music");
        assert_eq!(listed[0].track_count, 0);
        assert!(!listed[0].modified);

        // Save stages a rename and two tracks without touching the canonical JSON.
        stage_local(
            staging_dir.clone(),
            "jog.json".into(),
            Some("Favourite Beats".into()),
            None,
            vec![track("a"), track("b")],
        )
        .unwrap();

        let listed = list_local(data_dir.clone(), staging_dir.clone()).unwrap();
        assert_eq!(listed[0].name, "Favourite Beats");
        assert_eq!(listed[0].track_count, 2);
        assert!(listed[0].modified);

        // The file itself is still the last-synced mirror, which is the whole point of staging.
        let raw = std::fs::read_to_string(data_dir.join("playlists").join("jog.json")).unwrap();
        assert!(raw.contains("Jogging Music"));
    }

    #[test]
    fn staged_edit_without_a_rename_keeps_the_canonical_name() {
        let (data_dir, staging_dir) = temp_dirs("no-rename");
        write_playlist(
            &data_dir,
            "road.json",
            &PlaylistFile {
                spotify_id: "pid2".into(),
                name: "Road Trip".into(),
                description: String::new(),
                snapshot_id: String::new(),
                last_synced: String::new(),
                cover_url: None,
                tracks: vec![track("a")],
            },
        )
        .unwrap();
        stage_local(
            staging_dir.clone(),
            "road.json".into(),
            None, // tracks edited, title untouched
            None,
            vec![track("a"), track("b"), track("c")],
        )
        .unwrap();

        let listed = list_local(data_dir, staging_dir).unwrap();
        assert_eq!(listed[0].name, "Road Trip");
        assert_eq!(listed[0].track_count, 3);
    }

    #[test]
    fn an_unparseable_staged_file_still_marks_the_playlist_modified() {
        let (data_dir, staging_dir) = temp_dirs("corrupt");
        write_playlist(
            &data_dir,
            "mix.json",
            &PlaylistFile {
                spotify_id: "pid3".into(),
                name: "Mixtape".into(),
                description: String::new(),
                snapshot_id: String::new(),
                last_synced: String::new(),
                cover_url: None,
                tracks: vec![track("a")],
            },
        )
        .unwrap();
        std::fs::write(staging_dir.join("mix.json"), "{ not json").unwrap();

        let listed = list_local(data_dir, staging_dir).unwrap();
        assert!(listed[0].modified, "the dot must survive a staged file we can't read");
        assert_eq!(listed[0].name, "Mixtape");
        assert_eq!(listed[0].track_count, 1);
    }
}
