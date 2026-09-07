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

/// Return a valid access token, refreshing from the stored refresh token if needed.
///
/// The token mutex is held across the whole refresh (single-flight): if several
/// commands need a token at once, only the first refreshes and the rest wait for it.
/// This avoids two concurrent refreshes reusing the same rotating refresh token,
/// which would trip Spotify's reuse detection and invalidate the whole token family.
pub(crate) async fn ensure_token(state: &AppState, client_id: &str) -> Result<String, String> {
    let mut guard = state.token.lock().await;
    if let Some(t) = guard.as_ref() {
        if Instant::now() < t.expires_at {
            return Ok(t.value.clone());
        }
    }

    let refresh = load_refresh_token(KEYRING_USER)?
        .ok_or_else(|| "Not connected to Spotify — click Connect first.".to_string())?;

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
            let _ = logout();
            return Err(
                "Spotify session expired or was revoked — click Connect to sign in again.".into(),
            );
        }
        return Err(format!(
            "Token refresh failed (HTTP {status}): {}",
            body.trim()
        ));
    }
    let token: TokenResponse = resp.json().await.map_err(err)?;

    // Spotify rotates the refresh token; persist the new one when present.
    if let Some(rt) = &token.refresh_token {
        store_refresh_token(KEYRING_USER, rt)?;
    }
    if token.scope.is_some() {
        *state.granted_scope.lock().await = token.scope.clone();
    }
    let value = token.access_token.clone();
    *guard = Some(CachedToken {
        value: value.clone(),
        expires_at: Instant::now() + Duration::from_secs(token.expires_in.saturating_sub(60)),
    });
    Ok(value)
}

/// What the webview is told when we have no streaming grant to give it. Playback is the only
/// thing affected; every other feature runs off the main token, which stays in this process.
pub(crate) const NO_STREAMING_GRANT: &str =
    "In-app playback isn't authorized yet — open Setup and click Connect Spotify to grant it. \
     Everything else works without it.";

/// Return a valid **streaming-scoped** access token — the only token ever exposed to the
/// webview (the Web Playback SDK needs one, and handing it the full-scope main token would
/// let any script in the webview modify playlists). Same single-flight refresh pattern as
/// `ensure_token`, against its own keychain entry.
///
/// There is deliberately **no fallback to the main token**. A missing streaming entry means
/// the second authorization in `login` never completed, and the honest answer is that the
/// player is unavailable until the user reconnects. Quietly substituting the main token would
/// hand the webview `playlist-modify-*` to spare it an error message, turning the one security
/// boundary this app advertises into something that fails open without saying so.
pub(crate) async fn ensure_streaming_token(
    state: &AppState,
    client_id: &str,
) -> Result<String, String> {
    let mut guard = state.streaming_token.lock().await;
    if let Some(t) = guard.as_ref() {
        if Instant::now() < t.expires_at {
            return Ok(t.value.clone());
        }
    }

    let refresh = load_refresh_token(KEYRING_USER_STREAMING)?
        .ok_or_else(|| NO_STREAMING_GRANT.to_string())?;

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
        if body.contains("invalid_grant") {
            // Only the streaming family is dead — leave the main session alone; the next
            // Connect re-mints it.
            let _ = delete_refresh_token(KEYRING_USER_STREAMING);
            return Err(
                "Playback session expired — reconnect Spotify in Setup to restore in-app playback."
                    .into(),
            );
        }
        return Err(format!(
            "Streaming token refresh failed (HTTP {status}): {}",
            body.trim()
        ));
    }
    let token: TokenResponse = resp.json().await.map_err(err)?;

    if let Some(rt) = &token.refresh_token {
        store_refresh_token(KEYRING_USER_STREAMING, rt)?;
    }
    let value = token.access_token.clone();
    *guard = Some(CachedToken {
        value: value.clone(),
        expires_at: Instant::now() + Duration::from_secs(token.expires_in.saturating_sub(60)),
    });
    Ok(value)
}

// ---------------------------------------------------------------------------
// Public: login
// ---------------------------------------------------------------------------

pub async fn login(state: &AppState, client_id: String) -> Result<Profile, String> {
    let verifier = random_string(64);
    let challenge = code_challenge(&verifier);
    let csrf = random_string(16);

    let auth_url = format!(
        "{AUTH_URL}?response_type=code&client_id={}&redirect_uri={}&code_challenge_method=S256&code_challenge={}&state={}&scope={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(REDIRECT_URI),
        challenge,
        csrf,
        urlencoding::encode(SCOPES),
    );

    let code = authorize_via_browser(auth_url, csrf).await?;

    let token: TokenResponse = state
        .http
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", client_id.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;

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
    let verifier = random_string(64);
    let challenge = code_challenge(&verifier);
    let csrf = random_string(16);

    let auth_url = format!(
        "{AUTH_URL}?response_type=code&client_id={}&redirect_uri={}&code_challenge_method=S256&code_challenge={}&state={}&scope={}",
        urlencoding::encode(client_id),
        urlencoding::encode(REDIRECT_URI),
        challenge,
        csrf,
        urlencoding::encode(STREAMING_SCOPES),
    );

    let code = authorize_via_browser(auth_url, csrf).await?;

    let token: TokenResponse = state
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
        .map_err(err)?;

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
    let auth_url = format!(
        "{AUTH_URL}?response_type=code&client_id={}&redirect_uri={}&state={}&scope={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(REDIRECT_URI),
        csrf,
        urlencoding::encode("user-read-recently-played"),
    );

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
