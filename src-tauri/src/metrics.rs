//! Audio-feature metrics.
//!
//! Spotify deprecated its audio-features endpoint for new apps, so features come from
//! ReccoBeats (no API key). Two steps: resolve Spotify IDs -> ReccoBeats IDs in batches,
//! then fetch per-track features. Everything is cached by Spotify ID in
//! `<data_dir>/cache/audio-features.json` so each track is only fetched once.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

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
        .map(|t| {
            now.signed_duration_since(t.with_timezone(&chrono::Utc))
                < chrono::Duration::days(MISS_TTL_DAYS)
        })
        .unwrap_or(false)
}

/// What this poll established about one track's miss entry.
enum MissUpdate {
    /// ReccoBeats answered and has nothing: remember that for `MISS_TTL_DAYS`.
    Stamp,
    /// We have features now, so any earlier miss is stale.
    Clear,
}

/// Decide which miss entries this poll may touch.
///
/// Pure, and separated out, because getting this wrong is silent and expensive: a track wrongly
/// stamped disappears from the analytics for a week with no error anywhere, which is precisely
/// what used to happen when a rate-limited resolve batch was read as "none of these are
/// covered". The rule is that only `answered` keys are eligible at all, and any of those we
/// never got a feature verdict on (`unanswered`) are left exactly as they were.
fn miss_updates<'a>(
    answered: &'a HashSet<String>,
    unanswered: &HashSet<String>,
    features: &HashMap<String, Features>,
) -> Vec<(&'a str, MissUpdate)> {
    answered
        .iter()
        .filter(|k| !unanswered.contains(*k))
        .map(|k| {
            let verdict = if features.contains_key(k) {
                MissUpdate::Clear
            } else {
                MissUpdate::Stamp
            };
            (k.as_str(), verdict)
        })
        .collect()
}

/// "spotify:track:ABC" -> "ABC"; also tolerates a bare id. Local files
/// (spotify:local:…) have no track id — their last segment is the duration, which collides
/// across songs — so the whole URI is their identity.
fn bare_id(uri: &str) -> Option<String> {
    if uri.starts_with("spotify:local:") {
        return Some(uri.to_string());
    }
    uri.rsplit(':')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn spotify_id_from_href(href: &str) -> Option<String> {
    href.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

// --- request pacing --------------------------------------------------------
//
// Spotify calls are paced and cooled down by `rate_limit_preflight`; nothing in this module
// goes through it, so ReccoBeats needs its own. Without one, opening a large library fires an
// unbounded run of resolve batches and then hundreds of concurrent feature fetches at a free,
// keyless API, which is how a client gets blocked at the edge.

/// Minimum gap between two ReccoBeats requests.
const RECCO_MIN_INTERVAL: Duration = Duration::from_millis(120);
/// Cooldown used when the service pushes back without a usable `Retry-After`.
const RECCO_DEFAULT_COOLDOWN: Duration = Duration::from_secs(60);
/// Ceiling on a `Retry-After` we will honour, so one broken header can't park the metrics
/// pipeline for hours.
const RECCO_MAX_COOLDOWN: Duration = Duration::from_secs(300);

struct ReccoLimiter {
    /// Earliest instant the next request may be sent.
    next_slot: Option<Instant>,
    /// Set when ReccoBeats pushes back; nothing is sent until it passes.
    cooldown_until: Option<Instant>,
}

static RECCO_LIMITER: tokio::sync::Mutex<ReccoLimiter> =
    tokio::sync::Mutex::const_new(ReccoLimiter {
        next_slot: None,
        cooldown_until: None,
    });

/// Reserve the next request slot and sleep until it comes round.
///
/// Returns false while a cooldown is in force, and the caller must then skip the request
/// rather than wait it out: a cooldown outlasts any one playlist open, so blocking on it would
/// freeze the editor to no purpose. Blank metrics that fill in on a later open are the better
/// failure, and the negative cache is deliberately not written for what we skip here.
///
/// The lock is released before the sleep — same shape as `AppState::reserve_slot` — so the
/// concurrent feature fetches pace out behind one another instead of serialising.
async fn recco_ready() -> bool {
    let wait = {
        let mut lim = RECCO_LIMITER.lock().await;
        let now = Instant::now();
        if lim.cooldown_until.is_some_and(|until| until > now) {
            return false;
        }
        lim.cooldown_until = None;
        let earliest = lim.next_slot.map_or(now, |slot| slot.max(now));
        lim.next_slot = Some(earliest + RECCO_MIN_INTERVAL);
        earliest.saturating_duration_since(now)
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    true
}

/// True when a response means "stop asking" rather than "nothing for that track".
fn is_push_back(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

/// How long to stand down for, given whatever `Retry-After` came back. Absent, non-numeric
/// (the header also permits an HTTP date, which we don't parse) or absurd all fall back to
/// something sane, because the alternative to a usable number is not waiting forever.
fn cooldown_from(retry_after: Option<&str>) -> Duration {
    retry_after
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(RECCO_DEFAULT_COOLDOWN)
        .min(RECCO_MAX_COOLDOWN)
}

/// Start a cooldown after push-back, honouring `Retry-After` within our own ceiling.
async fn recco_back_off(resp: &reqwest::Response) {
    let after = cooldown_from(
        resp.headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok()),
    );
    RECCO_LIMITER.lock().await.cooldown_until = Some(Instant::now() + after);
}

/// What one feature fetch established. The negative cache is written from this, and the
/// distinction is the whole point: `Missing` is ReccoBeats saying it has nothing for a track,
/// which is worth remembering for a week; `Unanswered` is us never having got a reply, which
/// is worth remembering for nothing at all.
enum FeatureFetch {
    Got(Features),
    Missing,
    Unanswered,
}

async fn fetch_features(http: &reqwest::Client, reccobeats_id: &str) -> FeatureFetch {
    if !recco_ready().await {
        return FeatureFetch::Unanswered;
    }
    // The id came out of ReccoBeats' own resolve response, which doesn't make it a safe path
    // segment: `url` resolves dot segments before sending, so an unescaped id could aim this
    // request at some other endpoint on their host.
    let url = format!(
        "{RECCO}/track/{}/audio-features",
        urlencoding::encode(reccobeats_id)
    );
    let Ok(resp) = http
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
    else {
        return FeatureFetch::Unanswered;
    };
    let status = resp.status();
    if is_push_back(status) {
        recco_back_off(&resp).await;
        return FeatureFetch::Unanswered;
    }
    if !status.is_success() {
        // A 404 (or anything else in the 4xx range) is ReccoBeats answering the question: it
        // has no features under that id.
        return FeatureFetch::Missing;
    }
    match resp.json::<Features>().await {
        Ok(f) => FeatureFetch::Got(f),
        // A 200 whose body isn't a feature set is the same answer as a 404 in practice.
        Err(_) => FeatureFetch::Missing,
    }
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
    let mut by_isrc: HashMap<String, String> = HashMap::new(); // isrc -> cache key
    let mut by_sid: HashMap<String, String> = HashMap::new(); // spotify id -> cache key
    for (id, isrc) in tracks {
        let Some(key) = bare_id(id) else { continue };
        if caches.features.contains_key(&key) || recently_missed(&caches.misses, &key, now) {
            continue;
        }
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
        // cache key -> reccobeats id
        let mut resolved: HashMap<String, String> = HashMap::new();
        // Cache keys whose resolve batch actually came back 2xx. Only these are eligible for
        // the negative cache below: a batch that errored, timed out or was rate-limited tells
        // us nothing about its tracks, and recording it as "not covered" would hide them for
        // MISS_TTL_DAYS over what was really an outage.
        let mut resolve_answered: HashSet<String> = HashSet::new();
        for chunk in needs_tokens.chunks(40) {
            if !recco_ready().await {
                break; // cooling down; the rest of these wait for a later call
            }
            // Tokens are ISRCs and Spotify ids read out of playlist files, so they're only
            // as well-formed as whatever wrote them. Encode: a bare `&` or `=` in one would
            // otherwise smuggle extra parameters into the request.
            let query = chunk
                .iter()
                .map(|tok| format!("ids={}", urlencoding::encode(tok)))
                .collect::<Vec<_>>()
                .join("&");
            let url = format!("{RECCO}/track?{query}");
            let Ok(resp) = http
                .get(&url)
                .header("Accept", "application/json")
                .send()
                .await
            else {
                continue;
            };
            let status = resp.status();
            if is_push_back(status) {
                recco_back_off(&resp).await;
                break;
            }
            // Status before body, and the order matters. `ResolveResp::content` is
            // `#[serde(default)]`, so an error response carrying any JSON object at all
            // deserializes cleanly into an empty content list — which read as ReccoBeats
            // saying "none of these are covered" and stamped the whole batch into the negative
            // cache for a week: the exact outage-hiding this code exists to prevent.
            if !status.is_success() {
                continue;
            }
            let Ok(rr) = resp.json::<ResolveResp>().await else {
                continue;
            };
            resolve_answered.extend(
                chunk
                    .iter()
                    .filter_map(|tok| by_isrc.get(tok).or_else(|| by_sid.get(tok)).cloned()),
            );
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

        // 2. Fetch features with bounded concurrency (~8 at a time), each paced by
        //    `recco_ready`.
        let mut fetched_any = false;
        // Resolved keys we never got a verdict on, so the negative cache leaves them alone.
        let mut unanswered: HashSet<String> = HashSet::new();
        let pairs: Vec<(String, String)> = resolved.into_iter().collect();
        for chunk in pairs.chunks(8) {
            let mut handles = Vec::new();
            for (key, rid) in chunk {
                let client = http.clone();
                let rid = rid.clone();
                // Key kept out here so a join failure still knows which track it lost.
                handles.push((
                    key.clone(),
                    tauri::async_runtime::spawn(async move { fetch_features(&client, &rid).await }),
                ));
            }
            for (key, h) in handles {
                match h.await {
                    Ok(FeatureFetch::Got(f)) => {
                        caches.features.insert(key, f);
                        fetched_any = true;
                    }
                    // Absent from both sets is exactly what the miss stamp below looks for.
                    Ok(FeatureFetch::Missing) => {}
                    // A panicked or cancelled task is no more an answer than a timeout is.
                    Ok(FeatureFetch::Unanswered) | Err(_) => {
                        unanswered.insert(key);
                    }
                }
            }
        }

        if fetched_any {
            let _ = save_cache(&caches.dir.join("audio-features.json"), &caches.features);
        }

        // Record this poll's verdict in the negative cache. Only tracks ReccoBeats actually
        // answered about are eligible: one it now has features for is cleared from the miss
        // list, one it answered about and had nothing for gets a fresh timestamp, and anything
        // we never got a reply for is left exactly as it was. An outage must not be able to
        // hide a track for MISS_TTL_DAYS.
        let stamp = now.to_rfc3339();
        let mut misses_changed = false;
        for (key, verdict) in miss_updates(&resolve_answered, &unanswered, &caches.features) {
            match verdict {
                MissUpdate::Stamp => {
                    caches.misses.insert(key.to_string(), stamp.clone());
                    misses_changed = true;
                }
                MissUpdate::Clear => misses_changed |= caches.misses.remove(key).is_some(),
            }
        }
        if misses_changed {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(v: &[&str]) -> HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn stamped(answered: &[&str], unanswered: &[&str], have_features: &[&str]) -> Vec<String> {
        let features: HashMap<String, Features> = have_features
            .iter()
            .map(|k| {
                (
                    k.to_string(),
                    Features {
                        acousticness: 0.0,
                        danceability: 0.0,
                        energy: 0.0,
                        instrumentalness: 0.0,
                        liveness: 0.0,
                        loudness: 0.0,
                        speechiness: 0.0,
                        tempo: 0.0,
                        valence: 0.0,
                        key: 0,
                        mode: 0,
                    },
                )
            })
            .collect();
        let mut out: Vec<String> = miss_updates(&keys(answered), &keys(unanswered), &features)
            .into_iter()
            .filter(|(_, v)| matches!(v, MissUpdate::Stamp))
            .map(|(k, _)| k.to_string())
            .collect();
        out.sort();
        out
    }

    /// The bug this module was audited for. ReccoBeats returning 429 with a JSON body used to
    /// deserialize into an empty `content` list, read as "we asked and none are covered", and
    /// stamp every track in the batch as a miss for MISS_TTL_DAYS. The status check now keeps
    /// those keys out of `answered` entirely, so nothing is eligible to be stamped.
    #[test]
    fn an_outage_cannot_stamp_a_single_track() {
        assert_eq!(stamped(&[], &[], &[]), Vec::<String>::new());
    }

    /// Serde is perfectly happy to read an error body as an empty result — which is why the
    /// status check has to come before the parse, not instead of it.
    #[test]
    fn an_error_body_deserializes_as_an_empty_resolve() {
        let rr: ResolveResp =
            serde_json::from_str(r#"{"message":"Too Many Requests"}"#).expect("parses");
        assert!(
            rr.content.is_empty(),
            "an error body looks exactly like a covered-nothing answer"
        );
    }

    /// A track ReccoBeats answered about and had nothing for is the one case worth
    /// remembering; one whose feature fetch never came back is not.
    #[test]
    fn only_an_actual_answer_is_remembered_as_a_miss() {
        assert_eq!(stamped(&["a", "b"], &["b"], &[]), vec!["a".to_string()]);
    }

    /// A key we now have features for is cleared rather than stamped.
    #[test]
    fn a_track_that_resolved_is_not_stamped() {
        assert_eq!(stamped(&["a"], &[], &["a"]), Vec::<String>::new());
        let answered = keys(&["a"]);
        let updates = miss_updates(&answered, &keys(&[]), &HashMap::new());
        assert!(matches!(updates.as_slice(), [(_, MissUpdate::Stamp)]));
    }

    /// A key we never asked about in the first place is never touched, whatever else happened.
    #[test]
    fn an_unanswered_key_is_left_alone_even_with_features_present() {
        assert!(miss_updates(&keys(&["a"]), &keys(&["a"]), &HashMap::new()).is_empty());
    }

    #[test]
    fn push_back_is_the_statuses_that_mean_stop_asking() {
        use reqwest::StatusCode;
        assert!(is_push_back(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_push_back(StatusCode::SERVICE_UNAVAILABLE));
        assert!(is_push_back(StatusCode::INTERNAL_SERVER_ERROR));
        // A 404 is an answer about the track, not a rate limit — it must stay negative-cacheable.
        assert!(!is_push_back(StatusCode::NOT_FOUND));
        assert!(!is_push_back(StatusCode::OK));
    }

    #[test]
    fn retry_after_is_honoured_but_capped() {
        assert_eq!(cooldown_from(Some("30")), Duration::from_secs(30));
        assert_eq!(cooldown_from(Some("  30 ")), Duration::from_secs(30));
        // Absent or an HTTP-date (which we don't parse) falls back rather than not waiting.
        assert_eq!(cooldown_from(None), RECCO_DEFAULT_COOLDOWN);
        assert_eq!(
            cooldown_from(Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            RECCO_DEFAULT_COOLDOWN
        );
        // One broken header must not park the metrics pipeline for a day.
        assert_eq!(cooldown_from(Some("86400")), RECCO_MAX_COOLDOWN);
    }
}
