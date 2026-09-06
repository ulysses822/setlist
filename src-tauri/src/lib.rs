mod config;
mod git;
mod history;
mod metrics;
mod spotify;

use config::AppConfig;
use spotify::{
    AppState, LocalPlaylist, LocalTrackHit, PlaylistFile, PlaylistSummary, Profile, PushResult,
    SearchResult, SyncStatus, TrackEntry,
};

/// Load config and require a non-empty Spotify client id. Almost every Spotify-touching command
/// needs one, so the "connect first" invariant lives here in exactly one place rather than being
/// re-checked at each call site. Returns the trimmed id.
fn require_client_id(app: &tauri::AppHandle) -> Result<String, String> {
    let cfg = config::load(app)?;
    let id = cfg.client_id.trim();
    if id.is_empty() {
        return Err("Set your Spotify Client ID first.".into());
    }
    Ok(id.to_string())
}

/// The client id (required) plus the resolved data dir — the shared preamble for commands that
/// both call Spotify and read/write the data folder.
fn require_client_id_and_data_dir(
    app: &tauri::AppHandle,
) -> Result<(String, std::path::PathBuf), String> {
    let cfg = config::load(app)?;
    let id = cfg.client_id.trim();
    if id.is_empty() {
        return Err("Set your Spotify Client ID first.".into());
    }
    Ok((id.to_string(), config::resolve_data_dir(&cfg)?))
}

// Commands marked `(async)` run on the async runtime instead of the main thread. Without it,
// a synchronous command blocks the UI event loop for its whole duration — invisible for a
// config read, but a `git push` over the network would freeze the window for seconds. The
// convention here: anything touching disk, the keyring, a subprocess, or the network gets
// `(async)`; only pure in-memory commands (redirect_uri, rate_limit_status) stay sync.
#[tauri::command(async)]
fn get_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    config::load(&app)
}

#[tauri::command(async)]
fn set_config(app: tauri::AppHandle, client_id: String, data_dir: String) -> Result<(), String> {
    let data_dir = data_dir.trim().to_string();
    // Reject a bad folder at save time (clear feedback in Setup) rather than on first use.
    // Empty is allowed here — e.g. connecting before choosing a folder — but every command
    // that touches data will refuse until one is configured.
    if !data_dir.is_empty() {
        config::validate_data_dir(&data_dir)?;
    }
    config::save(
        &app,
        &AppConfig {
            client_id: client_id.trim().to_string(),
            data_dir,
        },
    )
}

/// The loopback URI the user must register in the Spotify dashboard.
#[tauri::command]
fn redirect_uri() -> String {
    spotify::REGISTERED_REDIRECT.to_string()
}

/// Open a native folder picker and return the chosen directory (None if cancelled).
/// Used in Setup to choose the data folder without typing a path.
#[tauri::command]
async fn pick_folder() -> Result<Option<String>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("Choose the Setlist data folder")
        .pick_folder()
        .await;
    Ok(folder.map(|f| f.path().to_string_lossy().to_string()))
}

/// Show a folder in the system file explorer (used for the configured data folder).
#[tauri::command(async)]
fn open_folder(path: String) -> Result<(), String> {
    let dir = config::validate_data_dir(path.trim())?;
    open::that(dir).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn auth_status() -> bool {
    spotify::has_refresh_token()
}

/// Mint a minimal-scope (user-read-recently-played) refresh token for the GitHub Actions
/// history poller. A separate grant from the app's login; returned to the UI, never stored.
/// Uses the confidential flow (client secret, no PKCE) so the resulting token doesn't rotate
/// — see `spotify::mint_history_token`. The secret is passed in transiently, not persisted.
#[tauri::command]
async fn mint_history_token(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    client_secret: String,
) -> Result<String, String> {
    spotify::mint_history_token(&state, require_client_id(&app)?, client_secret).await
}

// The listening-history logger lives in the *data* repo, not here: the app repo holds only
// code, and the poll history (plus its CI secrets) is personal. These templates are baked
// into the binary and written into the configured data repo on request, where that repo's
// own GitHub Actions maintains history/plays.jsonl. Paths are relative to the data-repo root.
const LOGGER_WORKFLOW_PATH: &str = ".github/workflows/poll-plays.yml";
// Dependency-free plain Node ESM (.mjs), run directly with `node` — no tsx/npx, so the
// secret-bearing CI job pulls nothing from npm. See templates/poll-plays.mjs.
const LOGGER_SCRIPT_PATH: &str = "scripts/poll-plays.mjs";
const LOGGER_WORKFLOW: &str = include_str!("../../templates/poll-plays.yml");
const LOGGER_SCRIPT: &str = include_str!("../../templates/poll-plays.mjs");

/// Which template files were newly created vs. overwritten, so the UI can report honestly
/// (re-running updates the templates in place rather than silently no-op'ing).
#[derive(serde::Serialize)]
struct ScaffoldReport {
    created: Vec<String>,
    updated: Vec<String>,
}

/// Write the listening-history logger (workflow + poller script) into the configured data
/// repo, making that repo self-maintaining. Overwrites in place on re-run to pick up
/// template improvements; reports which files were created vs. updated.
#[tauri::command(async)]
fn scaffold_history_logger(app: tauri::AppHandle) -> Result<ScaffoldReport, String> {
    let cfg = config::load(&app)?;
    let data_dir = config::resolve_data_dir(&cfg)?;
    // A logger in a folder that was never pushed anywhere can't run — block it up front.
    git::require_remote(&data_dir)?;

    let mut report = ScaffoldReport {
        created: vec![],
        updated: vec![],
    };
    for (rel, contents) in [
        (LOGGER_WORKFLOW_PATH, LOGGER_WORKFLOW),
        (LOGGER_SCRIPT_PATH, LOGGER_SCRIPT),
    ] {
        let dest = data_dir.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        let existed = dest.exists();
        std::fs::write(&dest, contents).map_err(|e| format!("Couldn't write {rel}: {e}"))?;
        if existed {
            report.updated.push(rel.to_string());
        } else {
            report.created.push(rel.to_string());
        }
    }
    Ok(report)
}

// --- Data-repo version control (git) ---------------------------------------

/// Snapshot of the data repo for the Version-history panel: branch, pending changes (each
/// summarized), and how far ahead of the remote it is.
#[tauri::command(async)]
fn git_repo_status(app: tauri::AppHandle) -> Result<git::RepoStatus, String> {
    let cfg = config::load(&app)?;
    let data_dir = config::resolve_data_dir(&cfg)?;
    git::status(&data_dir)
}

/// Suggested (editable) commit message for the current working-tree changes.
#[tauri::command(async)]
fn git_suggest_message(app: tauri::AppHandle) -> Result<String, String> {
    let cfg = config::load(&app)?;
    let data_dir = config::resolve_data_dir(&cfg)?;
    git::suggest_message(&data_dir)
}

/// Stage everything (respecting .gitignore) and commit with `message`. Returns fresh status.
#[tauri::command(async)]
fn git_commit(app: tauri::AppHandle, message: String) -> Result<git::RepoStatus, String> {
    let cfg = config::load(&app)?;
    let data_dir = config::resolve_data_dir(&cfg)?;
    git::commit(&data_dir, &message)
}

/// Push local commits to the remote (sets upstream on first push).
#[tauri::command(async)]
fn git_push(app: tauri::AppHandle) -> Result<git::PushOutcome, String> {
    let cfg = config::load(&app)?;
    let data_dir = config::resolve_data_dir(&cfg)?;
    git::push(&data_dir)
}

/// Per-track listening stats from the data repo's plays.jsonl (for the stale-track view).
#[tauri::command(async)]
fn history_stats(app: tauri::AppHandle) -> Result<history::HistoryReport, String> {
    let cfg = config::load(&app)?;
    let data_dir = config::resolve_data_dir(&cfg)?;
    history::read_plays(&data_dir)
}

/// Open an external page in the default browser. Restricted to the hosts the Setup screen
/// links to — the app deliberately doesn't ship a general-purpose URL opener.
#[tauri::command(async)]
fn open_external(url: String) -> Result<(), String> {
    const ALLOWED: [&str; 2] = ["https://github.com/", "https://developer.spotify.com/"];
    if !ALLOWED.iter().any(|prefix| url.starts_with(prefix)) {
        return Err(format!("Refusing to open non-allowlisted URL: {url}"));
    }
    open::that(&url).map_err(|e| e.to_string())
}

/// Remaining Spotify rate-limit cooldown in seconds (0 if not currently limited). Local
/// read — does not call Spotify — so it's safe to poll during a cooldown.
#[tauri::command]
fn rate_limit_status(state: tauri::State<'_, AppState>) -> u64 {
    state.cooldown_secs()
}

#[tauri::command]
async fn spotify_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Profile, String> {
    spotify::login(&state, require_client_id(&app)?).await
}

#[tauri::command(async)]
fn spotify_logout() -> Result<(), String> {
    spotify::logout()
}

#[tauri::command]
async fn probe_write(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<spotify::ProbeStep>, String> {
    spotify::probe_write(&state, require_client_id(&app)?).await
}

#[tauri::command]
async fn pull_playlists(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PlaylistSummary>, String> {
    let (client_id, data_dir) = require_client_id_and_data_dir(&app)?;
    spotify::pull_playlists(&state, client_id, data_dir).await
}

/// List the user's playlists (metadata only) so they can be pulled individually.
#[tauri::command]
async fn list_remote_playlists(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PlaylistSummary>, String> {
    spotify::list_remote(&state, require_client_id(&app)?).await
}

/// Pull one playlist by Spotify id (a few requests — won't trip the rate limit).
#[tauri::command]
async fn pull_playlist(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    spotify_id: String,
) -> Result<PlaylistSummary, String> {
    let (client_id, data_dir) = require_client_id_and_data_dir(&app)?;
    spotify::pull_one(&state, client_id, data_dir, spotify_id).await
}

#[tauri::command(async)]
fn list_local_playlists(app: tauri::AppHandle) -> Result<Vec<LocalPlaylist>, String> {
    let cfg = config::load(&app)?;
    let data_dir = config::resolve_data_dir(&cfg)?;
    let staging = config::staging_dir(&data_dir)?;
    spotify::list_local(data_dir, staging)
}

#[tauri::command(async)]
fn read_playlist(app: tauri::AppHandle, file: String) -> Result<PlaylistFile, String> {
    let cfg = config::load(&app)?;
    spotify::read_local(config::resolve_data_dir(&cfg)?, file)
}

/// "Save": cache edits (tracks + optional name/description) without touching the canonical
/// JSON or Spotify.
#[tauri::command(async)]
fn stage_playlist(
    app: tauri::AppHandle,
    file: String,
    name: Option<String>,
    description: Option<String>,
    tracks: Vec<TrackEntry>,
) -> Result<(), String> {
    let data_dir = config::resolve_data_dir(&config::load(&app)?)?;
    spotify::stage_local(config::staging_dir(&data_dir)?, file, name, description, tracks)
}

#[tauri::command(async)]
fn get_staged(app: tauri::AppHandle, file: String) -> Result<Option<spotify::StagedEdit>, String> {
    let data_dir = config::resolve_data_dir(&config::load(&app)?)?;
    spotify::get_staged(config::staging_dir(&data_dir)?, file)
}

/// Every non-archived playlist with its effective (staged-or-canonical) tracks — for the
/// library-wide cleanup scan.
#[tauri::command(async)]
fn read_all_playlists(app: tauri::AppHandle) -> Result<Vec<spotify::NamedPlaylist>, String> {
    let cfg = config::load(&app)?;
    let data_dir = config::resolve_data_dir(&cfg)?;
    let staging = config::staging_dir(&data_dir)?;
    spotify::read_all_local(data_dir, staging)
}

#[tauri::command(async)]
fn clear_staged(app: tauri::AppHandle, file: String) -> Result<(), String> {
    let data_dir = config::resolve_data_dir(&config::load(&app)?)?;
    spotify::clear_staged(config::staging_dir(&data_dir)?, file)
}

#[tauri::command(async)]
fn set_archived(app: tauri::AppHandle, file: String, archived: bool) -> Result<(), String> {
    let cfg = config::load(&app)?;
    spotify::set_archived(config::resolve_data_dir(&cfg)?, file, archived)
}

/// Mood goals and view state. Both are read once at startup and written through on change,
/// so these are the only two round trips the UI makes for them.
#[tauri::command(async)]
fn get_goals(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let cfg = config::load(&app)?;
    Ok(spotify::load_goals(&config::resolve_data_dir(&cfg)?))
}

#[tauri::command(async)]
fn set_goals(app: tauri::AppHandle, goals: serde_json::Value) -> Result<(), String> {
    let cfg = config::load(&app)?;
    spotify::save_goals(&config::resolve_data_dir(&cfg)?, &goals)
}

#[tauri::command(async)]
fn get_ui_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let cfg = config::load(&app)?;
    Ok(spotify::load_ui_state(&config::resolve_data_dir(&cfg)?))
}

#[tauri::command(async)]
fn set_ui_state(app: tauri::AppHandle, state: serde_json::Value) -> Result<(), String> {
    let cfg = config::load(&app)?;
    spotify::save_ui_state(&config::resolve_data_dir(&cfg)?, &state)
}

#[tauri::command(async)]
fn set_pinned(app: tauri::AppHandle, file: String, pinned: bool) -> Result<(), String> {
    let cfg = config::load(&app)?;
    spotify::set_pinned(config::resolve_data_dir(&cfg)?, file, pinned)
}

/// Create a new playlist locally (no Spotify call) so it works even while rate-limited.
/// The first push creates it on Spotify.
#[tauri::command(async)]
fn create_playlist(
    app: tauri::AppHandle,
    name: String,
    description: String,
) -> Result<spotify::LocalPlaylist, String> {
    let cfg = config::load(&app)?;
    let data_dir = config::resolve_data_dir(&cfg)?;
    spotify::create_local(data_dir, name, description)
}

#[tauri::command]
async fn delete_playlist(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file: String,
) -> Result<(), String> {
    let (client_id, data_dir) = require_client_id_and_data_dir(&app)?;
    let staging_dir = config::staging_dir(&data_dir)?;
    spotify::delete_playlist(&state, client_id, data_dir, staging_dir, file).await
}

#[tauri::command]
async fn unfollow_archived(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<spotify::UnfollowReport, String> {
    let (client_id, data_dir) = require_client_id_and_data_dir(&app)?;
    spotify::unfollow_archived(&state, client_id, data_dir).await
}

#[tauri::command]
async fn follow_playlist(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file: String,
) -> Result<(), String> {
    let (client_id, data_dir) = require_client_id_and_data_dir(&app)?;
    spotify::follow_playlist(&state, client_id, data_dir, file).await
}

/// Which (non-archived) local playlists contain any of the given track uris/ids.
/// Used by the sidebar to mark the playlists the playing song also appears in.
#[tauri::command(async)]
fn track_playlists(app: tauri::AppHandle, track_ids: Vec<String>) -> Result<Vec<String>, String> {
    let cfg = config::load(&app)?;
    let data_dir = config::resolve_data_dir(&cfg)?;
    let staging = config::staging_dir(&data_dir)?;
    spotify::playlists_containing(data_dir, staging, track_ids)
}

#[tauri::command(async)]
fn search_local_tracks(app: tauri::AppHandle, query: String) -> Result<Vec<LocalTrackHit>, String> {
    let cfg = config::load(&app)?;
    spotify::search_local(config::resolve_data_dir(&cfg)?, query)
}

#[tauri::command]
async fn search_tracks(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    spotify::search_tracks(&state, require_client_id(&app)?, query).await
}

/// Find a near-identical, playable stand-in for an unavailable (greyed-out) track — checked
/// against the local library first, then Spotify search.
#[tauri::command]
async fn suggest_replacement(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    track: TrackEntry,
) -> Result<Option<spotify::ReplacementSuggestion>, String> {
    let (client_id, data_dir) = require_client_id_and_data_dir(&app)?;
    spotify::suggest_replacement(&state, client_id, data_dir, track).await
}

#[tauri::command]
async fn push_playlist(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file: String,
    name: String,
    description: String,
    tracks: Vec<TrackEntry>,
    strategy: spotify::PushStrategy,
) -> Result<PushResult, String> {
    let (client_id, data_dir) = require_client_id_and_data_dir(&app)?;
    let staging = config::staging_dir(&data_dir)?;
    spotify::push_playlist(
        &state, client_id, data_dir, staging, file, name, description, tracks, strategy,
    )
    .await
}

#[tauri::command]
async fn get_access_token(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    spotify::access_token(&state, require_client_id(&app)?).await
}

#[tauri::command]
async fn player_play(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    device_id: String,
    context_uri: Option<String>,
    offset_uri: Option<String>,
    uris: Option<Vec<String>>,
) -> Result<(), String> {
    spotify::player_play(
        &state,
        require_client_id(&app)?,
        device_id,
        context_uri,
        offset_uri,
        uris,
    )
    .await
}

#[tauri::command]
async fn player_transfer(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    device_id: String,
    play: bool,
) -> Result<(), String> {
    spotify::player_transfer(&state, require_client_id(&app)?, device_id, play).await
}

/// List the user's available Spotify Connect devices (for the playback-bar device picker).
#[tauri::command]
async fn player_devices(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<spotify::DeviceInfo>, String> {
    spotify::player_devices(&state, require_client_id(&app)?).await
}

/// Current playback across all devices — lets the bar follow a session playing elsewhere.
#[tauri::command]
async fn player_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<spotify::RemotePlayback>, String> {
    spotify::player_state(&state, require_client_id(&app)?).await
}

/// Transport command (pause/resume/next/previous/seek) for the active remote device.
#[tauri::command]
async fn player_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    action: spotify::PlayerAction,
    position_ms: Option<u64>,
) -> Result<(), String> {
    spotify::player_command(&state, require_client_id(&app)?, action, position_ms).await
}

#[tauri::command]
async fn sync_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file: String,
) -> Result<SyncStatus, String> {
    let (client_id, data_dir) = require_client_id_and_data_dir(&app)?;
    spotify::sync_status(&state, client_id, data_dir, file).await
}

#[tauri::command]
async fn refresh_playlist(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    file: String,
) -> Result<PlaylistFile, String> {
    let (client_id, data_dir) = require_client_id_and_data_dir(&app)?;
    spotify::refresh_playlist(&state, client_id, data_dir, file).await
}

/// Fetch audio features for a specific set of tracks (cached). Used by the editor to fill
/// in metrics for newly added tracks without re-analyzing the whole playlist. Returns a map
/// of bare Spotify id -> Features for the tracks we have data for.
#[tauri::command]
async fn track_features(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    tracks: Vec<TrackEntry>,
) -> Result<std::collections::HashMap<String, metrics::Features>, String> {
    let cfg = config::load(&app)?;
    let data_dir = config::resolve_data_dir(&cfg)?;
    let requested: Vec<(String, Option<String>)> =
        tracks.into_iter().map(|t| (t.id, t.isrc)).collect();
    metrics::features_for(state.http(), data_dir, &requested).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First plugin, so a second launch is caught before anything else runs. Two instances
        // would share one keychain refresh token and rotate it out from under each other
        // (Spotify's reuse detection then invalidates the whole session — see ensure_token);
        // instead, focus the window of the copy that's already running.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(AppState::new())
        .setup(|app| {
            use tauri::Manager;
            // Let the backend push rate-limit events to the UI (no polling).
            app.state::<AppState>().attach_app(app.handle().clone());
            // Staged edits used to live in the app's config dir. Move any that are still
            // there into the configured data folder, once. Silent by design: a user with no
            // data folder set yet has nothing staged either.
            if let Ok(cfg) = config::load(app.handle()) {
                if let Ok(data_dir) = config::resolve_data_dir(&cfg) {
                    if let (Ok(legacy), Ok(current)) = (
                        config::legacy_staging_dir(app.handle()),
                        config::staging_dir(&data_dir),
                    ) {
                        config::migrate_legacy_staging(&legacy, &current);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            redirect_uri,
            pick_folder,
            open_folder,
            auth_status,
            mint_history_token,
            scaffold_history_logger,
            git_repo_status,
            git_suggest_message,
            git_commit,
            git_push,
            history_stats,
            open_external,
            rate_limit_status,
            spotify_login,
            spotify_logout,
            probe_write,
            pull_playlists,
            list_remote_playlists,
            pull_playlist,
            list_local_playlists,
            read_playlist,
            stage_playlist,
            get_staged,
            read_all_playlists,
            clear_staged,
            set_archived,
            set_pinned,
            get_goals,
            set_goals,
            get_ui_state,
            set_ui_state,
            create_playlist,
            delete_playlist,
            unfollow_archived,
            follow_playlist,
            track_playlists,
            search_local_tracks,
            search_tracks,
            suggest_replacement,
            push_playlist,
            sync_status,
            refresh_playlist,
            track_features,
            get_access_token,
            player_play,
            player_transfer,
            player_devices,
            player_state,
            player_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
