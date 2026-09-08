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

/// True when `candidate` is `protected`, or sits anywhere underneath it.
///
/// Compared component by component rather than as strings, so a folder called `setlist-data`
/// is not read as living inside one called `setlist`. Both sides are canonicalized first
/// where they exist, which resolves `..`, symlinks and 8.3 short names into the one spelling
/// the filesystem agrees on; a directory that doesn't exist yet is compared as written.
/// Windows path components are case-insensitive, so they are matched that way.
fn is_within(candidate: &Path, protected: &Path) -> bool {
    let real = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (candidate, protected) = (real(candidate), real(protected));
    let same = |a: &std::path::Component, b: &std::path::Component| {
        if cfg!(windows) {
            a.as_os_str()
                .eq_ignore_ascii_case(b.as_os_str().to_string_lossy().as_ref())
        } else {
            a == b
        }
    };
    let mut walk = candidate.components();
    protected
        .components()
        .all(|p| walk.next().is_some_and(|c| same(&c, &p)))
}

/// The directories a data folder must not live inside, each with a name for the error.
///
/// All three are removed when Setlist is uninstalled — the installer deletes the program
/// directory, and the "delete settings and the saved login" checkbox deletes the other two
/// (see `nsis/hooks.nsh` and the Uninstalling table in the README). A data folder placed in
/// any of them would be deleted along with them, which is the one thing the README promises
/// cannot happen.
fn protected_dirs(app: &tauri::AppHandle) -> Vec<(PathBuf, &'static str)> {
    let mut dirs = Vec::new();
    if let Ok(dir) = app.path().app_config_dir() {
        dirs.push((dir, "Setlist's settings folder"));
    }
    if let Ok(dir) = app.path().app_local_data_dir() {
        dirs.push((dir, "Setlist's app-data folder"));
    }
    // The install directory, which the uninstaller removes wholesale.
    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| {
        exe.parent()
            .map(|p| p.to_path_buf())
            .filter(|p| !p.as_os_str().is_empty())
    }) {
        dirs.push((dir, "the folder Setlist itself is installed in"));
    }
    dirs
}

/// Validate a data folder the user has just chosen. Everything `validate_data_dir` checks,
/// plus: it must not be inside anything an uninstall deletes.
///
/// Enforced here, at the one place a folder is chosen, rather than on every read. A path
/// already saved before this existed keeps working — refusing it on read would lock someone
/// out of the Setup screen they need in order to fix it.
pub fn validate_data_dir_choice(
    app: &tauri::AppHandle,
    configured: &str,
) -> Result<PathBuf, String> {
    let path = validate_data_dir(configured)?;
    for (dir, what) in protected_dirs(app) {
        if is_within(&path, &dir) {
            return Err(format!(
                "That folder is inside {what}, which uninstalling Setlist deletes — your \
                 playlists and play history would go with it. Choose somewhere outside the \
                 app, such as a dedicated repo under your user folder."
            ));
        }
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

    /// The containment rule behind `validate_data_dir_choice`. Tested here rather than through
    /// that function because the protected directories come off an `AppHandle`, which a unit
    /// test has no way to build — but the decision itself is this, and it is the part that can
    /// be wrong.
    #[test]
    fn a_folder_inside_a_protected_one_is_recognised() {
        let app = PathBuf::from(r"C:\Users\me\AppData\Roaming\com.setlist.app");

        // The folder itself, and anything under it, is out.
        assert!(is_within(&app, &app));
        assert!(is_within(&app.join("playlists"), &app));
        assert!(is_within(&app.join("data").join("deep"), &app));

        // A sibling whose name merely starts with the same characters is not inside it --
        // the bug a plain `starts_with` on strings would have.
        let roaming = app.parent().unwrap();
        assert!(!is_within(&roaming.join("com.setlist.app-data"), &app));
        assert!(!is_within(&roaming.join("com.setlist"), &app));

        // And an ordinary choice somewhere else entirely is fine.
        assert!(!is_within(
            &PathBuf::from(r"C:\Users\me\music\setlist-data"),
            &app
        ));
        // A parent is not inside its own child.
        assert!(!is_within(roaming, &app));
    }

    /// Windows path components are case-insensitive, so a folder reached by a differently-cased
    /// spelling is the same folder and must be refused just the same. Neither path here exists,
    /// which is the case that skips canonicalization and relies on the comparison alone.
    #[cfg(windows)]
    #[test]
    fn case_does_not_get_a_folder_past_the_check() {
        assert!(is_within(
            &PathBuf::from(r"C:\Users\Me\APPDATA\Roaming\Com.Setlist.App\playlists"),
            &PathBuf::from(r"C:\users\me\appdata\roaming\com.setlist.app"),
        ));
    }

    /// `..` must not walk out of a protected directory and back in. Canonicalization is what
    /// collapses it, so both paths have to exist for this to mean anything.
    #[test]
    fn a_dot_dot_detour_does_not_escape_the_check() {
        let (protected, _) = dirs("within");
        let inside = protected.join("playlists");
        std::fs::create_dir_all(&inside).unwrap();

        let detour = inside.join("..").join("playlists");
        assert!(is_within(&detour, &protected), "{}", detour.display());

        std::fs::remove_dir_all(protected.parent().unwrap()).unwrap();
    }

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
