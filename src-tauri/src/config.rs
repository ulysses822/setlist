//! Local app configuration (non-secret). The Spotify *client id* is public for a PKCE
//! app, so it lives here in the OS app-config dir. Secrets (refresh token) go in the keychain.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
    /// Spotify application client id (from the developer dashboard).
    #[serde(default)]
    pub client_id: String,
    /// Absolute path to the "hub" repo where playlists/, history/, cache/ live.
    /// Must be explicitly configured (see `resolve_data_dir`) — there is no fallback,
    /// so playlist data can never end up inside the app's own repo/install dir.
    #[serde(default)]
    pub data_dir: String,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

pub fn load(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Where un-pushed edits are cached (machine-local; never in the data repo).
pub fn staging_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("staged");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn save(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Check that a configured data folder is usable: absolute (a relative path would resolve
/// against the process CWD, which differs between `tauri dev` and an installed build) and
/// actually a directory.
pub fn validate_data_dir(configured: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(configured);
    if !path.is_absolute() {
        return Err(format!(
            "Data folder must be an absolute path (got \"{configured}\") — pick it with Browse in Setup."
        ));
    }
    if !path.is_dir() {
        return Err(format!("Data folder doesn't exist (or isn't a folder): {configured}"));
    }
    Ok(path)
}

/// Resolve where to read/write the data files. The data folder must be explicitly
/// configured — there is deliberately no fallback to the app's own directory, so playlist
/// data and app code can never mix.
pub fn resolve_data_dir(cfg: &AppConfig) -> Result<PathBuf, String> {
    let configured = cfg.data_dir.trim();
    if configured.is_empty() {
        return Err(
            "No data folder configured — choose one in Setup (Browse…) first.".to_string(),
        );
    }
    validate_data_dir(configured)
}
