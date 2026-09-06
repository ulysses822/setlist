//! Audio-feature metrics.
//!
//! Spotify deprecated its audio-features endpoint for new apps, so features come from
//! ReccoBeats (no API key). Two steps: resolve Spotify IDs -> ReccoBeats IDs in batches,
//! then fetch per-track features. Everything is cached by Spotify ID in
//! `<data_dir>/cache/audio-features.json` so each track is only fetched once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const RECCO: &str = "https://api.reccobeats.com/v1";

#[derive(Deserialize, Serialize, Clone)]
pub struct Features {
    pub acousticness: f64,
    pub danceability: f64,
    pub energy: f64,
    pub instrumentalness: f64,
    pub liveness: f64,
    pub loudness: f64,
    pub speechiness: f64,
    pub tempo: f64,
    pub valence: f64,
    pub key: i64,
    pub mode: i64,
}

// --- ReccoBeats response shapes ---

#[derive(Deserialize)]
struct ResolveResp {
    #[serde(default)]
    content: Vec<ResolveItem>,
}

#[derive(Deserialize)]
struct ResolveItem {
    id: String,
    #[serde(default)]
    href: String,
    #[serde(default)]
    isrc: Option<String>,
}

// --- cache ---

fn load_cache(path: &Path) -> HashMap<String, Features> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_cache(path: &Path, cache: &HashMap<String, Features>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cache).map_err(|e| e.to_string())?;
    crate::spotify::write_atomic(path, &json)
}

// --- negative cache ---
//
// ReccoBeats doesn't cover every release (very new, obscure, or classical/instrumental
// tracks are often missing). Rather than re-poll those on every open, we remember when a
// track came back empty and skip it until the entry goes stale — then we try once more, in
// case it has since been added. Stored as bare Spotify id -> RFC3339 timestamp of last
// attempt in `<data_dir>/cache/audio-features-misses.json`.

const MISS_TTL_DAYS: i64 = 7;

fn load_misses(path: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_misses(path: &Path, misses: &HashMap<String, String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(misses).map_err(|e| e.to_string())?;
    crate::spotify::write_atomic(path, &json)
}

/// True if `key` was polled and came back empty within the last `MISS_TTL_DAYS` — i.e. it's
/// too soon to retry. A missing or unparseable timestamp counts as "due for a retry".
fn recently_missed(
    misses: &HashMap<String, String>,
    key: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    misses
        .get(key)
        .and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
        .map(|t| now.signed_duration_since(t.with_timezone(&chrono::Utc)) < chrono::Duration::days(MISS_TTL_DAYS))
        .unwrap_or(false)
}

/// "spotify:track:ABC" -> "ABC"; also tolerates a bare id. Local files
/// (spotify:local:…) have no track id — their last segment is the duration, which collides
/// across songs — so the whole URI is their identity.
fn bare_id(uri: &str) -> Option<String> {
    if uri.starts_with("spotify:local:") {
        return Some(uri.to_string());
    }
    uri.rsplit(':').next().filter(|s| !s.is_empty()).map(str::to_string)
}

fn spotify_id_from_href(href: &str) -> Option<String> {
    href.rsplit('/').next().filter(|s| !s.is_empty()).map(str::to_string)
}

async fn fetch_features(http: &reqwest::Client, reccobeats_id: &str) -> Option<Features> {
    let url = format!("{RECCO}/track/{reccobeats_id}/audio-features");
    let resp = http.get(&url).header("Accept", "application/json").send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Features>().await.ok()
}

/// Ensure audio features for the given tracks are cached, fetching any that are missing,
/// and return a map of bare Spotify id -> Features for every track we have data for.
///
/// `tracks` is a list of `(spotify uri or id, optional ISRC)`. The cache key is the bare
/// Spotify id; the query token is the ISRC when available (release-independent, far better
/// coverage) or else the Spotify id. Shared by the full-playlist `compute` path and the
/// incremental per-track fetch used when a track is added in the editor.
/// In-memory copy of the on-disk feature caches. One async lock guards it and also
/// serializes the whole load-fetch-save cycle: the editor fires incremental fetches while
/// a playlist open may still be resolving, and two concurrent read-modify-writes would
/// silently drop whichever finished first. Loaded once per data dir (the JSON grows with
/// the library, so re-parsing it on every call gets expensive); disk writes only happen
/// when something was actually fetched.
struct FeatureCaches {
    dir: PathBuf,
    features: HashMap<String, Features>,
    misses: HashMap<String, String>,
}

static CACHES: tokio::sync::Mutex<Option<FeatureCaches>> = tokio::sync::Mutex::const_new(None);

pub async fn features_for(
    http: &reqwest::Client,
    data_dir: PathBuf,
    tracks: &[(String, Option<String>)],
) -> Result<HashMap<String, Features>, String> {
    let mut guard = CACHES.lock().await;
    let cache_dir = data_dir.join("cache");
    if guard.as_ref().map(|c| c.dir != cache_dir).unwrap_or(true) {
        *guard = Some(FeatureCaches {
            features: load_cache(&cache_dir.join("audio-features.json")),
            misses: load_misses(&cache_dir.join("audio-features-misses.json")),
            dir: cache_dir,
        });
    }
    let caches = guard.as_mut().expect("initialized above");
    let now = chrono::Utc::now();

    // Which tracks still need features? Map responses back via ISRC first, then Spotify href.
    // Skip ones we already have, and ones we polled (and came up empty) within the TTL.
    let mut needs_tokens: Vec<String> = Vec::new();
    let mut attempted: Vec<String> = Vec::new(); // cache keys we're about to (re)poll
    let mut by_isrc: HashMap<String, String> = HashMap::new(); // isrc -> cache key
    let mut by_sid: HashMap<String, String> = HashMap::new(); // spotify id -> cache key
    for (id, isrc) in tracks {
        let Some(key) = bare_id(id) else { continue };
        if caches.features.contains_key(&key) || recently_missed(&caches.misses, &key, now) {
            continue;
        }
        attempted.push(key.clone());
        by_sid.insert(key.clone(), key.clone());
        let token = match isrc.as_deref() {
            Some(i) if !i.is_empty() => {
                by_isrc.insert(i.to_string(), key.clone());
                i.to_string()
            }
            _ => key.clone(),
        };
        needs_tokens.push(token);
    }

    if !needs_tokens.is_empty() {
        // 1. Resolve tokens (ISRCs and/or Spotify IDs) -> ReccoBeats IDs (batched).
        let mut resolved: HashMap<String, String> = HashMap::new(); // cache key -> reccobeats id
        let mut any_resolve_ok = false; // did ReccoBeats actually respond? (vs. an outage)
        for chunk in needs_tokens.chunks(40) {
            let query = chunk
                .iter()
                .map(|tok| format!("ids={tok}"))
                .collect::<Vec<_>>()
                .join("&");
            let url = format!("{RECCO}/track?{query}");
            if let Ok(resp) = http.get(&url).header("Accept", "application/json").send().await {
                if let Ok(rr) = resp.json::<ResolveResp>().await {
                    any_resolve_ok = true;
                    for item in rr.content {
                        let key = item
                            .isrc
                            .as_deref()
                            .and_then(|i| by_isrc.get(i))
                            .or_else(|| spotify_id_from_href(&item.href).and_then(|s| by_sid.get(&s)))
                            .cloned();
                        if let Some(k) = key {
                            // Same ISRC can return several releases — keep the first.
                            resolved.entry(k).or_insert(item.id);
                        }
                    }
                }
            }
        }

        // 2. Fetch features with bounded concurrency (~8 at a time).
        let mut fetched_any = false;
        let pairs: Vec<(String, String)> = resolved.into_iter().collect();
        for chunk in pairs.chunks(8) {
            let mut handles = Vec::new();
            for (key, rid) in chunk {
                let client = http.clone();
                let key = key.clone();
                let rid = rid.clone();
                handles.push(tauri::async_runtime::spawn(async move {
                    (key, fetch_features(&client, &rid).await)
                }));
            }
            for h in handles {
                if let Ok((key, Some(f))) = h.await {
                    caches.features.insert(key, f);
                    fetched_any = true;
                }
            }
        }

        if fetched_any {
            let _ = save_cache(&caches.dir.join("audio-features.json"), &caches.features);
        }

        // Record the outcome of this poll in the negative cache — but only if ReccoBeats
        // actually answered. (If the whole service was unreachable, don't punish every track
        // with a week-long miss for what was really an outage.) A track that now resolved is
        // cleared from the miss list; one that's still empty gets a fresh timestamp.
        if any_resolve_ok {
            let stamp = now.to_rfc3339();
            for key in &attempted {
                if caches.features.contains_key(key) {
                    caches.misses.remove(key);
                } else {
                    caches.misses.insert(key.clone(), stamp.clone());
                }
            }
            let _ = save_misses(
                &caches.dir.join("audio-features-misses.json"),
                &caches.misses,
            );
        }
    }

    // Collect cache hits for the requested tracks (keyed by bare Spotify id).
    let mut out = HashMap::new();
    for (id, _) in tracks {
        if let Some(key) = bare_id(id) {
            if let Some(f) = caches.features.get(&key) {
                out.insert(key, f.clone());
            }
        }
    }
    Ok(out)
}

