//! Playback: the Spotify Connect device picker and the remote-playback control behind the
//! app's playback bar (GET/PUT `/me/player…`). The local Web Playback SDK itself runs in the
//! frontend; these commands hand it a token and drive playback happening on another device (or
//! move a session between devices).

use serde::{Deserialize, Serialize};

use super::{
    capture_get_retry, ensure_streaming_token, err, get_json, null_default, send_capture, AppState,
    ArtistObj, ImageObj, LinkedFrom, API,
};

/// Expose an access token to the frontend (the Web Playback SDK needs one). Deliberately the
/// streaming-scoped token, not the app's main one: this is the only token that crosses the
/// IPC boundary, and it can play music but not read or modify playlists.
pub async fn access_token(state: &AppState, client_id: String) -> Result<String, String> {
    ensure_streaming_token(state, &client_id).await
}

/// Start playback on a specific device. Either `context_uri` (+ optional `offset_uri`)
/// to play within a playlist, or `uris` for an explicit track list.
pub async fn player_play(
    state: &AppState,
    client_id: String,
    device_id: String,
    context_uri: Option<String>,
    offset_uri: Option<String>,
    uris: Option<Vec<String>>,
) -> Result<(), String> {
    let mut body = serde_json::Map::new();
    if let Some(c) = context_uri {
        body.insert("context_uri".into(), serde_json::json!(c));
    }
    if let Some(u) = uris {
        body.insert("uris".into(), serde_json::json!(u));
    }
    if let Some(off) = offset_uri {
        body.insert("offset".into(), serde_json::json!({ "uri": off }));
    }
    let url = format!(
        "{API}/me/player/play?device_id={}",
        urlencoding::encode(&device_id)
    );
    let (st, b) = send_capture(
        state,
        &client_id,
        state.http.put(url).json(&serde_json::Value::Object(body)),
    )
    .await?;
    if !st.is_success() {
        // A 403 "Restriction violated" means the track is unavailable for this user (greyed
        // out on Spotify) — not playable by any client. Surface a readable message the UI can
        // recognize rather than the raw API blob.
        if st.as_u16() == 403 && b.contains("Restriction violated") {
            return Err("UNAVAILABLE: This track isn't available to play (greyed out on Spotify — unavailable in your region or removed).".into());
        }
        return Err(format!("Play failed (HTTP {st}): {}", b.trim()));
    }
    Ok(())
}

/// Make the given device the active playback device. `play: false` merely activates it
/// (used for a freshly-ready Web Playback SDK device); `play: true` also continues the
/// current playback there (used by the device picker to move a playing session).
pub async fn player_transfer(
    state: &AppState,
    client_id: String,
    device_id: String,
    play: bool,
) -> Result<(), String> {
    let (st, b) = send_capture(
        state,
        &client_id,
        state
            .http
            .put(format!("{API}/me/player"))
            .json(&serde_json::json!({ "device_ids": [device_id], "play": play })),
    )
    .await?;
    if !st.is_success() {
        return Err(format!("Transfer failed (HTTP {st}): {}", b.trim()));
    }
    Ok(())
}

/// A Spotify Connect device the user can route playback to.
#[derive(Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    /// Device category as reported by Spotify ("Computer", "Smartphone", "Speaker", …).
    pub kind: String,
    pub is_active: bool,
}

#[derive(Deserialize)]
struct DevicesResp {
    #[serde(default)]
    devices: Vec<DeviceObj>,
}

#[derive(Deserialize)]
struct DeviceObj {
    // Spotify documents that some devices may come back without an id; those can't be
    // targeted by transfer/play, so we drop them from the list.
    id: Option<String>,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    is_active: bool,
}

/// List the user's available Spotify Connect devices.
pub async fn player_devices(
    state: &AppState,
    client_id: String,
) -> Result<Vec<DeviceInfo>, String> {
    let resp: DevicesResp =
        get_json(state, &client_id, &format!("{API}/me/player/devices")).await?;
    Ok(resp
        .devices
        .into_iter()
        .filter_map(|d| {
            d.id.map(|id| DeviceInfo {
                id,
                name: d.name,
                kind: d.kind,
                is_active: d.is_active,
            })
        })
        .collect())
}

/// Snapshot of whatever is currently playing, on any of the user's devices. `None` when
/// there is no active playback session (Spotify answers 204) or no track loaded.
#[derive(Serialize)]
pub struct RemotePlayback {
    pub device_id: String,
    pub device_name: String,
    pub paused: bool,
    pub position: u64,
    pub duration: u64,
    pub track_name: String,
    pub uri: String,
    pub artists: Vec<String>,
    pub cover: Option<String>,
    /// The context playback was started from (e.g. "spotify:playlist:…"), if any.
    pub context_uri: Option<String>,
    /// Original (pre-relink) uri when Spotify substituted a market equivalent — playlist
    /// files store this form, so the UI matches the playing row against both uris.
    pub linked_from_uri: Option<String>,
}

#[derive(Deserialize)]
struct PlayerResp {
    device: PlayerDevice,
    #[serde(default)]
    progress_ms: Option<u64>,
    #[serde(default)]
    is_playing: bool,
    #[serde(default)]
    item: Option<PlayerItem>,
    #[serde(default)]
    context: Option<PlayerContext>,
}

#[derive(Deserialize)]
struct PlayerContext {
    uri: String,
}

#[derive(Deserialize)]
struct PlayerDevice {
    id: Option<String>,
    name: String,
}

#[derive(Deserialize)]
struct PlayerItem {
    name: String,
    uri: String,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    artists: Vec<ArtistObj>,
    #[serde(default)]
    album: Option<PlayerItemAlbum>,
    // Present when Spotify relinked the playing track to a market-specific equivalent;
    // carries the original uri, which is what playlist files store.
    #[serde(default)]
    linked_from: Option<LinkedFrom>,
}

#[derive(Deserialize)]
struct PlayerItemAlbum {
    #[serde(default, deserialize_with = "null_default")]
    images: Vec<ImageObj>,
}

/// Current playback state across all the user's devices (GET /me/player). Used by the UI
/// to keep the playback bar live while the music plays on a device other than this app.
pub async fn player_state(
    state: &AppState,
    client_id: String,
) -> Result<Option<RemotePlayback>, String> {
    // Not get_json: a 204 with an empty body (no active session) is a normal answer here.
    // capture_get_retry (not send_capture) so a transient 429 on this frequent poll retries
    // quietly instead of flapping an error onto the playback bar.
    let (st, body) = capture_get_retry(state, &client_id, &format!("{API}/me/player")).await?;
    if st.as_u16() == 204 || body.trim().is_empty() {
        return Ok(None);
    }
    if !st.is_success() {
        return Err(format!("HTTP {st}: {}", body.trim()));
    }
    let p: PlayerResp = serde_json::from_str(&body).map_err(err)?;
    let (Some(device_id), Some(item)) = (p.device.id, p.item) else {
        return Ok(None);
    };
    Ok(Some(RemotePlayback {
        device_id,
        device_name: p.device.name,
        paused: !p.is_playing,
        position: p.progress_ms.unwrap_or(0),
        duration: item.duration_ms.unwrap_or(0),
        track_name: item.name,
        uri: item.uri,
        artists: item.artists.into_iter().map(|a| a.name).collect(),
        cover: item
            .album
            .and_then(|a| a.images.first().map(|i| i.url.clone())),
        context_uri: p.context.map(|c| c.uri),
        linked_from_uri: item.linked_from.map(|l| l.uri),
    }))
}

/// A transport command for the active device. Deserialized straight from the IPC payload,
/// so an unknown action string is rejected at the boundary rather than checked by hand.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum PlayerAction {
    Pause,
    Resume,
    Next,
    Previous,
    Seek,
}

impl PlayerAction {
    fn as_str(self) -> &'static str {
        match self {
            PlayerAction::Pause => "pause",
            PlayerAction::Resume => "resume",
            PlayerAction::Next => "next",
            PlayerAction::Previous => "previous",
            PlayerAction::Seek => "seek",
        }
    }
}

/// Send a transport command to the user's *active* device — used when playback lives on
/// another device, where the local Web Playback SDK can't control it.
pub async fn player_command(
    state: &AppState,
    client_id: String,
    action: PlayerAction,
    position_ms: Option<u64>,
) -> Result<(), String> {
    let rb = match action {
        PlayerAction::Pause => state.http.put(format!("{API}/me/player/pause")),
        PlayerAction::Resume => state.http.put(format!("{API}/me/player/play")),
        PlayerAction::Next => state.http.post(format!("{API}/me/player/next")),
        PlayerAction::Previous => state.http.post(format!("{API}/me/player/previous")),
        PlayerAction::Seek => {
            let ms = position_ms.ok_or("seek requires a position")?;
            state
                .http
                .put(format!("{API}/me/player/seek?position_ms={ms}"))
        }
    };
    // These endpoints take no body, but Spotify's edge rejects bodyless POST/PUT with
    // "411 Length Required" — send an explicit empty body so Content-Length: 0 is set.
    let (st, b) = send_capture(
        state,
        &client_id,
        rb.header(reqwest::header::CONTENT_LENGTH, 0).body(""),
    )
    .await?;
    if !st.is_success() {
        return Err(format!(
            "Player {} failed (HTTP {st}): {}",
            action.as_str(),
            b.trim()
        ));
    }
    Ok(())
}
