//! Git operations on the data repo, run from inside the app so the user can review,
//! commit, and push their playlist edits (and curation/history changes) without dropping
//! to a terminal. Everything shells out to `git` against the configured data dir and
//! relies on the user's ambient credential helper for auth — exactly like a terminal push.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::spotify::{PlaylistFile, TrackEntry};

/// One changed path in the data repo, with a human-readable summary of what changed.
#[derive(Serialize, Debug)]
pub struct FileChange {
    /// Path relative to the repo root, e.g. "playlists/road-trip.json".
    pub path: String,
    /// "added" | "modified" | "deleted".
    pub kind: String,
    /// One-line description, e.g. `"Road Trip": +3 −1, reordered`.
    pub summary: String,
}

/// Snapshot of the data repo for the Version-history panel.
#[derive(Serialize, Debug)]
pub struct RepoStatus {
    pub branch: String,
    pub has_remote: bool,
    pub has_upstream: bool,
    /// Local commits not yet on the remote (what a Push would send).
    pub ahead: u32,
    /// No uncommitted changes in the working tree.
    pub clean: bool,
    /// Both git user.name and user.email are set (committing fails otherwise).
    pub identity_ok: bool,
    pub changes: Vec<FileChange>,
}

#[derive(Serialize, Debug)]
pub struct PushOutcome {
    pub pushed: bool,
    pub message: String,
}

// --- low-level git runner ---------------------------------------------------

/// Windows gives every child process of a GUI app its own console window. The release build
/// is `windows_subsystem = "windows"` and so owns no console to lend them, which means each
/// git call flashes a black window on screen -- and one tab switch runs several. Debug builds
/// are console-subsystem apps whose children inherit the terminal, which is why this is
/// invisible under `tauri dev` and only shows up in a packaged build.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn run(dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output()
        .map_err(|e| format!("Couldn't run git (is it installed and on your PATH?): {e}"))
}

/// Trimmed stdout for a command expected to succeed; Err carries stderr otherwise.
fn run_ok(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = run(dir, args)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn is_repo(dir: &Path) -> bool {
    run(dir, &["rev-parse", "--is-inside-work-tree"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Refuse an operation unless `dir` is a git repo with at least one remote. A GitHub
/// Actions workflow (and a push) need a remote, so a local-only folder can't use these.
/// Errors carry the fix in plain language.
pub fn require_remote(dir: &Path) -> Result<(), String> {
    if !is_repo(dir) {
        return Err(
            "Your data folder isn't a git repository. The logger runs in GitHub Actions, so the \
             data repo has to be a git repo pushed to GitHub. Run `git init` there, then add a \
             GitHub remote and push."
                .into(),
        );
    }
    if run_ok(dir, &["remote"]).unwrap_or_default().is_empty() {
        return Err(
            "Your data repo has no git remote — it's local-only, so GitHub Actions can never run \
             the logger. Add a GitHub remote (`git remote add origin …`) and push first."
                .into(),
        );
    }
    Ok(())
}

// --- status -----------------------------------------------------------------

pub fn status(dir: &Path) -> Result<RepoStatus, String> {
    if !is_repo(dir) {
        return Err(
            "Your data folder isn't a git repository. Run `git init` there (or pick a folder that \
             already is one) to use version history."
                .into(),
        );
    }

    let branch = run_ok(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "HEAD".into());
    let has_remote = !run_ok(dir, &["remote"]).unwrap_or_default().is_empty();
    let has_upstream = run(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .map(|o| o.status.success())
        .unwrap_or(false);
    // "Ahead" only means something when there's somewhere to push to.
    let ahead = if has_remote { ahead_count(dir, &branch, has_upstream) } else { 0 };

    let name_set = run_ok(dir, &["config", "user.name"]).map(|s| !s.is_empty()).unwrap_or(false);
    let email_set = run_ok(dir, &["config", "user.email"]).map(|s| !s.is_empty()).unwrap_or(false);

    let details = changes(dir)?;
    let clean = details.is_empty();
    let changes = details
        .into_iter()
        .map(|d| FileChange { path: d.path, kind: d.kind.label().into(), summary: d.summary })
        .collect();

    Ok(RepoStatus {
        branch,
        has_remote,
        has_upstream,
        ahead,
        clean,
        identity_ok: name_set && email_set,
        changes,
    })
}

/// Commits on HEAD not yet on the remote. Uses the upstream when set; otherwise falls back
/// to `origin/<branch>` if it exists, else treats every commit on HEAD as unpushed.
fn ahead_count(dir: &Path, branch: &str, has_upstream: bool) -> u32 {
    let origin_branch = format!("origin/{branch}");
    let range = if has_upstream {
        "@{u}..HEAD".to_string()
    } else if run(dir, &["rev-parse", "--verify", "--quiet", &origin_branch])
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        format!("{origin_branch}..HEAD")
    } else {
        "HEAD".to_string() // no remote-tracking ref → all local commits are unpushed
    };
    run_ok(dir, &["rev-list", "--count", &range])
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

// --- change analysis --------------------------------------------------------

#[derive(Clone, Copy)]
enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

impl ChangeKind {
    fn label(self) -> &'static str {
        match self {
            ChangeKind::Added => "added",
            ChangeKind::Modified => "modified",
            ChangeKind::Deleted => "deleted",
        }
    }
}

struct ChangeDetail {
    path: String,
    kind: ChangeKind,
    /// One-line summary for the file list.
    summary: String,
    /// Extra lines (added/removed track titles) for the commit-message body, if any.
    body: Option<String>,
    is_playlist: bool,
}

/// Parse `git status --porcelain` into per-file change details, summarizing playlist edits
/// by diffing the committed (HEAD) version against the working file. Skips `cache/`.
fn changes(dir: &Path) -> Result<Vec<ChangeDetail>, String> {
    // Read raw stdout (not run_ok): porcelain encodes status in the first two columns, so
    // trimming would strip the leading space of an unstaged change and shift the path.
    let raw = run(
        dir,
        &["-c", "core.quotePath=false", "status", "--porcelain=v1", "-uall"],
    )?;
    if !raw.status.success() {
        return Err(String::from_utf8_lossy(&raw.stderr).trim().to_string());
    }
    let porcelain = String::from_utf8_lossy(&raw.stdout);

    let mut out = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let code = &line[..2];
        // Path begins at column 3; for renames git prints "old -> new" — keep the new path.
        let raw = line[3..].trim();
        let path = raw.rsplit(" -> ").next().unwrap_or(raw).trim_matches('"').to_string();

        if path.starts_with("cache/") {
            continue;
        }

        let kind = if code.contains('D') {
            ChangeKind::Deleted
        } else if code.contains('A') || code == "??" {
            ChangeKind::Added
        } else {
            ChangeKind::Modified
        };

        let is_playlist = path.starts_with("playlists/") && path.ends_with(".json");
        let (summary, body) = if is_playlist {
            playlist_change(dir, &path, kind)
        } else {
            (label_for(&path, kind), None)
        };
        out.push(ChangeDetail { path, kind, summary, body, is_playlist });
    }
    Ok(out)
}

/// Generic one-liner for non-playlist data files.
fn label_for(path: &str, kind: ChangeKind) -> String {
    let what = match path {
        "archived.json" => "Archived-playlist list",
        "pinned.json" => "Pinned-playlist list",
        "history/plays.jsonl" => "Listening history",
        ".github/workflows/poll-plays.yml" => "History-logger workflow",
        "scripts/poll-plays.mjs" => "History-logger script",
        ".gitignore" => "Git ignore rules",
        _ => return format!("{} {path}", verb(kind)),
    };
    format!("{} — {}", what, kind.label())
}

fn verb(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::Added => "Add",
        ChangeKind::Modified => "Update",
        ChangeKind::Deleted => "Remove",
    }
}

/// Read a playlist file at HEAD (committed) and in the working tree, then describe the diff.
fn playlist_change(dir: &Path, path: &str, kind: ChangeKind) -> (String, Option<String>) {
    let working = std::fs::read_to_string(dir.join(path))
        .ok()
        .and_then(|s| serde_json::from_str::<PlaylistFile>(&s).ok());
    let head = run(dir, &["show", &format!("HEAD:{path}")])
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| serde_json::from_slice::<PlaylistFile>(&o.stdout).ok());

    match (head, working) {
        (None, Some(w)) => (
            format!("Add playlist \"{}\" ({} tracks)", w.name, w.tracks.len()),
            None,
        ),
        (Some(h), None) => (format!("Remove playlist \"{}\"", h.name), None),
        (Some(h), Some(w)) => diff_playlists(&h, &w),
        // Couldn't parse either side — fall back to a path label.
        (None, None) => (format!("{} {path}", verb(kind)), None),
    }
}

/// Describe how playlist `new` differs from `old`: a counts subject plus an added/removed
/// body. Reordering is detected among the tracks common to both and flagged, not listed.
fn diff_playlists(old: &PlaylistFile, new: &PlaylistFile) -> (String, Option<String>) {
    use std::collections::HashSet;
    let old_ids: HashSet<&str> = old.tracks.iter().map(|t| t.id.as_str()).collect();
    let new_ids: HashSet<&str> = new.tracks.iter().map(|t| t.id.as_str()).collect();

    let added: Vec<&TrackEntry> = new.tracks.iter().filter(|t| !old_ids.contains(t.id.as_str())).collect();
    let removed: Vec<&TrackEntry> = old.tracks.iter().filter(|t| !new_ids.contains(t.id.as_str())).collect();

    // Order change among the tracks present on both sides (isolates reorder from add/remove).
    let old_common: Vec<&str> = old.tracks.iter().map(|t| t.id.as_str()).filter(|id| new_ids.contains(id)).collect();
    let new_common: Vec<&str> = new.tracks.iter().map(|t| t.id.as_str()).filter(|id| old_ids.contains(id)).collect();
    let reordered = old_common != new_common;

    // Metadata-only changes when membership and order are unchanged.
    if added.is_empty() && removed.is_empty() && !reordered {
        if old.name != new.name {
            return (format!("Rename \"{}\" → \"{}\"", old.name, new.name), None);
        }
        if old.description != new.description {
            return (format!("Update description of \"{}\"", new.name), None);
        }
        return (format!("Touch \"{}\" (no track changes)", new.name), None);
    }

    let mut parts = Vec::new();
    if !added.is_empty() {
        parts.push(format!("+{}", added.len()));
    }
    if !removed.is_empty() {
        parts.push(format!("−{}", removed.len())); // U+2212 minus
    }
    if reordered {
        parts.push("reordered".into());
    }
    let summary = format!("\"{}\": {}", new.name, parts.join(" "));

    let mut body = String::new();
    if !added.is_empty() {
        body.push_str("Added:\n");
        body.push_str(&track_lines("  + ", &added));
    }
    if !removed.is_empty() {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str("Removed:\n");
        body.push_str(&track_lines("  − ", &removed));
    }
    (summary, if body.is_empty() { None } else { Some(body) })
}

/// Up to 10 "<prefix><Title — Artists>" lines, then "  …and N more".
fn track_lines(prefix: &str, tracks: &[&TrackEntry]) -> String {
    const CAP: usize = 10;
    let mut s = String::new();
    for t in tracks.iter().take(CAP) {
        s.push_str(prefix);
        s.push_str(&t.title);
        if !t.artists.is_empty() {
            s.push_str(" — ");
            s.push_str(&t.artists.join(", "));
        }
        s.push('\n');
    }
    if tracks.len() > CAP {
        s.push_str(&format!("  …and {} more\n", tracks.len() - CAP));
    }
    s
}

// --- commit message ---------------------------------------------------------

/// Build an editable commit message from the current working-tree changes.
pub fn suggest_message(dir: &Path) -> Result<String, String> {
    let details = changes(dir)?;
    Ok(compose_message(&details))
}

fn compose_message(details: &[ChangeDetail]) -> String {
    match details.len() {
        0 => String::new(),
        1 => {
            let d = &details[0];
            match &d.body {
                Some(b) => format!("{}\n\n{}", d.summary, b.trim_end()),
                None => d.summary.clone(),
            }
        }
        _ => {
            let playlist_edits = details.iter().filter(|d| d.is_playlist).count();
            let others = details.len() - playlist_edits;
            let subject = match (playlist_edits, others) {
                (n, 0) => format!("Update {n} playlists"),
                (0, n) => format!("Update data repo ({n} changes)"),
                (p, o) => format!("Update data repo ({p} playlists, {o} other)"),
            };
            let mut body = String::new();
            for d in details {
                body.push_str(&d.summary);
                body.push('\n');
                if let Some(b) = &d.body {
                    for line in b.trim_end().lines() {
                        body.push_str("  ");
                        body.push_str(line);
                        body.push('\n');
                    }
                }
            }
            format!("{subject}\n\n{}", body.trim_end())
        }
    }
}

// --- commit & push ----------------------------------------------------------

/// Ensure `.gitignore` excludes the rebuildable feature cache, so `git add -A` never
/// commits it. No-op once the rule is present.
fn ensure_cache_ignored(dir: &Path) -> Result<(), String> {
    let gi = dir.join(".gitignore");
    let existing = std::fs::read_to_string(&gi).unwrap_or_default();
    if existing
        .lines()
        .any(|l| matches!(l.trim(), "cache/" | "/cache/" | "cache"))
    {
        return Ok(());
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# Derived audio-feature cache — rebuildable, keep out of git\ncache/\n");
    std::fs::write(&gi, next).map_err(|e| format!("Couldn't update .gitignore: {e}"))
}

pub fn commit(dir: &Path, message: &str) -> Result<RepoStatus, String> {
    if !is_repo(dir) {
        return Err("Your data folder isn't a git repository.".into());
    }
    if message.trim().is_empty() {
        return Err("Commit message can't be empty.".into());
    }
    ensure_cache_ignored(dir)?;

    let add = run(dir, &["add", "-A"])?;
    if !add.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&add.stderr).trim()
        ));
    }

    let out = run(dir, &["commit", "-m", message])?;
    if !out.status.success() {
        let err = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let lower = err.to_lowercase();
        if lower.contains("please tell me who you are") || lower.contains("user.name") {
            return Err(
                "Git needs an identity before it can commit. In your data repo run:\n  \
                 git config user.name \"Your Name\"\n  git config user.email \"you@example.com\""
                    .into(),
            );
        }
        if lower.contains("nothing to commit") {
            return Err("Nothing to commit — the data repo is already clean.".into());
        }
        return Err(err.trim().to_string());
    }
    status(dir)
}

/// Files the GitHub Actions history logger commits on its own schedule. The remote almost
/// always sits a few of these commits ahead of us because it polls every 30 minutes, so a
/// push that's rejected purely for *these* is safe to absorb automatically (see `push`).
const POLLER_FILES: &[&str] = &["history/plays.jsonl"];

fn current_branch(dir: &Path) -> String {
    run_ok(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "HEAD".into())
}

/// The remote this branch tracks (its `branch.<b>.remote`), else the first configured remote,
/// else "origin". Used to name the remote-tracking ref for fetch/rebase.
fn branch_remote(dir: &Path, branch: &str) -> String {
    run_ok(dir, &["config", &format!("branch.{branch}.remote")])
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            run_ok(dir, &["remote"])
                .ok()
                .and_then(|s| s.lines().next().map(|l| l.to_string()))
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "origin".into())
}

/// After a non-fast-forward rejection, work out whether the remote is only ahead because the
/// history logger appended to its log. Fetch, then look at the files the remote changed since
/// our common ancestor:
///   - if they're all poller files, rebase our commits on top (they touch disjoint files, so
///     this never conflicts) so the next push fast-forwards → `Ok(true)`;
///   - if the remote touched anything else, leave the tree untouched → `Ok(false)` so the
///     caller surfaces a real-divergence error.
///
/// Fetch/rebase failures return `Err`.
fn absorb_poller_commits(dir: &Path, branch: &str) -> Result<bool, String> {
    let remote = branch_remote(dir, branch);
    let remote_ref = format!("{remote}/{branch}");

    let fetched = run(dir, &["fetch", "--quiet", &remote])?;
    if !fetched.status.success() {
        return Err(format!(
            "Couldn't fetch from {remote} to reconcile with the remote:\n{}",
            String::from_utf8_lossy(&fetched.stderr).trim()
        ));
    }

    // Files the remote changed since our shared ancestor (three-dot: merge-base..remote).
    let incoming = run_ok(dir, &["diff", "--name-only", &format!("HEAD...{remote_ref}")])?;
    let files: Vec<&str> = incoming.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if files.is_empty() || !files.iter().all(|f| POLLER_FILES.contains(f)) {
        return Ok(false);
    }

    // Replay our commits on top of the logger's. Autostash keeps a stray dirty working tree
    // (the app commits before pushing, so this is just belt-and-braces) from blocking it.
    let rebased = run(dir, &["rebase", "--autostash", &remote_ref])?;
    if !rebased.status.success() {
        let err = format!(
            "{}{}",
            String::from_utf8_lossy(&rebased.stdout),
            String::from_utf8_lossy(&rebased.stderr)
        );
        let _ = run(dir, &["rebase", "--abort"]);
        return Err(format!(
            "Tried to fold in the remote's listening-history commits but the rebase failed:\n{}",
            err.trim()
        ));
    }
    Ok(true)
}

pub fn push(dir: &Path) -> Result<PushOutcome, String> {
    require_remote(dir)?;
    let branch = current_branch(dir);

    // The logger may land a fresh commit between our fetch and our push, so retry a couple of
    // times — each pass re-absorbs and tries again rather than failing the user's push.
    let mut absorbed = false;
    for attempt in 0..3 {
        let has_upstream = run(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .map(|o| o.status.success())
            .unwrap_or(false);
        // First push of a branch with no upstream sets one so later pushes are a bare `git push`.
        let args: &[&str] = if has_upstream {
            &["push"]
        } else {
            &["push", "-u", "origin", "HEAD"]
        };

        let out = run(dir, args)?;
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        if out.status.success() {
            let message = if absorbed {
                "Pulled in new listening history from the remote, then pushed.".into()
            } else if stderr.to_lowercase().contains("up-to-date") {
                "Already up to date — nothing to push.".into()
            } else {
                "Pushed to the remote.".into()
            };
            return Ok(PushOutcome { pushed: true, message });
        }

        let lower = stderr.to_lowercase();
        let rejected = lower.contains("non-fast-forward")
            || lower.contains("fetch first")
            || lower.contains("[rejected]");

        // A rejection might just be the history logger running ahead of us. Try to absorb its
        // commits and push again; only surface an error if the remote diverged on real content.
        if rejected && attempt < 2 {
            match absorb_poller_commits(dir, &branch)? {
                true => {
                    absorbed = true;
                    continue;
                }
                false => {
                    return Err(
                        "Push rejected — the remote has commits beyond the listening-history log \
                         that you don't have. Pull/rebase in a terminal (the app only \
                         auto-syncs the history log), then push again."
                            .into(),
                    );
                }
            }
        }

        let msg = if rejected {
            "Push rejected — the remote has commits you don't have. Pull/rebase in a terminal \
             (the app doesn't merge yet), then push again."
                .to_string()
        } else if lower.contains("authentication")
            || lower.contains("could not read")
            || lower.contains("permission denied")
            || lower.contains("403")
        {
            format!(
                "Push failed — couldn't authenticate to the remote. Make sure `git push` works from a \
                 terminal in this repo.\n\n{}",
                stderr.trim()
            )
        } else {
            stderr.trim().to_string()
        };
        return Err(msg);
    }

    // The loop returns on success or a terminal error; this is only reached if we somehow keep
    // racing the logger past every retry.
    Err("Push kept racing the history logger — try again in a moment.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, title: &str, artist: &str) -> TrackEntry {
        TrackEntry {
            id: id.into(),
            isrc: None,
            title: title.into(),
            artists: vec![artist.into()],
            added_at: None,
            added_by: None,
            duration_ms: None,
            is_playable: None,
        }
    }

    fn playlist(name: &str, tracks: Vec<TrackEntry>) -> PlaylistFile {
        PlaylistFile {
            spotify_id: "pid".into(),
            name: name.into(),
            description: String::new(),
            snapshot_id: "snap".into(),
            last_synced: "now".into(),
            cover_url: None,
            tracks,
        }
    }

    #[test]
    fn diff_reports_added_removed_and_reorder() {
        let old = playlist("Road Trip", vec![track("a", "A", "X"), track("b", "B", "Y"), track("c", "C", "Z")]);
        // remove b, add d, and move c before a → reorder among the common {a, c}.
        let new = playlist("Road Trip", vec![track("c", "C", "Z"), track("a", "A", "X"), track("d", "D", "W")]);
        let (summary, body) = diff_playlists(&old, &new);
        assert_eq!(summary, "\"Road Trip\": +1 −1 reordered");
        let body = body.expect("body");
        assert!(body.contains("Added:\n  + D — W"), "{body}");
        assert!(body.contains("Removed:\n  − B — Y"), "{body}");
    }

    #[test]
    fn pure_reorder_has_no_body() {
        let old = playlist("Mix", vec![track("a", "A", "X"), track("b", "B", "Y")]);
        let new = playlist("Mix", vec![track("b", "B", "Y"), track("a", "A", "X")]);
        let (summary, body) = diff_playlists(&old, &new);
        assert_eq!(summary, "\"Mix\": reordered");
        assert!(body.is_none());
    }

    #[test]
    fn rename_detected_when_tracks_unchanged() {
        let old = playlist("Old", vec![track("a", "A", "X")]);
        let new = playlist("New", vec![track("a", "A", "X")]);
        let (summary, body) = diff_playlists(&old, &new);
        assert_eq!(summary, "Rename \"Old\" → \"New\"");
        assert!(body.is_none());
    }

    #[test]
    fn added_list_caps_at_ten() {
        let old = playlist("Big", vec![]);
        let many: Vec<TrackEntry> = (0..13).map(|i| track(&format!("id{i}"), &format!("T{i}"), "A")).collect();
        let new = playlist("Big", many);
        let (summary, body) = diff_playlists(&old, &new);
        assert_eq!(summary, "\"Big\": +13");
        assert!(body.unwrap().contains("…and 3 more"));
    }

    #[test]
    fn compose_single_change_uses_summary_and_body() {
        let details = vec![ChangeDetail {
            path: "playlists/x.json".into(),
            kind: ChangeKind::Modified,
            summary: "\"X\": +1".into(),
            body: Some("Added:\n  + S — A".into()),
            is_playlist: true,
        }];
        assert_eq!(compose_message(&details), "\"X\": +1\n\nAdded:\n  + S — A");
    }

    #[test]
    fn compose_multiple_changes_summarizes_subject() {
        let details = vec![
            ChangeDetail { path: "playlists/a.json".into(), kind: ChangeKind::Modified, summary: "\"A\": +1".into(), body: None, is_playlist: true },
            ChangeDetail { path: "playlists/b.json".into(), kind: ChangeKind::Modified, summary: "\"B\": −1".into(), body: None, is_playlist: true },
        ];
        let msg = compose_message(&details);
        assert!(msg.starts_with("Update 2 playlists\n\n"), "{msg}");
        assert!(msg.contains("\"A\": +1"));
        assert!(msg.contains("\"B\": −1"));
    }

    // --- end-to-end against a real temp repo + bare remote ---

    use std::path::PathBuf;
    use std::process::Command;

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("setlist-git-{tag}-{nanos}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_playlist(dir: &Path, file: &str, name: &str, ids: &[&str]) {
        let tracks: Vec<String> = ids
            .iter()
            .map(|id| format!("{{\"id\":\"{id}\",\"title\":\"T{id}\",\"artists\":[\"A\"]}}"))
            .collect();
        let json = format!(
            "{{\"spotify_id\":\"p\",\"name\":\"{name}\",\"description\":\"\",\"snapshot_id\":\"s\",\"last_synced\":\"now\",\"tracks\":[{}]}}",
            tracks.join(",")
        );
        std::fs::create_dir_all(dir.join("playlists")).unwrap();
        std::fs::write(dir.join("playlists").join(file), json).unwrap();
    }

    #[test]
    fn end_to_end_status_commit_push() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let remote = unique_dir("remote");
        git(&remote, &["init", "--bare", "-q"]);

        let work = unique_dir("work");
        git(&work, &["init", "-q"]);
        git(&work, &["config", "user.name", "Test"]);
        git(&work, &["config", "user.email", "test@example.com"]);
        // Some CIs default to 'master'; pin the branch so push -u origin HEAD is predictable.
        git(&work, &["checkout", "-q", "-B", "main"]);
        write_playlist(&work, "road.json", "Road Trip", &["a", "b"]);
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-qm", "init"]);
        git(&work, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&work, &["push", "-qu", "origin", "main"]);

        // Clean to start.
        let s = status(&work).unwrap();
        assert!(s.clean && s.has_remote && s.has_upstream && s.ahead == 0, "fresh: {s:?}", s = (s.clean, s.has_remote, s.has_upstream, s.ahead));

        // Edit: add track c, remove b.
        write_playlist(&work, "road.json", "Road Trip", &["a", "c"]);
        let s = status(&work).unwrap();
        assert!(!s.clean);
        assert_eq!(s.changes.len(), 1);
        assert!(s.changes[0].summary.contains("Road Trip"), "{}", s.changes[0].summary);
        assert!(s.changes[0].summary.contains("+1"));

        let msg = suggest_message(&work).unwrap();
        assert!(msg.contains("Road Trip") && msg.contains("Added:"), "{msg}");

        // Commit, then it should be clean and one ahead.
        let s = commit(&work, &msg).unwrap();
        assert!(s.clean, "after commit should be clean");
        assert_eq!(s.ahead, 1, "one commit to push");

        // Push, then back to in sync.
        let out = push(&work).unwrap();
        assert!(out.pushed);
        let s = status(&work).unwrap();
        assert_eq!(s.ahead, 0, "pushed → not ahead");

        let _ = std::fs::remove_dir_all(&work);
        let _ = std::fs::remove_dir_all(&remote);
    }

    #[test]
    fn commit_rejects_empty_message() {
        if !git_available() {
            return;
        }
        let work = unique_dir("emptymsg");
        git(&work, &["init", "-q"]);
        write_playlist(&work, "x.json", "X", &["a"]);
        let err = commit(&work, "   ").unwrap_err();
        assert!(err.to_lowercase().contains("empty"), "got: {err}");
        let _ = std::fs::remove_dir_all(&work);
    }

    /// Set up a bare remote with one playlist commit on `main`, plus a second working clone
    /// standing in for the GitHub Actions logger. Returns (remote, work, logger).
    fn remote_with_logger(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let remote = unique_dir(&format!("{tag}-remote"));
        git(&remote, &["init", "--bare", "-q"]);

        let work = unique_dir(&format!("{tag}-work"));
        git(&work, &["init", "-q"]);
        git(&work, &["config", "user.name", "Test"]);
        git(&work, &["config", "user.email", "test@example.com"]);
        git(&work, &["checkout", "-q", "-B", "main"]);
        write_playlist(&work, "road.json", "Road Trip", &["a", "b"]);
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-qm", "init"]);
        git(&work, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&work, &["push", "-qu", "origin", "main"]);

        let logger = unique_dir(&format!("{tag}-logger"));
        git(&logger, &["clone", "-q", remote.to_str().unwrap(), "."]);
        git(&logger, &["config", "user.name", "Logger"]);
        git(&logger, &["config", "user.email", "logger@example.com"]);

        (remote, work, logger)
    }

    fn append_history(dir: &Path, line: &str) {
        std::fs::create_dir_all(dir.join("history")).unwrap();
        let path = dir.join("history").join("plays.jsonl");
        let mut s = std::fs::read_to_string(&path).unwrap_or_default();
        s.push_str(line);
        s.push('\n');
        std::fs::write(&path, s).unwrap();
    }

    #[test]
    fn push_absorbs_logger_commits() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let (remote, work, logger) = remote_with_logger("absorb");

        // The logger appends to its history log and pushes — now the remote is ahead of `work`.
        append_history(&logger, "{\"track_id\":\"a\",\"played_at\":\"t1\"}");
        git(&logger, &["add", "history/plays.jsonl"]);
        git(&logger, &["commit", "-qm", "chore(history): log recently played"]);
        git(&logger, &["push", "-q"]);

        // The user edits a playlist and commits, unaware of the logger's commit.
        write_playlist(&work, "road.json", "Road Trip", &["a", "c"]);
        let s = commit(&work, "Edit Road Trip").unwrap();
        assert_eq!(s.ahead, 1);

        // Push should silently fold in the logger's commit and succeed.
        let out = push(&work).unwrap();
        assert!(out.pushed, "should have pushed");
        assert!(
            out.message.to_lowercase().contains("listening history"),
            "expected a sync note, got: {}",
            out.message
        );

        // In sync, and the work tree now holds the logger's history line too.
        let s = status(&work).unwrap();
        assert_eq!(s.ahead, 0, "pushed → not ahead");
        assert!(work.join("history/plays.jsonl").exists(), "history pulled in");

        let _ = std::fs::remove_dir_all(&work);
        let _ = std::fs::remove_dir_all(&logger);
        let _ = std::fs::remove_dir_all(&remote);
    }

    #[test]
    fn push_rejects_foreign_remote_change() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let (remote, work, other) = remote_with_logger("foreign");

        // Someone (not the logger) changes a playlist on the remote.
        write_playlist(&other, "road.json", "Road Trip", &["a", "b", "z"]);
        git(&other, &["add", "-A"]);
        git(&other, &["commit", "-qm", "Add track on another machine"]);
        git(&other, &["push", "-q"]);

        // Local edit + commit, then push — the remote diverged on a real file, so don't merge.
        write_playlist(&work, "road.json", "Road Trip", &["a", "c"]);
        commit(&work, "Edit Road Trip").unwrap();
        let err = push(&work).unwrap_err();
        assert!(
            err.contains("beyond the listening-history log"),
            "expected a divergence error, got: {err}"
        );
        // The push attempt must not have moved our branch.
        assert_eq!(status(&work).unwrap().ahead, 1, "still one local commit, unpushed");

        let _ = std::fs::remove_dir_all(&work);
        let _ = std::fs::remove_dir_all(&other);
        let _ = std::fs::remove_dir_all(&remote);
    }
}
