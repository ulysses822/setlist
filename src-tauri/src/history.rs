//! Read the listening-history log the poller appends (history/plays.jsonl) and aggregate it
//! into per-track stats for the stale-track view. Read-only — the log itself is produced by
//! the GitHub Actions poller (templates/poll-plays.mjs), never written here.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// One appended play. The log also carries title/artists, but the app already has those from
/// the playlist files, so only the id and timestamp are needed here.
#[derive(Deserialize)]
struct PlayLine {
    track_id: String,
    played_at: String,
}

/// Aggregate plays for one track. `id` is the raw uri (e.g. "spotify:track:…"); the frontend
/// re-keys it with bareId to join against playlist tracks.
#[derive(Serialize)]
pub struct PlayStat {
    pub id: String,
    pub count: u32,
    pub last_played: String,
}

#[derive(Serialize)]
pub struct HistoryReport {
    /// False when history/plays.jsonl doesn't exist yet (logger not set up / no plays).
    pub has_file: bool,
    /// Earliest played_at seen — the start of the tracking window, so the UI can say how far
    /// back "never played" actually looks.
    pub tracked_since: Option<String>,
    pub total_plays: usize,
    pub stats: Vec<PlayStat>,
}

pub fn read_plays(data_dir: &Path) -> Result<HistoryReport, String> {
    let path = data_dir.join("history").join("plays.jsonl");
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HistoryReport {
                has_file: false,
                tracked_since: None,
                total_plays: 0,
                stats: Vec::new(),
            });
        }
        Err(e) => return Err(format!("Couldn't read {}: {e}", path.display())),
    };

    use std::collections::HashMap;
    let mut by_id: HashMap<String, (u32, String)> = HashMap::new();
    let mut tracked_since: Option<String> = None;
    let mut total_plays = 0usize;

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Skip malformed lines rather than failing the whole read.
        let Ok(p) = serde_json::from_str::<PlayLine>(line) else {
            continue;
        };
        total_plays += 1;
        // ISO-8601 timestamps sort correctly as plain strings.
        if tracked_since
            .as_deref()
            .is_none_or(|ts| p.played_at.as_str() < ts)
        {
            tracked_since = Some(p.played_at.clone());
        }
        let entry = by_id.entry(p.track_id).or_insert((0, String::new()));
        entry.0 += 1;
        if p.played_at > entry.1 {
            entry.1 = p.played_at;
        }
    }

    let stats = by_id
        .into_iter()
        .map(|(id, (count, last_played))| PlayStat {
            id,
            count,
            last_played,
        })
        .collect();

    Ok(HistoryReport {
        has_file: true,
        tracked_since,
        total_plays,
        stats,
    })
}

/// One play as the log actually recorded it. `read_plays` above throws title and artists
/// away because the stale view joins against playlist files for those; the log view can't,
/// since its whole point is the plays that have no playlist to join to.
#[derive(Deserialize)]
struct LogLine {
    track_id: String,
    played_at: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    artists: Vec<String>,
}

#[derive(Serialize)]
pub struct Play {
    pub track_id: String,
    pub played_at: String,
    pub title: String,
    pub artists: Vec<String>,
    /// False when no active playlist holds this track. Archived playlists don't count, the
    /// same way they don't anywhere else in the app — archiving one is saying it's out of
    /// the set you curate.
    pub in_library: bool,
}

#[derive(Serialize)]
pub struct PlayLog {
    /// False when history/plays.jsonl doesn't exist yet (logger not set up / no plays).
    pub has_file: bool,
    pub tracked_since: Option<String>,
    pub total_plays: usize,
    /// Newest first, which is the order the view wants and the opposite of the file's.
    pub plays: Vec<Play>,
}

/// Read the whole log as a list of plays, newest first.
///
/// `library_ids` is bare ids (see `track_id::bare_track_id`) of every track in the active
/// playlists. Passed in rather than read here so this stays a pure function of a directory
/// and a set — the composition lives in the command, and the test can hand it a set it made.
pub fn read_log(
    data_dir: &Path,
    library_ids: &std::collections::HashSet<String>,
) -> Result<PlayLog, String> {
    let path = data_dir.join("history").join("plays.jsonl");
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PlayLog {
                has_file: false,
                tracked_since: None,
                total_plays: 0,
                plays: Vec::new(),
            });
        }
        Err(e) => return Err(format!("Couldn't read {}: {e}", path.display())),
    };

    let mut plays: Vec<Play> = Vec::new();
    let mut tracked_since: Option<String> = None;

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Same tolerance as read_plays: an interrupted append can leave one partial line,
        // and losing the whole view over it would be the wrong trade.
        let Ok(p) = serde_json::from_str::<LogLine>(line) else {
            continue;
        };
        if tracked_since
            .as_deref()
            .is_none_or(|ts| p.played_at.as_str() < ts)
        {
            tracked_since = Some(p.played_at.clone());
        }
        let in_library = library_ids.contains(crate::track_id::bare_track_id(&p.track_id));
        plays.push(Play {
            track_id: p.track_id,
            played_at: p.played_at,
            title: p.title,
            artists: p.artists,
            in_library,
        });
    }

    let total_plays = plays.len();
    // The poller appends chronologically, so reversing is enough and beats sorting. It is
    // only "enough" because nothing else writes this file.
    plays.reverse();

    Ok(PlayLog {
        has_file: true,
        tracked_since,
        total_plays,
        plays,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("setlist-hist-{tag}-{nanos}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn missing_file_is_empty_not_an_error() {
        let dir = unique_dir("missing");
        let r = read_plays(&dir).unwrap();
        assert!(
            !r.has_file && r.total_plays == 0 && r.stats.is_empty() && r.tracked_since.is_none()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn aggregates_counts_last_played_and_window() {
        let dir = unique_dir("agg");
        std::fs::create_dir_all(dir.join("history")).unwrap();
        let jsonl = [
            r#"{"track_id":"spotify:track:a","played_at":"2026-01-02T10:00:00Z","title":"A","artists":["X"]}"#,
            r#"{"track_id":"spotify:track:a","played_at":"2026-03-05T12:00:00Z","title":"A","artists":["X"]}"#,
            r#"{"track_id":"spotify:track:b","played_at":"2026-02-01T08:00:00Z","title":"B","artists":["Y"]}"#,
            "", // blank line tolerated
            "{not valid json}", // malformed skipped
        ]
        .join("\n");
        std::fs::write(dir.join("history").join("plays.jsonl"), jsonl).unwrap();

        let r = read_plays(&dir).unwrap();
        assert!(r.has_file);
        assert_eq!(r.total_plays, 3);
        assert_eq!(r.tracked_since.as_deref(), Some("2026-01-02T10:00:00Z"));
        let a = r.stats.iter().find(|s| s.id == "spotify:track:a").unwrap();
        assert_eq!(a.count, 2);
        assert_eq!(a.last_played, "2026-03-05T12:00:00Z");
        let b = r.stats.iter().find(|s| s.id == "spotify:track:b").unwrap();
        assert_eq!(b.count, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn write_log(dir: &std::path::Path, lines: &[&str]) {
        std::fs::create_dir_all(dir.join("history")).unwrap();
        std::fs::write(
            dir.join("history").join("plays.jsonl"),
            format!("{}\n", lines.join("\n")),
        )
        .unwrap();
    }

    fn ids(v: &[&str]) -> std::collections::HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_log_reads_newest_first_with_the_title_the_file_recorded() {
        let dir = unique_dir("logorder");
        write_log(
            &dir,
            &[
                r#"{"track_id":"spotify:track:aaa","played_at":"2026-01-01T10:00:00Z","title":"First","artists":["A"]}"#,
                r#"{"track_id":"spotify:track:bbb","played_at":"2026-01-02T10:00:00Z","title":"Second","artists":["B","C"]}"#,
            ],
        );
        let log = read_log(&dir, &ids(&[])).unwrap();

        assert!(log.has_file);
        assert_eq!(log.total_plays, 2);
        assert_eq!(log.tracked_since.as_deref(), Some("2026-01-01T10:00:00Z"));
        assert_eq!(log.plays[0].title, "Second", "newest first");
        assert_eq!(log.plays[0].artists, vec!["B", "C"]);
        assert_eq!(log.plays[1].title, "First");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The reason the log is its own view: a play can name a track no playlist holds, and
    /// the only record of what it was is the log's own title/artists.
    #[test]
    fn a_play_of_something_outside_the_library_is_marked_as_such() {
        let dir = unique_dir("logjoin");
        write_log(
            &dir,
            &[
                r#"{"track_id":"spotify:track:kept","played_at":"2026-01-01T10:00:00Z","title":"Kept","artists":["A"]}"#,
                r#"{"track_id":"spotify:track:gone","played_at":"2026-01-02T10:00:00Z","title":"Gone","artists":["B"]}"#,
            ],
        );
        // The set holds bare ids, which is what the command builds from the playlists.
        let log = read_log(&dir, &ids(&["kept"])).unwrap();

        let gone = &log.plays[0];
        let kept = &log.plays[1];
        assert_eq!((gone.title.as_str(), gone.in_library), ("Gone", false));
        assert_eq!((kept.title.as_str(), kept.in_library), ("Kept", true));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_partial_last_line_costs_one_play_rather_than_the_whole_log() {
        let dir = unique_dir("logpartial");
        write_log(
            &dir,
            &[
                r#"{"track_id":"spotify:track:aaa","played_at":"2026-01-01T10:00:00Z","title":"Fine","artists":[]}"#,
                r#"{"track_id":"spotify:track:bb"#,
            ],
        );
        let log = read_log(&dir, &ids(&[])).unwrap();
        assert_eq!(log.total_plays, 1);
        assert_eq!(log.plays[0].title, "Fine");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_log_that_does_not_exist_yet_is_not_an_error() {
        let dir = unique_dir("lognofile");
        let log = read_log(&dir, &ids(&[])).unwrap();
        assert!(!log.has_file && log.total_plays == 0 && log.plays.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
