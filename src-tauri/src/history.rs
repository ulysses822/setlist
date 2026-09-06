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
        if tracked_since.as_deref().is_none_or(|ts| p.played_at.as_str() < ts) {
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
        .map(|(id, (count, last_played))| PlayStat { id, count, last_played })
        .collect();

    Ok(HistoryReport {
        has_file: true,
        tracked_since,
        total_plays,
        stats,
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
        assert!(!r.has_file && r.total_plays == 0 && r.stats.is_empty() && r.tracked_since.is_none());
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
}
