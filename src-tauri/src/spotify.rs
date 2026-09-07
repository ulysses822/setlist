//! Spotify client core: `AppState`, rate limiting, and the shared typed-fetch helpers that
//! every Spotify call goes through, plus the library-level operations built directly on them
//! (probe, search, replacement lookup, follow/unfollow/delete).
//!
//! The larger, more separable concerns live in sibling submodules and are re-exported so the
//! public surface stays `spotify::Name`:
//! - `auth`: OAuth (PKCE login, token refresh, keychain, loopback catcher)
//! - `sync`: pull/push/divergence detection against the local mirror
//! - `player`: Spotify Connect playback control
//! - `store`: on-disk persistence (committed JSON, sidecar, staging, archive/pin)

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

mod auth;
mod player;
mod store;
mod sync;
pub use auth::*;
pub use player::*;
pub use store::*;
pub use sync::*;

pub(crate) const API: &str = "https://api.spotify.com/v1";

/// Real Spotify ids are 22 characters. This cap leaves generous room for a format change and
/// only exists so a garbage id is rejected — and echoed back — at a sane size.
const MAX_ID_LEN: usize = 64;

/// `{API}/playlists/{id}`, but only once `id` is verifiably a Spotify id.
///
/// Playlist ids reach us from the JSON in the data folder — a git repo, which can be cloned
/// from anywhere — and are then interpolated into a request path sent with a full-scope
/// token. That makes them untrusted input in the one place a URL is most forgeable: the `url`
/// crate resolves dot segments before sending, so an id of `../me/player/pause` turns a PUT
/// on a playlist into a PUT on the player, and a `?` or `#` quietly rewrites whatever query
/// the caller appended. Spotify ids are base-62, so anything else is not an id at all —
/// reject it rather than percent-encode it, since an escaped slash only buys a puzzling 404.
pub(crate) fn playlist_url(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > MAX_ID_LEN || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(format!(
            "{:?} is not a Spotify playlist id — check its spotify_id in your data folder.",
            id.chars().take(MAX_ID_LEN).collect::<String>()
        ));
    }
    Ok(format!("{API}/playlists/{id}"))
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

// Spotify's Web API rate limit is a rolling ~30s window (undisclosed size). We pace our own
// requests to a steady rate to avoid bursting past it, and when a 429 does come back we honor
// its Retry-After and record a cooldown so the UI can block further calls (which would only
// extend the wait) and show a countdown.
const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(150);
const AUTO_RETRY_CAP_SECS: u64 = 8; // auto-wait+retry only for short cooldowns
                                    // When a 429 has no parseable Retry-After (the header may legally be an HTTP-date), assume
                                    // a cooldown *above* the auto-retry cap: retrying while genuinely limited only extends the
                                    // block, so fail safe toward waiting.
const RETRY_AFTER_FALLBACK_SECS: u64 = 30;
const MAX_ATTEMPTS: u32 = 3;

pub struct AppState {
    pub(crate) http: reqwest::Client,
    // token stays private: only auth's ensure_token/store_access (and invalidate_token) touch it.
    pub(crate) token: Mutex<Option<CachedToken>>,
    // The streaming-scoped token handed to the Web Playback SDK — its own family so the
    // full-scope main token never crosses IPC (see auth::ensure_streaming_token).
    pub(crate) streaming_token: Mutex<Option<CachedToken>>,
    pub(crate) granted_scope: Mutex<Option<String>>,
    // Plain std mutexes: critical sections are tiny and never held across an await.
    rate_limited_until: std::sync::Mutex<Option<Instant>>,
    last_request: std::sync::Mutex<Instant>,
    // Serializes library-mutating pulls. Two pulls running at once (e.g. a bulk pull overlapping
    // a single re-pull, or a double-clicked button) each seed their own filename set, so they can
    // independently mint the same new file name for two different playlists and clobber one. A
    // held-across-await lock makes pulls mutually exclusive without affecting read-only commands.
    pub(crate) pull_lock: Mutex<()>,
    // Set once during Tauri setup; used to push rate-limit events to the UI so it
    // doesn't have to poll.
    app: std::sync::OnceLock<tauri::AppHandle>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            // Always bound requests: reqwest has no default timeout, so a socket that connects
            // but then stalls (captive portal, half-open TCP, flaky Wi-Fi) would otherwise hang
            // forever. That matters doubly for token refresh — `ensure_token` holds the token
            // mutex across the refresh await, so a stalled refresh would block *every* other API
            // command until the OS TCP timeout (minutes) fired. A connect+request ceiling makes
            // network instability degrade into a prompt error instead of a frozen data layer.
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
                .expect("failed to build HTTP client"),
            token: Mutex::new(None),
            streaming_token: Mutex::new(None),
            granted_scope: Mutex::new(None),
            rate_limited_until: std::sync::Mutex::new(None),
            last_request: std::sync::Mutex::new(Instant::now() - MIN_REQUEST_INTERVAL),
            pull_lock: Mutex::new(()),
            app: std::sync::OnceLock::new(),
        }
    }

    /// Attach the app handle (called once from Tauri's setup hook).
    pub fn attach_app(&self, handle: tauri::AppHandle) {
        let _ = self.app.set(handle);
    }

    /// Tell the UI a cooldown is in effect (it counts down locally from there).
    fn emit_cooldown(&self, secs: u64) {
        use tauri::Emitter;
        if let Some(app) = self.app.get() {
            let _ = app.emit("rate-limit-cooldown", secs);
        }
    }

    /// Shared HTTP client (used by the metrics module for ReccoBeats calls).
    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// Remaining rate-limit cooldown in whole seconds (rounded up), or 0 if not limited.
    pub fn cooldown_secs(&self) -> u64 {
        let guard = self.rate_limited_until.lock().unwrap();
        match *guard {
            Some(until) => secs_until(until, Instant::now()),
            None => 0,
        }
    }

    fn set_cooldown(&self, secs: u64) {
        *self.rate_limited_until.lock().unwrap() = Some(Instant::now() + Duration::from_secs(secs));
        self.emit_cooldown(secs);
    }

    /// Drop the cached access token so the next `ensure_token` re-mints from the refresh
    /// token. Used when Spotify answers 401 despite a locally-unexpired token (revoked or
    /// invalidated server-side).
    pub(crate) async fn invalidate_token(&self) {
        self.token.lock().await.take();
    }

    /// Reserve the next request slot (enforces MIN_REQUEST_INTERVAL between calls) and return
    /// how long the caller should sleep before sending. The lock is released before sleeping.
    fn reserve_slot(&self) -> Duration {
        let mut last = self.last_request.lock().unwrap();
        let now = Instant::now();
        let earliest = *last + MIN_REQUEST_INTERVAL;
        let wait = earliest.saturating_duration_since(now);
        *last = if wait.is_zero() { now } else { earliest };
        wait
    }
}

/// Whole seconds remaining until `until`, rounded up so a sub-second remainder still shows as
/// ≥1 while genuinely blocked (never 0), and 0 once elapsed. Rounding up is `ceil`, not a flat
/// `+1`: a wait landing exactly on a second boundary must report that second, not one more.
fn secs_until(until: Instant, now: Instant) -> u64 {
    if until > now {
        (until - now).as_secs_f64().ceil() as u64
    } else {
        0
    }
}

fn retry_after_secs(resp: &reqwest::Response) -> Option<u64> {
    resp.headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn rate_limit_msg(secs: u64) -> String {
    if secs > 0 {
        format!("HTTP 429 Too Many Requests — Spotify rate limit. Wait {secs}s before retrying.")
    } else {
        "HTTP 429 Too Many Requests — Spotify rate limit.".to_string()
    }
}

/// Rate-limit preflight shared by every Spotify call: if we're in a cooldown longer than we'd
/// auto-wait, fail fast (issuing the request would only extend it); wait out a short cooldown;
/// then pace to MIN_REQUEST_INTERVAL so a burst doesn't trip the rolling window. Returns Err only
/// when we refuse up front. Extracted so reads, writes, and the player poll can't drift apart.
pub(crate) async fn rate_limit_preflight(state: &AppState) -> Result<(), String> {
    let cooldown = state.cooldown_secs();
    if cooldown > AUTO_RETRY_CAP_SECS {
        state.emit_cooldown(cooldown); // re-sync a UI whose local countdown drifted
        return Err(rate_limit_msg(cooldown));
    }
    if cooldown > 0 {
        tokio::time::sleep(Duration::from_secs(cooldown)).await;
    }
    let wait = state.reserve_slot();
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    Ok(())
}

pub(crate) struct CachedToken {
    pub(crate) value: String,
    pub(crate) expires_at: Instant,
}

// ---------------------------------------------------------------------------
// Public DTOs (returned to the frontend)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct Profile {
    pub id: String,
    pub display_name: Option<String>,
    /// Set when the second, streaming-only authorization didn't complete. The login itself
    /// succeeded and every non-playback feature works; the built-in player does not, because
    /// the webview is given no token at all rather than the full-scope one (see
    /// `auth::ensure_streaming_token`). Reconnecting retries the grant.
    pub streaming_error: Option<String>,
}

#[derive(Serialize)]
pub struct PlaylistSummary {
    pub spotify_id: String,
    pub name: String,
    pub track_count: usize,
    /// The written file name, or `None` if the playlist was skipped.
    pub file: Option<String>,
    /// Set when the playlist could not be pulled (e.g. Spotify-restricted).
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Spotify API response shapes (only the fields we use)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct ProfileResp {
    pub(crate) id: String,
    pub(crate) display_name: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct Paging<T> {
    // For playlists the user neither owns nor collaborates on, the new /items endpoint
    // omits contents entirely — default to empty rather than failing to deserialize.
    #[serde(default = "Vec::new")]
    pub(crate) items: Vec<T>,
    #[serde(default)]
    pub(crate) next: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct ImageObj {
    pub(crate) url: String,
}

// Spotify returns `"images": null` (an explicit null, not an omitted field) for
// playlists without a custom cover. `#[serde(default)]` only fills a *missing*
// field, so a present-but-null value would otherwise fail the whole response with
// "error decoding response body". Treat null the same as absent.
pub(crate) fn null_default<'de, D, T>(de: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(de)?.unwrap_or_default())
}

#[derive(Deserialize)]
pub(crate) struct PlaylistObj {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: Option<String>,
    pub(crate) snapshot_id: String,
    #[serde(default, deserialize_with = "null_default")]
    pub(crate) images: Vec<ImageObj>,
    #[serde(default)]
    pub(crate) tracks: TracksRef,
}

// The `/me/playlists` listing includes a track total without the track contents — handy
// for showing a count before the (more expensive) per-playlist track fetch.
#[derive(Deserialize, Default)]
pub(crate) struct TracksRef {
    #[serde(default)]
    pub(crate) total: usize,
}

#[derive(Deserialize)]
pub(crate) struct PlaylistTrackObj {
    pub(crate) added_at: Option<String>,
    pub(crate) added_by: Option<AddedBy>,
    // Spotify's playlist-track object names this `item` (their February 2026 API change
    // renamed it from `track`, so older examples and SDKs will show the old name).
    pub(crate) item: Option<TrackObj>,
}

#[derive(Deserialize)]
pub(crate) struct AddedBy {
    pub(crate) id: String,
}

#[derive(Deserialize)]
pub(crate) struct TrackObj {
    pub(crate) uri: String,
    pub(crate) name: String,
    pub(crate) artists: Vec<ArtistObj>,
    pub(crate) external_ids: Option<ExternalIds>,
    #[serde(default)]
    pub(crate) album: Option<AlbumObj>,
    #[serde(default)]
    pub(crate) duration_ms: Option<u64>,
    // Only present when the request supplies a `market`. `false` = greyed out / unplayable.
    #[serde(default)]
    pub(crate) is_playable: Option<bool>,
    // With `market` set, Spotify "relinks" a track to a market-playable equivalent, replacing
    // the top-level uri. `linked_from` carries the original the playlist actually references —
    // we keep that as the canonical id so diffs and pushes stay stable.
    #[serde(default)]
    pub(crate) linked_from: Option<LinkedFrom>,
}

#[derive(Deserialize)]
pub(crate) struct LinkedFrom {
    pub(crate) uri: String,
}

#[derive(Deserialize)]
pub(crate) struct ArtistObj {
    pub(crate) name: String,
}

#[derive(Deserialize)]
pub(crate) struct AlbumObj {
    pub(crate) name: String,
}

#[derive(Deserialize)]
pub(crate) struct PlaylistMeta {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: Option<String>,
    pub(crate) snapshot_id: String,
    #[serde(default, deserialize_with = "null_default")]
    pub(crate) images: Vec<ImageObj>,
}

#[derive(Deserialize)]
pub(crate) struct ExternalIds {
    pub(crate) isrc: Option<String>,
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

pub(crate) fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Shared fetch helpers
//
// All three mint their own bearer token via `ensure_token` (cached, so this is cheap) and
// share the same 401 recovery: a 401 despite a locally-unexpired token means Spotify
// invalidated it server-side, so drop the cache and re-mint once from the refresh token.
// That also covers a token that expires mid-flow (e.g. a bulk pull outliving the ~1h TTL).
// ---------------------------------------------------------------------------

/// GET a JSON resource. On a non-2xx response, include Spotify's response body in the error
/// so failures like 403/404 are diagnosable.
pub(crate) async fn get_json<T: serde::de::DeserializeOwned>(
    state: &AppState,
    client_id: &str,
    url: &str,
) -> Result<T, String> {
    let mut refreshed_auth = false;
    for attempt in 0..MAX_ATTEMPTS {
        rate_limit_preflight(state).await?;

        let token = ensure_token(state, client_id).await?;
        let resp = state
            .http
            .get(url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(err)?;
        let status = resp.status();

        if status.as_u16() == 401 && !refreshed_auth {
            refreshed_auth = true;
            state.invalidate_token().await;
            continue;
        }
        if status.as_u16() == 429 {
            let secs = retry_after_secs(&resp).unwrap_or(RETRY_AFTER_FALLBACK_SECS);
            state.set_cooldown(secs);
            // Auto-recover from short blips; surface longer cooldowns to the user.
            if secs <= AUTO_RETRY_CAP_SECS && attempt + 1 < MAX_ATTEMPTS {
                tokio::time::sleep(Duration::from_secs(secs)).await;
                continue;
            }
            return Err(rate_limit_msg(secs));
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {status}: {}", body.trim()));
        }
        return resp.json::<T>().await.map_err(err);
    }
    Err(rate_limit_msg(state.cooldown_secs()))
}

/// Send a (typically mutating) request and return the raw (status, body). `rb` must NOT
/// carry auth — the bearer token is attached here so a 401 can be retried once with a
/// freshly-minted token (safe even for mutations: a 401 was rejected before being applied).
///
/// Writes follow the same rate-limit rules as reads (get_json): fail fast during a long
/// cooldown, pace requests, and record Retry-After when a 429 comes back — otherwise a
/// 429 on a push/unfollow would neither start the UI countdown nor stop follow-up calls.
/// Deliberately does NOT auto-retry on 429: re-sending a mutation blindly could double-apply it.
pub(crate) async fn send_capture(
    state: &AppState,
    client_id: &str,
    rb: reqwest::RequestBuilder,
) -> Result<(reqwest::StatusCode, String), String> {
    rate_limit_preflight(state).await?;
    let token = ensure_token(state, client_id).await?;
    let retry_rb = rb.try_clone(); // None only for streaming bodies, which we never use
    let mut resp = rb.bearer_auth(&token).send().await.map_err(err)?;
    if resp.status().as_u16() == 401 {
        if let Some(rb2) = retry_rb {
            state.invalidate_token().await;
            let token = ensure_token(state, client_id).await?;
            resp = rb2.bearer_auth(&token).send().await.map_err(err)?;
        }
    }
    let status = resp.status();
    if status.as_u16() == 429 {
        let secs = retry_after_secs(&resp).unwrap_or(RETRY_AFTER_FALLBACK_SECS);
        state.set_cooldown(secs);
        return Err(rate_limit_msg(secs));
    }
    let body = resp.text().await.unwrap_or_default();
    Ok((status, body))
}

/// GET a resource and return the raw (status, body), auto-recovering from a *short* 429 by
/// waiting out the Retry-After and retrying — like `get_json`, but keeping the raw body so the
/// caller can handle a non-JSON answer (e.g. a 204 no-content). Used by the player poll, which
/// fires every few seconds: without this, the first 429 in a rate-limit window would flap a hard
/// error onto the playback bar instead of quietly backing off. Safe to retry because it's a GET.
pub(crate) async fn capture_get_retry(
    state: &AppState,
    client_id: &str,
    url: &str,
) -> Result<(reqwest::StatusCode, String), String> {
    let mut refreshed_auth = false;
    for attempt in 0..MAX_ATTEMPTS {
        rate_limit_preflight(state).await?;
        let token = ensure_token(state, client_id).await?;
        let resp = state
            .http
            .get(url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(err)?;
        let status = resp.status();
        if status.as_u16() == 401 && !refreshed_auth {
            refreshed_auth = true;
            state.invalidate_token().await;
            continue;
        }
        if status.as_u16() == 429 {
            let secs = retry_after_secs(&resp).unwrap_or(RETRY_AFTER_FALLBACK_SECS);
            state.set_cooldown(secs);
            if secs <= AUTO_RETRY_CAP_SECS && attempt + 1 < MAX_ATTEMPTS {
                tokio::time::sleep(Duration::from_secs(secs)).await;
                continue;
            }
            return Err(rate_limit_msg(secs));
        }
        let body = resp.text().await.unwrap_or_default();
        return Ok((status, body));
    }
    Err(rate_limit_msg(state.cooldown_secs()))
}

// ---------------------------------------------------------------------------
// Pre-flight: does this app actually have playlist WRITE access?
//
// Spotify's docs don't settle whether a Development-Mode app may mutate playlists or
// whether that requires Extended Quota Mode, so the only reliable answer is to try it.
// This probe creates a throwaway playlist, adds then removes a track, and unfollows it —
// touching no existing playlist — and reports the HTTP result of each step.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ProbeStep {
    pub step: String,
    pub ok: bool,
    pub detail: String,
}

fn step(name: &str, status: reqwest::StatusCode, body: &str) -> ProbeStep {
    let ok = status.is_success();
    let detail = if ok {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {}", body.trim())
    };
    ProbeStep {
        step: name.to_string(),
        ok,
        detail,
    }
}

pub async fn probe_write(state: &AppState, client_id: String) -> Result<Vec<ProbeStep>, String> {
    // A long-lived public track used only as a transient add/remove target.
    const TEST_TRACK: &str = "spotify:track:4cOdK2wGLETKBW3PvgPWqT";

    let me: ProfileResp = get_json(state, &client_id, &format!("{API}/me")).await?;

    let mut steps = Vec::new();

    // 0. Show the scopes Spotify actually granted — a missing playlist-modify-* would be a
    //    fixable cause (re-consent), as opposed to a platform-level Dev-Mode block.
    let scope = state.granted_scope.lock().await.clone().unwrap_or_default();
    let has_modify = scope.contains("playlist-modify");
    steps.push(ProbeStep {
        step: "Granted scopes".to_string(),
        ok: has_modify,
        detail: if scope.is_empty() {
            "(unknown — reconnect to refresh)".to_string()
        } else {
            scope
        },
    });

    // 1. Modify an EXISTING playlist you own: add a track, then remove it (reversible).
    //    This is the endpoint that actually matters and is independent of create.
    let list: serde_json::Value =
        get_json(state, &client_id, &format!("{API}/me/playlists?limit=50")).await?;
    let owned = list["items"].as_array().and_then(|items| {
        items
            .iter()
            .find(|p| p["owner"]["id"].as_str() == Some(me.id.as_str()))
            .and_then(|p| {
                let id = p["id"].as_str()?.to_string();
                let name = p["name"].as_str().unwrap_or("playlist").to_string();
                Some((id, name))
            })
    });

    if let Some((pid, pname)) = owned {
        let items = format!("{}/items", playlist_url(&pid)?);
        let add_body = serde_json::json!({ "uris": [TEST_TRACK] });
        let (st, body) =
            send_capture(state, &client_id, state.http.post(&items).json(&add_body)).await?;
        steps.push(step(&format!("Add a track to \"{pname}\""), st, &body));

        // Only attempt removal if the add actually landed, to avoid leaving a stray track.
        if st.is_success() {
            let del_body = serde_json::json!({ "items": [ { "uri": TEST_TRACK } ] });
            let (st, body) =
                send_capture(state, &client_id, state.http.delete(&items).json(&del_body)).await?;
            steps.push(step(
                &format!("Remove that track from \"{pname}\""),
                st,
                &body,
            ));
        }
    } else {
        steps.push(ProbeStep {
            step: "Add a track to an existing playlist".to_string(),
            ok: false,
            detail: "No playlist you own was found to test on".to_string(),
        });
    }

    // 2. Create a brand-new playlist. Creation goes through POST /me/playlists; the older
    //    POST /users/{id}/playlists is deprecated and answers 403.
    let create_body = serde_json::json!({
        "name": "Setlist write test — safe to delete",
        "public": false,
        "description": "Created by Setlist to check write access. Safe to delete."
    });
    let (st, body) = send_capture(
        state,
        &client_id,
        state
            .http
            .post(format!("{API}/me/playlists"))
            .json(&create_body),
    )
    .await?;
    steps.push(step("Create a new playlist", st, &body));

    // Clean up the throwaway playlist if creation succeeded.
    if st.is_success() {
        if let Some(pid) = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(str::to_string))
        {
            let (st, body) = send_capture(
                state,
                &client_id,
                state
                    .http
                    .delete(format!("{}/followers", playlist_url(&pid)?)),
            )
            .await?;
            steps.push(step("Clean up the new playlist", st, &body));
        }
    }

    Ok(steps)
}

// ---------------------------------------------------------------------------
// Library-level operations (search, follow/unfollow/delete, replacement lookup)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub isrc: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
}

/// A near-identical, playable stand-in for an unavailable track. `source` is "library" (found
/// in another of the user's playlists) or "spotify" (found via search); `playlist` names the
/// source playlist when it came from the library.
#[derive(Serialize)]
pub struct ReplacementSuggestion {
    pub source: String,
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub isrc: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub playlist: Option<String>,
}

/// Outcome of unfollowing the archived playlists: how many succeeded, and a per-playlist
/// note for each one Spotify refused (instead of silently dropping failures).
#[derive(Serialize)]
pub struct UnfollowReport {
    pub done: usize,
    pub failed: Vec<String>,
}

/// Unfollow every archived playlist from Spotify (removes them from the library;
/// you remain the owner so Setlist can still read/edit them).
pub async fn unfollow_archived(
    state: &AppState,
    client_id: String,
    data_dir: PathBuf,
) -> Result<UnfollowReport, String> {
    let mut report = UnfollowReport {
        done: 0,
        failed: Vec::new(),
    };
    for file in load_archived(&data_dir) {
        let Ok(pf) = read_local(data_dir.clone(), file) else {
            continue;
        };
        // Locally-created, never-pushed playlists have no Spotify id — nothing to unfollow
        // (an empty id would produce a malformed /playlists//followers request).
        if pf.spotify_id.is_empty() {
            continue;
        }
        // A malformed id is one playlist's problem, not the batch's: report it alongside the
        // HTTP failures below and keep unfollowing the rest.
        let url = match playlist_url(&pf.spotify_id) {
            Ok(u) => format!("{u}/followers"),
            Err(e) => {
                report.failed.push(format!("\"{}\" ({e})", pf.name));
                continue;
            }
        };
        let result = send_capture(state, &client_id, state.http.delete(url)).await;
        match result {
            Ok((st, _)) if st.is_success() => report.done += 1,
            Ok((st, body)) => {
                report
                    .failed
                    .push(format!("\"{}\" (HTTP {st}: {})", pf.name, body.trim()))
            }
            // A transport error (offline, rate limit) mid-loop must not discard the report —
            // the playlists already unfollowed stay counted, and the rest are listed as
            // failed rather than silently skipped. Rate-limit failures short-circuit in the
            // preflight, so continuing doesn't hammer Spotify.
            Err(e) => report.failed.push(format!("\"{}\" ({e})", pf.name)),
        }
    }
    Ok(report)
}

/// Re-follow a playlist (re-adds it to your Spotify library).
pub async fn follow_playlist(
    state: &AppState,
    client_id: String,
    data_dir: PathBuf,
    file: String,
) -> Result<(), String> {
    let pf = read_local(data_dir, file)?;
    if pf.spotify_id.is_empty() {
        return Err("This playlist isn't on Spotify yet — push it first.".into());
    }
    let (st, b) = send_capture(
        state,
        &client_id,
        state
            .http
            .put(format!("{}/followers", playlist_url(&pf.spotify_id)?))
            .json(&serde_json::json!({ "public": false })),
    )
    .await?;
    if !st.is_success() {
        return Err(format!("Re-follow failed (HTTP {st}): {}", b.trim()));
    }
    Ok(())
}

/// Delete a playlist: unfollow it on Spotify (removes it from your library — the closest
/// Spotify has to delete, since you stay the owner) and remove all local traces of it.
pub async fn delete_playlist(
    state: &AppState,
    client_id: String,
    data_dir: PathBuf,
    staging_dir: PathBuf,
    file: String,
) -> Result<(), String> {
    let pf = read_local(data_dir.clone(), file.clone())?;
    // A locally-created playlist that was never pushed has an empty spotify_id; there's
    // nothing to unfollow on Spotify, so skip the API call and just drop the local copy.
    if !pf.spotify_id.is_empty() {
        let (st, b) = send_capture(
            state,
            &client_id,
            state
                .http
                .delete(format!("{}/followers", playlist_url(&pf.spotify_id)?)),
        )
        .await?;
        if !st.is_success() {
            return Err(format!(
                "Delete (unfollow) failed (HTTP {st}): {}",
                b.trim()
            ));
        }
    }

    if let Ok(path) = playlist_path(&data_dir, &file) {
        if path.exists() {
            std::fs::remove_file(path).map_err(err)?;
        }
    }
    clear_staged(staging_dir, file.clone())?;
    set_archived(data_dir.clone(), file.clone(), false)?;
    set_pinned(data_dir, file, false)?;
    Ok(())
}

pub async fn search_tracks(
    state: &AppState,
    client_id: String,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    // Spotify caps the search `limit` at 10 — asking for 20 answers 400.
    let url = format!(
        "{API}/search?type=track&limit=10&q={}",
        urlencoding::encode(query.trim())
    );

    #[derive(Deserialize)]
    struct SearchResp {
        tracks: Paging<TrackObj>,
    }

    let resp: SearchResp = get_json(state, &client_id, &url).await?;
    Ok(resp
        .tracks
        .items
        .into_iter()
        .map(|t| SearchResult {
            id: t.uri,
            title: t.name,
            artists: t.artists.into_iter().map(|a| a.name).collect(),
            isrc: t.external_ids.and_then(|e| e.isrc),
            album: t.album.map(|a| a.name),
            duration_ms: t.duration_ms,
        })
        .collect())
}

// --- Drop-in replacement search for unavailable (greyed-out) tracks ---------------------

/// Normalize text for loose comparison: lowercase, alphanumerics only, single-spaced.
fn norm_text(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if c.is_whitespace() && !out.ends_with(' ') && !out.is_empty() {
            out.push(' ');
        }
    }
    out.trim_end().to_string()
}

/// The "base" song title: text before a " - " suffix or a trailing "(…)" — these usually carry
/// remaster/version decoration, so dropping them lets "Song" match "Song - 2011 Remaster".
fn base_title(s: &str) -> String {
    let mut t = s;
    if let Some(i) = t.find(" - ") {
        t = &t[..i];
    }
    if let Some(i) = t.find(" (") {
        t = &t[..i];
    }
    norm_text(t)
}

/// Whether `cand` is a near-identical drop-in for the original: same base title, an overlapping
/// artist, and (when both durations are known) within 3 seconds.
fn near_identical(
    o_title: &str,
    o_artists: &[String],
    o_dur: Option<u64>,
    c_title: &str,
    c_artists: &[String],
    c_dur: Option<u64>,
) -> bool {
    if base_title(o_title) != base_title(c_title) {
        return false;
    }
    let oset: std::collections::HashSet<String> = o_artists.iter().map(|a| norm_text(a)).collect();
    if !c_artists.iter().any(|a| oset.contains(&norm_text(a))) {
        return false;
    }
    match (o_dur, c_dur) {
        (Some(a), Some(b)) => (a as i64 - b as i64).abs() <= 3000,
        _ => true,
    }
}

/// Scan the local library for a playable track that's a near-identical stand-in for `track`
/// (a different, still-available release of the same song). Prefers a same-ISRC match, then the
/// closest duration. No network.
fn library_replacement(data_dir: &Path, track: &TrackEntry) -> Option<ReplacementSuggestion> {
    let dir = data_dir.join("playlists");
    let entries = std::fs::read_dir(&dir).ok()?;
    let mut best: Option<(i64, ReplacementSuggestion)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(pf) = read_playlist_cached(&path) else {
            continue;
        };
        for cand in &pf.tracks {
            if cand.id == track.id || cand.id.starts_with("spotify:local:") {
                continue;
            }
            if cand.is_playable == Some(false) {
                continue;
            }
            let same_isrc = track.isrc.is_some() && track.isrc == cand.isrc;
            if !(same_isrc
                || near_identical(
                    &track.title,
                    &track.artists,
                    track.duration_ms,
                    &cand.title,
                    &cand.artists,
                    cand.duration_ms,
                ))
            {
                continue;
            }
            let delta = match (track.duration_ms, cand.duration_ms) {
                (Some(a), Some(b)) => (a as i64 - b as i64).abs(),
                _ => 5000,
            };
            let score = if same_isrc { delta - 100_000 } else { delta };
            if best.as_ref().map(|(s, _)| score < *s).unwrap_or(true) {
                best = Some((
                    score,
                    ReplacementSuggestion {
                        source: "library".into(),
                        id: cand.id.clone(),
                        title: cand.title.clone(),
                        artists: cand.artists.clone(),
                        isrc: cand.isrc.clone(),
                        album: None,
                        duration_ms: cand.duration_ms,
                        playlist: Some(pf.name.clone()),
                    },
                ));
            }
        }
    }
    best.map(|(_, s)| s)
}

/// Find a near-identical, playable replacement for an unavailable track: first from the user's
/// own library (no network), then via a market-scoped Spotify search.
pub async fn suggest_replacement(
    state: &AppState,
    client_id: String,
    data_dir: PathBuf,
    track: TrackEntry,
) -> Result<Option<ReplacementSuggestion>, String> {
    if let Some(s) = library_replacement(&data_dir, &track) {
        return Ok(Some(s));
    }

    let primary = track.artists.first().cloned().unwrap_or_default();
    let query = format!("{} {}", track.title, primary);
    // `market=from_token` keeps results to what's playable for this user (so a suggestion can't
    // itself be greyed out) and reports `is_playable`.
    let url = format!(
        "{API}/search?type=track&limit=10&market=from_token&q={}",
        urlencoding::encode(query.trim())
    );

    #[derive(Deserialize)]
    struct SearchResp {
        tracks: Paging<TrackObj>,
    }

    let resp: SearchResp = get_json(state, &client_id, &url).await?;
    let mut best: Option<(i64, ReplacementSuggestion)> = None;
    for t in resp.tracks.items {
        let id = t
            .linked_from
            .as_ref()
            .map(|l| l.uri.clone())
            .unwrap_or_else(|| t.uri.clone());
        if id == track.id || t.is_playable == Some(false) {
            continue;
        }
        let artists: Vec<String> = t.artists.iter().map(|a| a.name.clone()).collect();
        let isrc = t.external_ids.as_ref().and_then(|e| e.isrc.clone());
        let same_isrc = track.isrc.is_some() && track.isrc == isrc;
        if !(same_isrc
            || near_identical(
                &track.title,
                &track.artists,
                track.duration_ms,
                &t.name,
                &artists,
                t.duration_ms,
            ))
        {
            continue;
        }
        let delta = match (track.duration_ms, t.duration_ms) {
            (Some(a), Some(b)) => (a as i64 - b as i64).abs(),
            _ => 5000,
        };
        let score = if same_isrc { delta - 100_000 } else { delta };
        if best.as_ref().map(|(s, _)| score < *s).unwrap_or(true) {
            best = Some((
                score,
                ReplacementSuggestion {
                    source: "spotify".into(),
                    id,
                    title: t.name.clone(),
                    artists,
                    isrc,
                    album: t.album.as_ref().map(|a| a.name.clone()),
                    duration_ms: t.duration_ms,
                    playlist: None,
                },
            ));
        }
    }
    Ok(best.map(|(_, s)| s))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The premise `playlist_url` exists for: a raw id in the path is not inert. If this ever
    /// fails, the request client stopped normalizing and the doc comment needs revisiting —
    /// the validator itself should stay either way.
    #[test]
    fn an_unchecked_id_can_move_the_request_off_the_playlists_endpoint() {
        let forged =
            reqwest::Url::parse(&format!("{API}/playlists/../me/player/pause/items")).unwrap();
        assert_eq!(forged.path(), "/v1/me/player/pause/items");

        // And a `?` in the id eats the query the caller appended after it.
        let swallowed =
            reqwest::Url::parse(&format!("{API}/playlists/x?a=1?fields=snapshot_id")).unwrap();
        assert_eq!(swallowed.query(), Some("a=1?fields=snapshot_id"));
    }

    #[test]
    fn playlist_url_only_accepts_a_base_62_id() {
        // The shape Spotify actually issues: 22 base-62 characters.
        assert_eq!(
            playlist_url("37i9dQZF1DXcBWIGoYBM5M").unwrap(),
            "https://api.spotify.com/v1/playlists/37i9dQZF1DXcBWIGoYBM5M"
        );

        // Each of these would rewrite the request rather than name a playlist. `..` is the
        // dangerous one: `url` resolves it, so the path below would leave /playlists/
        // entirely and hit the player with whatever verb the caller chose.
        for bad in [
            "",
            "../me/player/pause",
            "abc/followers",
            "abc?fields=x",
            "abc#frag",
            "abc%2f",
            "spotify:playlist:abc",
            "abc def",
        ] {
            assert!(playlist_url(bad).is_err(), "should have rejected {bad:?}");
        }

        // Well-formed but absurd is still rejected, so the message can safely quote it.
        assert!(playlist_url(&"a".repeat(MAX_ID_LEN + 1)).is_err());
        assert!(playlist_url(&"a".repeat(MAX_ID_LEN)).is_ok());
    }

    #[test]
    fn secs_until_ceils_and_never_reports_zero_while_blocked() {
        let now = Instant::now();
        // A whole-second boundary reports exactly that second, not one more.
        assert_eq!(secs_until(now + Duration::from_secs(2), now), 2);
        // ~1.5s left rounds up to 2s.
        assert_eq!(secs_until(now + Duration::from_millis(1500), now), 2);
        // A sub-second remainder still shows as 1s — never 0 while genuinely blocked.
        assert_eq!(secs_until(now + Duration::from_millis(1), now), 1);
        // At/after the deadline, 0.
        assert_eq!(secs_until(now, now), 0);
        assert_eq!(secs_until(now - Duration::from_secs(1), now), 0);
    }
}
