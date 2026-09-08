//! OAuth: the Authorization Code + PKCE login, token refresh, the keychain-held refresh
//! tokens, and the localhost loopback catcher. Also the separate confidential-flow grant used
//! to mint the history poller's non-rotating token.
//!
//! Flow: generate a PKCE verifier/challenge, open the system browser to Spotify's consent
//! page, catch the redirect on a localhost loopback server, exchange the code for tokens,
//! stash the refresh token in the OS keychain, and cache the access token in memory.
//!
//! Two token families live side by side:
//! - the **main** family carries every scope the backend needs and never crosses IPC;
//! - the **streaming** family carries only what the Web Playback SDK needs and is the only
//!   token ever handed to the webview (see `ensure_streaming_token`), so a compromised
//!   frontend can play music but can't read or modify playlists.
//!
//! The separation holds unconditionally: there is no path by which a main-family token
//! reaches the webview. When the streaming grant is missing, playback fails and says so
//! rather than borrowing the main token.

use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::Rng;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{err, get_json, AppState, CachedToken, Profile, ProfileResp, API};

const REDIRECT_URI: &str = "http://127.0.0.1:8888/callback";
const LISTEN_ADDR: &str = "127.0.0.1:8888";
/// The path half of `REDIRECT_URI`, which is the only path the loopback catcher answers on.
/// A test below asserts the two agree — change one without the other and every callback is
/// rejected, which looks like a hung login rather than a typo.
const REDIRECT_PATH: &str = "/callback";
const AUTH_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
/// Scopes for the backend's own (main) token. Deliberately excludes `streaming`, which only
/// the SDK token needs — see `STREAMING_SCOPES`.
const SCOPES: &str = "user-read-private user-read-email playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public user-top-read user-read-recently-played user-read-playback-state user-modify-playback-state";
/// Exactly what the Web Playback SDK requires, nothing more.
const STREAMING_SCOPES: &str = "streaming user-read-email user-read-private";

// keyring composes a Windows Credential Manager target as `<user>.<service>`, and the
// uninstaller has to name those targets as literal strings because NSIS can't read Rust
// constants (`src-tauri/nsis/hooks.nsh`). A test below holds the two in step: rename one of
// these without editing the hook and an uninstall silently orphans the credential forever,
// having just told the user it removed the saved login.
const KEYRING_SERVICE: &str = "setlist";
const KEYRING_USER: &str = "spotify-refresh-token";
const KEYRING_USER_STREAMING: &str = "spotify-streaming-refresh-token";

/// The loopback redirect URI to register in the Spotify dashboard.
pub const REGISTERED_REDIRECT: &str = REDIRECT_URI;

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
    /// Space-delimited scopes Spotify actually granted (may differ from requested).
    #[serde(default)]
    scope: Option<String>,
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

fn random_string(len: usize) -> String {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| CHARSET[rng.gen_range(0..CHARSET.len())] as char)
        .collect()
}

fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

// ---------------------------------------------------------------------------
// Keychain (refresh token) helpers
// ---------------------------------------------------------------------------

// Windows-only, enforced here rather than left to surface at runtime. With no backend
// feature compiled in, keyring v3 doesn't error -- it swaps in an in-memory mock, so login
// would look like it worked and the token would be gone by the next restart. "Platform
// support" in the README covers what porting involves.
#[cfg(not(windows))]
compile_error!(concat!(
    "Setlist supports Windows only: without keyring's windows-native backend the refresh ",
    "token lands in a mock that forgets it. See \"Platform support\" in the README."
));

fn keyring_entry(user: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, user).map_err(err)
}

fn store_refresh_token(user: &str, token: &str) -> Result<(), String> {
    keyring_entry(user)?.set_password(token).map_err(err)
}

fn load_refresh_token(user: &str) -> Result<Option<String>, String> {
    match keyring_entry(user)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn delete_refresh_token(user: &str) -> Result<(), String> {
    match keyring_entry(user)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn has_refresh_token() -> bool {
    matches!(load_refresh_token(KEYRING_USER), Ok(Some(_)))
}

pub fn logout() -> Result<(), String> {
    delete_refresh_token(KEYRING_USER)?;
    delete_refresh_token(KEYRING_USER_STREAMING)
}

// ---------------------------------------------------------------------------
// Loopback redirect catcher (blocking; run via spawn_blocking)
// ---------------------------------------------------------------------------

fn wait_for_code(server: &tiny_http::Server, expected_state: &str) -> Result<String, String> {
    // Bound the wait: an abandoned login (browser tab closed without authorizing) must not
    // block this thread forever — that would pin port 8888 (so every retry fails to bind)
    // and leave the login command, and the Setup buttons, stuck permanently.
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        let request = match server.recv_timeout(Duration::from_secs(1)) {
            Ok(Some(r)) => r,
            Ok(None) => {
                if Instant::now() >= deadline {
                    return Err(
                        "Login timed out — no response from Spotify within 5 minutes. Try connecting again.".into(),
                    );
                }
                continue;
            }
            // Also the exit path when the caller `unblock()`s an aborted login.
            Err(e) => return Err(format!("Loopback server error: {e}")),
        };
        let url = request.url().to_string(); // e.g. "/callback?code=...&state=..."
                                             // Answer only on the registered redirect path, carrying a query. Everything else on
                                             // this port — a browser's /favicon.ico, a drive-by page probing localhost — gets the
                                             // neutral holding page and is ignored, without disturbing the login in progress.
        let Some(query) = url
            .split_once('?')
            .filter(|(path, _)| *path == REDIRECT_PATH)
            .map(|(_, query)| query)
        else {
            let _ = request.respond(tiny_http::Response::from_string("Waiting for Spotify..."));
            continue;
        };

        let (mut code, mut state, mut error) = (None, None, None);
        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            let key = kv.next().unwrap_or("");
            let raw = kv.next().unwrap_or("");
            // Percent-decode: auth codes are URL-safe today, but a future `%xx` in one must
            // not break the token exchange with a confusing "invalid code" error.
            let val = urlencoding::decode(raw)
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| raw.to_string());
            match key {
                "code" => code = Some(val),
                "state" => state = Some(val),
                "error" => error = Some(val),
                _ => {}
            }
        }

        // Only trust a callback carrying the state token we generated for this login.
        // Anything else (a stray local request, a drive-by web page probing the port)
        // is answered neutrally and ignored — it must not abort the real login.
        if state.as_deref() != Some(expected_state) {
            let _ = request.respond(tiny_http::Response::from_string("Waiting for Spotify..."));
            continue;
        }

        let body = "<!doctype html><html><body style=\"font-family:sans-serif;background:#0d1117;color:#e6edf3;text-align:center;padding-top:80px\"><h2 style=\"color:#1db954\">Setlist connected &check;</h2><p>You can close this tab and return to the app.</p></body></html>";
        let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html"[..])
            .expect("valid header");
        let _ = request.respond(tiny_http::Response::from_string(body).with_header(header));

        if let Some(e) = error {
            return Err(format!("Spotify denied authorization: {e}"));
        }
        return match code {
            Some(c) => Ok(c),
            None => Err("Callback contained no authorization code.".into()),
        };
    }
}

/// Open `auth_url` in the system browser and wait for Spotify's redirect, returning the
/// authorization code. Binds the loopback server *before* opening the browser so we can
/// never miss the redirect and a bind failure (e.g. another login already in progress)
/// surfaces immediately — and if the browser can't be opened, the catcher is unblocked so
/// port 8888 is freed for a retry instead of pinned for the full 5-minute timeout.
async fn authorize_via_browser(auth_url: String, csrf: String) -> Result<String, String> {
    let server = std::sync::Arc::new(tiny_http::Server::http(LISTEN_ADDR).map_err(|e| {
        format!("Cannot bind {LISTEN_ADDR}: {e} — is another Spotify login already in progress?")
    })?);
    let catcher = {
        let server = server.clone();
        tauri::async_runtime::spawn_blocking(move || wait_for_code(&server, &csrf))
    };

    if let Err(e) = open::that(&auth_url) {
        server.unblock();
        return Err(format!("Failed to open browser: {e}"));
    }

    catcher.await.map_err(err)?
}

// ---------------------------------------------------------------------------
// Token acquisition / refresh
// ---------------------------------------------------------------------------

async fn store_access(state: &AppState, token: &TokenResponse) {
    let expires_at = Instant::now() + Duration::from_secs(token.expires_in.saturating_sub(60));
    *state.token.lock().await = Some(CachedToken {
        value: token.access_token.clone(),
        expires_at,
    });
    if token.scope.is_some() {
        *state.granted_scope.lock().await = token.scope.clone();
    }
}

/// Shown when there is no main-family refresh token at all: nothing that talks to Spotify runs.
///
/// None of the messages in this module name a click, and a test below pins that. Connecting
/// means going to Setup, starting an authorization, approving it in a browser and coming back.
/// Naming one click undersells it, and leaves someone hunting for a button that isn't on the
/// screen they're looking at — which is exactly what happens when the message is read from the
/// Library tab, where most of them surface.
pub(crate) const NOT_CONNECTED: &str =
    "Not connected to Spotify. Connect your account from the Setup tab.";

/// What the webview is told when we have no streaming grant to give it. Playback is the only
/// thing affected; every other feature runs off the main token, which stays in this process.
pub(crate) const NO_STREAMING_GRANT: &str =
    "In-app playback isn't authorized yet — connect your account from the Setup tab to grant \
     it. Everything else works without it.";

/// Everything that differs between the two token families.
///
/// The families are deliberately separate (see the module docs): the main one carries every
/// scope the backend needs and never crosses IPC, the streaming one carries only what the Web
/// Playback SDK needs and is the only token the webview ever sees. Naming the differences in
/// one value means the refresh mechanism is written once, so a later change to how refreshing
/// works — a backoff, a scope assertion — lands on both families or neither. Two hand-kept
/// copies could drift silently, and one of these is the boundary the webview sits behind.
struct Family {
    /// Keychain entry holding this family's refresh token.
    user: &'static str,
    /// Reported when there is no stored refresh token at all.
    missing: &'static str,
    /// Reported when Spotify says the stored token is dead.
    revoked: &'static str,
    /// Prefixes an otherwise-unexplained HTTP failure.
    label: &'static str,
    /// Whether a granted-scope response is recorded on `AppState` (only the main family's
    /// scope is ever inspected — see `probe_write`).
    records_scope: bool,
    /// Whether a dead token takes the other family down with it. The main token going means
    /// the whole session is gone; the streaming one going leaves everything but playback.
    revokes_everything: bool,
}

const MAIN: Family = Family {
    user: KEYRING_USER,
    missing: NOT_CONNECTED,
    revoked: "Spotify session expired or was revoked — reconnect your account from the Setup tab.",
    label: "Token refresh failed",
    records_scope: true,
    revokes_everything: true,
};

const STREAMING: Family = Family {
    user: KEYRING_USER_STREAMING,
    missing: NO_STREAMING_GRANT,
    revoked: "Playback session expired — reconnect Spotify in Setup to restore in-app playback.",
    label: "Streaming token refresh failed",
    records_scope: false,
    revokes_everything: false,
};

// The parts of the two families that are decidable at compile time, so getting them wrong
// fails the build rather than waiting for someone to run the tests. The rest of the
// separation (distinct keychain entries, distinct messages) is asserted in the tests below,
// where string comparison is available.
const _: () = assert!(
    MAIN.revokes_everything,
    "the main token is the session: losing it must clear the streaming family too"
);
const _: () = assert!(
    !STREAMING.revokes_everything,
    "a dead player must not log the whole app out"
);
const _: () = assert!(
    MAIN.records_scope && !STREAMING.records_scope,
    "probe_write reads the main family's granted scope; the streaming one would overwrite it"
);

/// Return a valid access token for `family`, refreshing from its stored refresh token if needed.
///
/// `cache` is that family's slot on `AppState`, and its mutex is held across the whole refresh
/// (single-flight): if several commands need a token at once, only the first refreshes and the
/// rest wait for it. That matters because Spotify rotates refresh tokens — two concurrent
/// refreshes would reuse the same one, trip reuse detection, and invalidate the whole family.
async fn ensure(
    state: &AppState,
    client_id: &str,
    family: &Family,
    cache: &tokio::sync::Mutex<Option<CachedToken>>,
) -> Result<String, String> {
    let mut guard = cache.lock().await;
    if let Some(t) = guard.as_ref() {
        if Instant::now() < t.expires_at {
            return Ok(t.value.clone());
        }
    }

    let refresh = load_refresh_token(family.user)?.ok_or_else(|| family.missing.to_string())?;

    let resp = state
        .http
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("client_id", client_id),
        ])
        .send()
        .await
        .map_err(err)?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // `invalid_grant` means the refresh token itself is dead (revoked from the dashboard,
        // password change, or rotation reuse) — it can never work again. Drop it so the UI
        // stops looking "connected" and asks for a fresh login instead of erroring forever.
        if body.contains("invalid_grant") {
            if family.revokes_everything {
                let _ = logout();
            } else {
                // Only this family is dead — leave the other alone; the next Connect re-mints it.
                let _ = delete_refresh_token(family.user);
            }
            return Err(family.revoked.to_string());
        }
        return Err(format!("{} (HTTP {status}): {}", family.label, body.trim()));
    }
    let token: TokenResponse = resp.json().await.map_err(err)?;

    // Spotify rotates the refresh token; persist the new one when present.
    if let Some(rt) = &token.refresh_token {
        store_refresh_token(family.user, rt)?;
    }
    if family.records_scope && token.scope.is_some() {
        *state.granted_scope.lock().await = token.scope.clone();
    }
    let value = token.access_token.clone();
    *guard = Some(CachedToken {
        value: value.clone(),
        expires_at: Instant::now() + Duration::from_secs(token.expires_in.saturating_sub(60)),
    });
    Ok(value)
}

/// A valid access token for the backend's own calls. Never handed to the webview.
pub(crate) async fn ensure_token(state: &AppState, client_id: &str) -> Result<String, String> {
    ensure(state, client_id, &MAIN, &state.token).await
}

/// Return a valid **streaming-scoped** access token — the only token ever exposed to the
/// webview (the Web Playback SDK needs one, and handing it the full-scope main token would
/// let any script in the webview modify playlists).
///
/// There is deliberately **no fallback to the main token**. A missing streaming entry means
/// the second authorization in `login` never completed, and the honest answer is that the
/// player is unavailable until the user reconnects. Quietly substituting the main token would
/// hand the webview `playlist-modify-*` to spare it an error message, turning the one security
/// boundary this app advertises into something that fails open without saying so. Nothing in
/// `ensure` can produce that substitution: the family it is given decides everything.
pub(crate) async fn ensure_streaming_token(
    state: &AppState,
    client_id: &str,
) -> Result<String, String> {
    ensure(state, client_id, &STREAMING, &state.streaming_token).await
}

/// Build Spotify's authorize URL. `challenge` is present for a PKCE grant and absent for the
/// confidential one (`mint_history_token`), which authenticates at the token exchange instead.
///
/// One builder rather than three copies of the format string: each copy is another chance to
/// drop an `encode`, and an unencoded scope list or client id silently changes what is being
/// asked for rather than failing.
fn authorize_url(client_id: &str, scopes: &str, csrf: &str, challenge: Option<&str>) -> String {
    // The challenge is base64url and the csrf comes from `random_string`'s URL-safe alphabet,
    // so neither needs escaping; the caller-supplied id and scopes very much do.
    let pkce = match challenge {
        Some(c) => format!("&code_challenge_method=S256&code_challenge={c}"),
        None => String::new(),
    };
    format!(
        "{AUTH_URL}?response_type=code&client_id={}&redirect_uri={}{pkce}&state={csrf}&scope={}",
        urlencoding::encode(client_id),
        urlencoding::encode(REDIRECT_URI),
        urlencoding::encode(scopes),
    )
}

/// Run one PKCE authorization end to end: open the consent page, catch the loopback redirect,
/// and exchange the code. The app makes two of these — the main login and the streaming-only
/// grant — and they differ solely in which scopes they ask for.
async fn pkce_grant(
    state: &AppState,
    client_id: &str,
    scopes: &str,
) -> Result<TokenResponse, String> {
    let verifier = random_string(64);
    let challenge = code_challenge(&verifier);
    let csrf = random_string(16);
    let url = authorize_url(client_id, scopes, &csrf, Some(&challenge));
    let code = authorize_via_browser(url, csrf).await?;

    state
        .http
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", client_id),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)
}

// ---------------------------------------------------------------------------
// Public: login
// ---------------------------------------------------------------------------

pub async fn login(state: &AppState, client_id: String) -> Result<Profile, String> {
    let token = pkce_grant(state, &client_id, SCOPES).await?;

    let refresh = token
        .refresh_token
        .clone()
        .ok_or_else(|| "Spotify did not return a refresh token.".to_string())?;
    store_refresh_token(KEYRING_USER, &refresh)?;
    store_access(state, &token).await;

    // Second, minimal grant for the Web Playback SDK. Its scopes are a subset of what the
    // user just approved, so Spotify auto-redirects without showing another consent screen —
    // the user sees a second "connected" tab flash by at most.
    //
    // It can still fail (the loopback port is rebound moments after the first flow released
    // it, the browser handoff can drop, the user can close the tab). That doesn't invalidate
    // the login we just completed, so it isn't an error — but it is not swallowed either:
    // without this grant there is no playback token, and `ensure_streaming_token` will refuse
    // rather than reach for the main one. Report it so the user knows to reconnect instead of
    // finding a dead player later.
    let streaming_error = mint_streaming_grant(state, &client_id).await.err();

    Ok(Profile {
        streaming_error,
        ..get_profile(state, &client_id).await?
    })
}

/// Mint the streaming-only token family (see `ensure_streaming_token` for why it exists):
/// a PKCE grant carrying just `STREAMING_SCOPES`, stored under its own keychain entry.
async fn mint_streaming_grant(state: &AppState, client_id: &str) -> Result<(), String> {
    let token = pkce_grant(state, client_id, STREAMING_SCOPES).await?;

    let refresh = token
        .refresh_token
        .clone()
        .ok_or_else(|| "Spotify did not return a streaming refresh token.".to_string())?;
    store_refresh_token(KEYRING_USER_STREAMING, &refresh)?;
    *state.streaming_token.lock().await = Some(CachedToken {
        value: token.access_token.clone(),
        expires_at: Instant::now() + Duration::from_secs(token.expires_in.saturating_sub(60)),
    });
    Ok(())
}

async fn get_profile(state: &AppState, client_id: &str) -> Result<Profile, String> {
    let resp: ProfileResp = get_json(state, client_id, &format!("{API}/me")).await?;
    Ok(Profile {
        id: resp.id,
        display_name: resp.display_name,
        // Filled in by `login`, which is the only place the streaming grant is attempted.
        streaming_error: None,
    })
}

// ---------------------------------------------------------------------------
// Public: history-logger token (for the GitHub Actions poller)
// ---------------------------------------------------------------------------

/// Mint a refresh token for the GitHub Actions history poller: a separate authorization
/// carrying ONLY `user-read-recently-played`, independent of the app's own login (its own
/// token family, so CI refreshes can't invalidate the app's token or vice versa).
///
/// Uses the **confidential** Authorization Code flow (client secret, no PKCE) on purpose:
/// Spotify only rotates refresh tokens for public/PKCE grants. A confidential grant yields a
/// stable refresh token that survives repeated refreshes — which is what the poller needs,
/// since it refreshes from a fixed GitHub secret and (unlike the app's `ensure_token`) has no
/// way to persist a rotated token between runs. The secret is used transiently and the
/// resulting token is returned for the user to store as a GitHub secret, never persisted here.
pub async fn mint_history_token(
    state: &AppState,
    client_id: String,
    client_secret: String,
) -> Result<String, String> {
    if client_secret.trim().is_empty() {
        return Err(
            "A Spotify client secret is required to mint a non-rotating token.".to_string(),
        );
    }
    let csrf = random_string(16);

    // No code_challenge: this is the confidential flow, authenticated at token exchange by
    // the client secret rather than PKCE.
    let auth_url = authorize_url(&client_id, "user-read-recently-played", &csrf, None);
    let code = authorize_via_browser(auth_url, csrf).await?;

    let token: TokenResponse = state
        .http
        .post(TOKEN_URL)
        .basic_auth(&client_id, Some(client_secret.trim()))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", REDIRECT_URI),
        ])
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;

    token
        .refresh_token
        .ok_or_else(|| "Spotify did not return a refresh token.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The boundary SECURITY.md advertises, asserted rather than described: the token the
    /// webview is given can drive playback and nothing else. It is a property of these two
    /// constants alone, so a scope added to the wrong list would hand a compromised renderer
    /// playlist writes with nothing failing to compile.
    #[test]
    fn the_webview_token_cannot_reach_a_playlist() {
        for scope in STREAMING_SCOPES.split_whitespace() {
            assert!(
                !scope.starts_with("playlist-") && !scope.starts_with("user-modify"),
                "{scope} must not be in the token handed to the webview"
            );
        }
        assert!(
            STREAMING_SCOPES
                .split_whitespace()
                .any(|s| s == "streaming"),
            "without `streaming` the SDK token is useless and playback dies"
        );
    }

    /// And the backend's own token deliberately excludes `streaming`, so the SDK scope only
    /// ever arrives through the family above.
    #[test]
    fn the_backend_token_does_not_carry_the_sdk_scope() {
        assert!(!SCOPES.split_whitespace().any(|s| s == "streaming"));
    }

    /// The two tests above pin what each family carries. This one pins which family the webview
    /// is actually handed, which is a single line in `lib.rs` — read back here rather than
    /// described, the same trick as the uninstaller test below and for the same reason: the two
    /// accessors have identical signatures, so pointing that line at the main family would
    /// compile, pass everything else, and quietly give a compromised renderer playlist writes.
    #[test]
    fn the_webview_is_only_ever_handed_the_streaming_family() {
        let lib = include_str!("../lib.rs");
        let marker = "async fn get_streaming_token(";
        let body = lib
            .split(marker)
            .nth(1)
            .expect("the command the webview asks for a token should still be called this");
        let body = &body[..body.find("\n}").expect("its body should end")];
        assert!(
            body.contains("spotify::streaming_token("),
            "{marker} must call the streaming accessor, not the main one:\n{body}"
        );
        // And no other command reaches for the backend's own token on the way out. Matched as
        // a call rather than a mention: comments in `lib.rs` name `ensure_token` to explain
        // why it is *not* used there, and those are the point rather than a violation.
        assert!(
            !lib.contains("ensure_token("),
            "the main-family accessor must not be called anywhere in the IPC surface"
        );
    }

    /// Two families mean two keychain entries and two verdicts. Sharing an entry would let a
    /// streaming refresh rotate the main token out from under the backend; sharing the
    /// revocation rule would let a dead player log the whole app out.
    #[test]
    fn the_families_stay_separable() {
        assert_ne!(MAIN.user, STREAMING.user);
        assert_ne!(MAIN.missing, STREAMING.missing);
        assert_ne!(MAIN.revoked, STREAMING.revoked);
    }

    #[test]
    fn the_authorize_url_carries_a_challenge_only_for_a_pkce_grant() {
        let pkce = authorize_url("my id", "a b", "csrf", Some("chal"));
        assert!(pkce.contains("code_challenge_method=S256"), "{pkce}");
        assert!(pkce.contains("code_challenge=chal"), "{pkce}");
        assert!(pkce.contains("state=csrf"), "{pkce}");
        // Spaces must be escaped, or the scope list ends at the first one and the request asks
        // for something other than what the caller passed.
        assert!(pkce.contains("scope=a%20b"), "{pkce}");
        assert!(pkce.contains("client_id=my%20id"), "{pkce}");

        // The confidential flow (mint_history_token) authenticates at the token exchange.
        let confidential = authorize_url("id", "a", "csrf", None);
        assert!(!confidential.contains("code_challenge"), "{confidential}");
    }

    /// Every message this module shows points at the Setup tab rather than at a click, for the
    /// reason on `NOT_CONNECTED`. Pinned because the rule was written down once and then broken
    /// twice: the strings live in four places and nothing connected them.
    #[test]
    fn no_message_promises_a_single_click() {
        for msg in [
            NOT_CONNECTED,
            NO_STREAMING_GRANT,
            MAIN.revoked,
            STREAMING.revoked,
        ] {
            assert!(
                !msg.to_lowercase().contains("click"),
                "names a click instead of where to go: {msg}"
            );
            assert!(
                msg.contains("Setup"),
                "should say where to go to fix it: {msg}"
            );
        }
    }

    /// The uninstaller clears the Credential Manager entries this module creates, naming them
    /// as literal strings because NSIS cannot see Rust constants. keyring builds a Windows
    /// target as `<user>.<service>`, so this reassembles them the same way and checks the hook
    /// against it — the same trick as the redirect-path test below, for the same reason: the
    /// failure is silent either way.
    ///
    /// Checked in both directions. Forward, so every entry we create is actually deleted, and
    /// an uninstall that promised to remove the saved login did. Reverse, so the uninstaller
    /// deletes nothing else — a stale line left behind by a rename would have it removing a
    /// credential that was never ours from someone's machine.
    #[test]
    fn the_uninstaller_deletes_exactly_the_credentials_this_module_creates() {
        let hooks = include_str!("../../nsis/hooks.nsh");
        let ours: Vec<String> = [KEYRING_USER, KEYRING_USER_STREAMING]
            .iter()
            .map(|user| format!("{user}.{KEYRING_SERVICE}"))
            .collect();

        // Everything each `cmdkey /delete:` names, up to whatever quote or space ends it.
        let deleted: Vec<&str> = hooks
            .match_indices("/delete:")
            .map(|(at, marker)| {
                hooks[at + marker.len()..]
                    .split(['\'', '"', ' ', '\t', '\r', '\n'])
                    .next()
                    .unwrap_or_default()
            })
            .filter(|target| !target.is_empty())
            .collect();

        for target in &ours {
            assert!(
                deleted.contains(&target.as_str()),
                "hooks.nsh never deletes {target}, so an uninstall orphans it in Credential Manager"
            );
        }
        for target in &deleted {
            assert!(
                ours.iter().any(|ours| ours == target),
                "hooks.nsh deletes {target}, which this module never creates — the uninstaller \
                 would be removing someone else's credential"
            );
        }
    }

    #[test]
    fn the_listener_path_matches_the_registered_redirect() {
        // `wait_for_code` answers only on REDIRECT_PATH, while Spotify redirects to whatever
        // REDIRECT_URI says. If they ever drift apart every callback is silently discarded and
        // the login just hangs until the five-minute timeout — a failure with no visible cause.
        assert!(
            REDIRECT_URI.ends_with(REDIRECT_PATH),
            "loopback listener answers on {REDIRECT_PATH}, but Spotify redirects to {REDIRECT_URI}"
        );
    }
}
