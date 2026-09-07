//! Local app configuration (non-secret). The Spotify *client id* is public for a PKCE
//! app, so it lives here in the OS app-config dir. Secrets (refresh token) go in the keychain.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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

/// Where saved-but-unpushed edits live: `<data_dir>/staged`, gitignored.
///
/// In the data folder rather than the app's own config dir for three reasons. They are the
/// user's work, and an uninstall offers to wipe the app's config dir. They belong to the
/// library they were edited against -- one shared staging area keyed by filename alone meant
/// two data folders holding a `road.json` each would trade drafts. And it keeps the app itself
/// near enough stateless, holding only the client id and the path to everything else.
///
/// Top-level rather than under `cache/`: that directory is advertised as rebuildable, and a
/// draft nobody has pushed yet is the opposite of rebuildable.
pub fn staging_dir(data_dir: &Path) -> Result<PathBuf, String> {
    let dir = data_dir.join("staged");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Where staged edits used to live, before they moved into the data folder.
pub fn legacy_staging_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("staged"))
}

/// Move edits left behind in the old location into the new one. Returns how many moved.
///
/// Never overwrites: a draft already in the data folder is the more recent intent, and the
/// stale copy is simply dropped. Runs at startup and is a single `exists()` check once the
/// old directory is gone.
pub fn migrate_legacy_staging(legacy: &Path, current: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(legacy) else {
        return 0;
    };
    let mut moved = 0;
    for entry in entries.flatten() {
        let from = entry.path();
        if from.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(name) = from.file_name() else {
            continue;
        };
        let to = current.join(name);
        if to.exists() {
            let _ = std::fs::remove_file(&from);
            continue;
        }
        // rename() fails across volumes, which a data folder on another drive would hit.
        if std::fs::rename(&from, &to).is_ok() || std::fs::copy(&from, &to).is_ok() {
            let _ = std::fs::remove_file(&from);
            moved += 1;
        }
    }
    let _ = std::fs::remove_dir(legacy); // only succeeds once it's empty
    moved
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
        return Err(format!(
            "Data folder doesn't exist (or isn't a folder): {configured}"
        ));
    }
    Ok(path)
}

/// Resolve where to read/write the data files. The data folder must be explicitly
/// configured — there is deliberately no fallback to the app's own directory, so playlist
/// data and app code can never mix.
pub fn resolve_data_dir(cfg: &AppConfig) -> Result<PathBuf, String> {
    let configured = cfg.data_dir.trim();
    if configured.is_empty() {
        return Err("No data folder configured — choose one in Setup (Browse…) first.".to_string());
    }
    validate_data_dir(configured)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(tag: &str) -> (PathBuf, PathBuf) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("setlist-staging-{tag}-{nanos}"));
        let (legacy, current) = (root.join("legacy"), root.join("current"));
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&current).unwrap();
        (legacy, current)
    }

    #[test]
    fn legacy_edits_move_into_the_data_folder() {
        let (legacy, current) = dirs("move");
        std::fs::write(legacy.join("road.json"), "{}").unwrap();
        std::fs::write(legacy.join("jog.json"), "{}").unwrap();

        assert_eq!(migrate_legacy_staging(&legacy, &current), 2);
        assert!(current.join("road.json").exists());
        assert!(current.join("jog.json").exists());
        // The old directory goes with them, so the migration runs exactly once.
        assert!(!legacy.exists());
    }

    #[test]
    fn an_edit_already_in_the_data_folder_is_not_clobbered() {
        let (legacy, current) = dirs("keep-newer");
        std::fs::write(legacy.join("road.json"), "stale").unwrap();
        std::fs::write(current.join("road.json"), "newer").unwrap();

        assert_eq!(migrate_legacy_staging(&legacy, &current), 0);
        assert_eq!(
            std::fs::read_to_string(current.join("road.json")).unwrap(),
            "newer"
        );
        assert!(
            !legacy.join("road.json").exists(),
            "the stale copy is dropped"
        );
    }

    #[test]
    fn nothing_to_migrate_is_not_an_error() {
        let (legacy, current) = dirs("empty");
        std::fs::remove_dir_all(&legacy).unwrap();
        assert_eq!(migrate_legacy_staging(&legacy, &current), 0);
    }
}
