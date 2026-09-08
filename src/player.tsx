import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, type DeviceInfo, type RemotePlayback } from "./api";
import type { SpotifyPlayer, SpotifyWebPlaybackState } from "./spotify-sdk";

// The `any`s below are all Spotify's Web Playback SDK. It's loaded from their CDN at runtime
// rather than installed, ships no type definitions, and isn't in package.json — so `window.Spotify`
// and every event payload it hands back are genuinely untyped. They're confined to this file.

export interface PlaybackState {
  trackName: string;
  uri: string; // spotify:track:… — used to highlight the song wherever it appears
  artists: string;
  paused: boolean;
  position: number;
  duration: number;
  cover: string | null;
  /// The context playback was started from ("spotify:playlist:…") — used to mark the
  /// playing playlist in the sidebar. Null for context-less playback (explicit uris).
  contextUri: string | null;
  /// Original (pre-relink) uri when Spotify substituted a market-specific equivalent.
  /// Playlist files store the original form, so row highlighting matches against both.
  linkedFromUri: string | null;
}

export interface PlayerApi {
  ready: boolean;
  state: PlaybackState | null;
  error: string | null;
  clearError: () => void;
  /** Play a playlist from a given track (contextUri = playlist uri, offsetUri = track uri). */
  play: (contextUri: string | null, offsetUri: string | null, uris?: string[]) => Promise<void>;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (ms: number) => void;
  volume: number;
  setVolume: (v: number) => void;
  /** Spotify Connect devices (refreshed when the picker opens). */
  devices: DeviceInfo[];
  /** Name of the device playback lives on when it isn't this app, else null. */
  remoteName: string | null;
  /** This app's own Web Playback SDK device id (to label it in the picker). */
  localDeviceId: string | null;
  refreshDevices: () => Promise<void>;
  transferTo: (deviceId: string) => Promise<void>;
  /** Deliver a token the SDK is still waiting for. See `retryToken` for why. */
  retryToken: () => void;
}

const Ctx = createContext<PlayerApi | null>(null);
export const usePlayer = () => useContext(Ctx);

/// The slow-changing subset of PlaybackState that list views need to mark the playing
/// row. Unlike PlayerApi, its identity survives the once-a-second position tick, so
/// subscribers only re-render on track change or pause/resume.
export interface NowPlaying {
  trackName: string;
  uri: string;
  linkedFromUri: string | null;
  contextUri: string | null;
  paused: boolean;
}

export interface NowPlayingApi {
  /** Null when nothing is playing anywhere. */
  playing: NowPlaying | null;
  play: PlayerApi["play"];
}

const NowPlayingCtx = createContext<NowPlayingApi | null>(null);
export const useNowPlaying = () => useContext(NowPlayingCtx);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<PlaybackState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `play` is deliberately identity-stable, so it can't close over `error`. It still needs to
  // know whether one is already showing — see the guard in `play`.
  const errorRef = useRef<string | null>(null);
  errorRef.current = error;
  // Why the SDK's last token request failed, if it did. Held rather than shown — see the
  // getOAuthToken handler.
  const tokenFailureRef = useRef<string | null>(null);
  // The SDK asks for a token by handing over a callback, and then waits: the request isn't
  // finished until that callback is called, however long that takes. On a fresh install the
  // first ask lands before any streaming grant exists, so keep the callback and answer it
  // once there is something to answer with (see `retryToken`).
  //
  // The obvious alternative — throw the player away and build a new one after connecting —
  // does not work. The SDK claims page-global media infrastructure (EME/CDM) when the first
  // Player is constructed; a second one never calls getOAuthToken and its connect() never
  // settles. One player per page, for the life of the page.
  const pendingTokenCb = useRef<((t: string) => void) | null>(null);
  const [volume, setVolumeState] = useState(0.8);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  // Non-null while playback lives on another Spotify Connect device. Mirrored into a ref
  // so the poll loop and control handlers always see the current value.
  const [remote, setRemote] = useState<{ id: string; name: string } | null>(null);
  const playerRef = useRef<SpotifyPlayer | null>(null);
  const deviceRef = useRef<string | null>(null);
  const remoteRef = useRef<{ id: string; name: string } | null>(null);
  // Mirror of state.paused for the poll loop (which can't read state directly). A paused
  // remote session has nothing advancing, so we resync far less often — see the poll below.
  const pausedRef = useRef(true);

  function setRemoteBoth(r: { id: string; name: string } | null) {
    remoteRef.current = r;
    setRemote(r);
  }

  /// Fold a /me/player snapshot into the bar. Decides whether playback is local
  /// (SDK listener owns the state) or remote (we own it from these polls).
  function applyRemoteState(rp: RemotePlayback | null) {
    if (!rp) {
      // No active session anywhere; if we were following a remote one, let the bar close.
      if (remoteRef.current) {
        setRemoteBoth(null);
        setState(null);
      }
      return;
    }
    if (deviceRef.current && rp.device_id === deviceRef.current) {
      // Playback is (back) on this app — the SDK's own listener takes over.
      if (remoteRef.current) setRemoteBoth(null);
      return;
    }
    setRemoteBoth({ id: rp.device_id, name: rp.device_name });
    setState({
      trackName: rp.track_name,
      uri: rp.uri,
      artists: rp.artists.join(", "),
      paused: rp.paused,
      position: rp.position,
      duration: rp.duration,
      cover: rp.cover,
      contextUri: rp.context_uri,
      linkedFromUri: rp.linked_from_uri,
    });
  }

  async function refreshDevices() {
    try {
      setDevices(await api.playerDevices());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    let cancelled = false;

    function applyState(s: SpotifyWebPlaybackState | null) {
      if (!s) return;
      const t = s.track_window?.current_track;
      if (!t) return;
      setState({
        trackName: t.name,
        uri: t.uri,
        artists: (t.artists ?? []).map((a) => a.name).join(", "),
        paused: s.paused,
        position: s.position,
        duration: s.duration,
        cover: t.album?.images?.[0]?.url ?? null,
        contextUri: s.context?.uri ?? null,
        linkedFromUri: t.linked_from?.uri ?? null,
      });
    }

    function init() {
      const Spotify = window.Spotify;
      if (!Spotify || playerRef.current) return;
      const player = new Spotify.Player({
        name: "Setlist",
        getOAuthToken: (cb: (t: string) => void) => {
          api.getStreamingToken().then(
            (t) => {
              tokenFailureRef.current = null;
              pendingTokenCb.current = null;
              cb(t);
            },
            (e) => {
              // Not an error to show. The SDK asks the moment the app starts, so on a fresh
              // install this fails before anyone has touched anything — greeting someone with
              // a modal about a feature they haven't reached is no way to open. Keep the
              // reason for `explainSilence`, and keep the callback for `retryToken`.
              tokenFailureRef.current = String(e);
              pendingTokenCb.current = cb;
            }
          );
        },
        volume: 0.8,
      });
      playerRef.current = player;

      player.addListener("ready", ({ device_id }) => {
        if (cancelled) return;
        deviceRef.current = device_id;
        setReady(true);
        setError(null);
        // Activate this device so later play calls find it (best effort) — but never
        // steal the session from a device that's actively playing.
        if (!remoteRef.current) api.playerTransfer(device_id, false).catch(() => {});
      });
      player.addListener("not_ready", () => {
        deviceRef.current = null;
        setReady(false);
      });
      player.addListener("player_state_changed", applyState);
      player.addListener("initialization_error", ({ message }) =>
        setError(`Init error: ${message}`)
      );
      player.addListener("authentication_error", ({ message }) =>
        setError(`Auth error: ${message} (reconnect in Setup to grant streaming)`)
      );
      player.addListener("account_error", ({ message }) =>
        setError(`Account error — Spotify Premium is required. ${message}`)
      );
      player.addListener("playback_error", ({ message }) =>
        setError(`Playback error: ${message}`)
      );
      void player.connect();
    }

    if (window.Spotify) {
      init();
    } else {
      // Define the ready callback BEFORE the SDK script runs, then load the SDK. (A static
      // <script> tag in index.html executes ahead of this bundle, and the SDK throws if the
      // callback doesn't exist yet.) Dynamic injection also satisfies the CSP: the script
      // still comes from sdk.scdn.co, no inline code involved.
      window.onSpotifyWebPlaybackSDKReady = init;
      if (!document.getElementById("spotify-sdk")) {
        const s = document.createElement("script");
        s.id = "spotify-sdk";
        s.src = "https://sdk.scdn.co/spotify-player.js";
        s.async = true;
        document.body.appendChild(s);
      }
    }

    // Smoothly track progress while playing. Local playback polls the SDK every second.
    // A remote session has no push channel (that's private to Spotify's own clients), so:
    // advance the progress bar locally every second so it moves smoothly, and re-sync
    // against the Web API periodically — the poll only corrects drift and picks up changes
    // made from other devices. While playing we resync every 2nd tick (≈2s); while paused
    // nothing is moving, so we back off to every 6th tick (≈6s) to spare the rate limit and
    // still notice a resume/seek from another device reasonably quickly.
    let tick = 0;
    let remotePollBusy = false;
    // Pause the network/SDK side of the poll while an HTML5 drag is in flight. On Windows the
    // webview runs a nested OS modal loop during a drag; firing IPC (remote player state) or
    // SDK calls into it once a second piled up the longer the drag was held — which showed up
    // as the app crashing when a track was dragged onto the sidebar and held. dragstart and
    // dragover bubble to window, so "a drag event within the last ~1.5s" means active; that
    // auto-clears shortly after the drop, so even an abnormally-ended drag can't wedge polling
    // off for good. The local progress advance below is pure JS and keeps running so the bar
    // doesn't stutter mid-drag.
    let lastDragAt = 0;
    const noteDrag = () => {
      lastDragAt = Date.now();
    };
    window.addEventListener("dragstart", noteDrag);
    window.addEventListener("dragover", noteDrag);
    const poll = setInterval(() => {
      tick++;
      const dragging = Date.now() - lastDragAt < 1500;
      if (remoteRef.current) {
        setState((s) =>
          s && !s.paused
            ? { ...s, position: Math.min(s.position + 1000, s.duration) }
            : s
        );
        const interval = pausedRef.current ? 6 : 2;
        if (tick % interval === 0 && !remotePollBusy && !dragging) {
          remotePollBusy = true;
          api
            .playerState()
            .then((rp) => {
              if (!cancelled) applyRemoteState(rp);
            })
            .catch(() => {}) // background poll — stay quiet on transient failures
            .finally(() => {
              remotePollBusy = false;
            });
        }
        return;
      }
      if (!dragging) {
        void playerRef.current?.getCurrentState?.().then((s) => {
          if (s) applyState(s);
        });
      }
    }, 1000);

    // If music is already playing on another device when the app opens, pick the session
    // up so the bar (and its device picker) appears without starting playback locally.
    api
      .playerState()
      .then((rp) => {
        if (!cancelled && rp) applyRemoteState(rp);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      clearInterval(poll);
      window.removeEventListener("dragstart", noteDrag);
      window.removeEventListener("dragover", noteDrag);
      playerRef.current?.disconnect?.();
      playerRef.current = null;
    };
  }, []);

  // Feed the poll loop the current paused state (it runs from a ref-only closure). Only
  // re-runs when paused actually flips, so the per-second position tick doesn't trigger it.
  useEffect(() => {
    pausedRef.current = state?.paused ?? true;
  }, [state?.paused]);

  // Stable identity (only refs and setters inside) — it's part of the now-playing
  // context value, which must not churn with the position tick.
  /// Say why nothing is going to play. `deviceRef` being empty can't tell these apart, and
  /// they ask completely different things of the reader, so find out before answering.
  const explainSilence = useCallback(async () => {
    // A real SDK failure — no Premium, a bad init — is already the whole answer.
    if (errorRef.current) return;
    const connected = await api.authStatus().catch(() => false);
    if (!connected) {
      setError("Not connected to Spotify. Connect your account from the Setup tab to play here.");
    } else if (tokenFailureRef.current) {
      setError(tokenFailureRef.current);
    } else {
      setError("The player is still starting up — try that again in a moment.");
    }
  }, []);

  const play: PlayerApi["play"] = useCallback(async (contextUri, offsetUri, uris) => {
    // Honor the chosen output: if playback lives on another device, start there.
    const device = remoteRef.current?.id ?? deviceRef.current;
    if (!device) {
      await explainSilence();
      return;
    }
    // The SDK device can take a moment to become playable on Spotify's backend;
    // retry through the "Device not found" race.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await api.playerPlay(device, contextUri, offsetUri, uris ?? null);
        setError(null);
        if (remoteRef.current) {
          // Remote device: sync the bar once Spotify has switched tracks.
          setTimeout(() => api.playerState().then(applyRemoteState).catch(() => {}), 800);
        }
        return;
      } catch (e) {
        const msg = String(e);
        if (msg.includes("404") && attempt < 3) {
          await new Promise((r) => setTimeout(r, 700));
          continue;
        }
        // Backend marks a greyed-out/unavailable track with an UNAVAILABLE: prefix — show
        // just the readable sentence (the track can't be played by any Spotify client).
        const marker = "UNAVAILABLE:";
        const i = msg.indexOf(marker);
        setError(i >= 0 ? msg.slice(i + marker.length).trim() : msg);
        return;
      }
    }
  }, []);

  // Stable for the same reason: the memoized volume slider in PlaybackBar keys on it.
  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    void playerRef.current?.setVolume?.(v);
  }, []);

  /// Answer a token request the SDK is still waiting on. Called after a successful login:
  /// the grant it needs may have only just come into existence, and the SDK will not ask
  /// again by itself. Without this the player stays dead until the app is restarted, which
  /// nothing in the UI would ever tell you to do.
  const retryToken = useCallback(() => {
    const cb = pendingTokenCb.current;
    if (!cb) return; // nothing waiting: either it never failed, or it's already answered
    api.getStreamingToken().then(
      (t) => {
        tokenFailureRef.current = null;
        pendingTokenCb.current = null;
        setError(null);
        cb(t);
      },
      (e) => {
        tokenFailureRef.current = String(e);
      }
    );
  }, []);

  const value: PlayerApi = {
    ready,
    state,
    error,
    retryToken,
    clearError: () => setError(null),
    play,
    toggle: () => {
      if (remoteRef.current) {
        const paused = state?.paused ?? true;
        api
          .playerCommand(paused ? "resume" : "pause")
          .then(() => setState((s) => (s ? { ...s, paused: !paused } : s)))
          .catch((e) => setError(String(e)));
      } else {
        void playerRef.current?.togglePlay();
      }
    },
    next: () => {
      if (remoteRef.current) {
        // Sync as soon as the command lands — the new track is already playing by the
        // time Spotify acknowledges, so no artificial delay is needed.
        api
          .playerCommand("next")
          .then(() => api.playerState().then(applyRemoteState).catch(() => {}))
          .catch((e) => setError(String(e)));
      } else {
        void playerRef.current?.nextTrack();
      }
    },
    prev: () => {
      if (remoteRef.current) {
        api
          .playerCommand("previous")
          .then(() => api.playerState().then(applyRemoteState).catch(() => {}))
          .catch((e) => setError(String(e)));
      } else {
        void playerRef.current?.previousTrack();
      }
    },
    seek: (ms: number) => {
      if (remoteRef.current) {
        api
          .playerCommand("seek", Math.round(ms))
          .then(() => setState((s) => (s ? { ...s, position: ms } : s)))
          .catch((e) => setError(String(e)));
      } else {
        void playerRef.current?.seek(ms);
      }
    },
    volume,
    setVolume,
    devices,
    remoteName: remote?.name ?? null,
    localDeviceId: deviceRef.current,
    refreshDevices,
    transferTo: async (deviceId: string) => {
      if (remoteRef.current?.id === deviceId) return; // already there
      try {
        // Keep the music going when moving an actively-playing session.
        await api.playerTransfer(deviceId, !!state && !state.paused);
        if (deviceId === deviceRef.current) {
          setRemoteBoth(null); // back to this app — the SDK listener takes over
        } else {
          const name =
            devices.find((d) => d.id === deviceId)?.name ?? "another device";
          setRemoteBoth({ id: deviceId, name });
          // Give Spotify a beat to move the session, then sync the bar.
          setTimeout(() => api.playerState().then(applyRemoteState).catch(() => {}), 800);
        }
        void refreshDevices();
      } catch (e) {
        setError(String(e));
      }
    },
  };

  // Keyed on the fields, not the state object: the poll above replaces `state` every
  // second just to advance `position`, and this identity must hold steady through that.
  const nowPlaying = useMemo<NowPlaying | null>(
    () =>
      state
        ? {
            trackName: state.trackName,
            uri: state.uri,
            linkedFromUri: state.linkedFromUri,
            contextUri: state.contextUri,
            paused: state.paused,
          }
        : null,
    [
      state?.trackName,
      state?.uri,
      state?.linkedFromUri,
      state?.contextUri,
      state?.paused,
    ]
  );
  const nowPlayingValue = useMemo<NowPlayingApi>(
    () => ({ playing: nowPlaying, play }),
    [nowPlaying, play]
  );

  return (
    <Ctx.Provider value={value}>
      <NowPlayingCtx.Provider value={nowPlayingValue}>{children}</NowPlayingCtx.Provider>
    </Ctx.Provider>
  );
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

// Minimalist player icons (inline SVG, currentColor).
const IcoPrev = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor">
    <path d="M7 6h2v12H7zM18 6v12l-8-6z" />
  </svg>
);
const IcoNext = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor">
    <path d="M15 6h2v12h-2zM6 6v12l8-6z" />
  </svg>
);
const IcoPlay = () => (
  <svg viewBox="0 0 24 24" className="ico ico-play" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);
const IcoPause = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor">
    <path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" />
  </svg>
);
// Monitor + phone — "available devices", à la Spotify Connect.
const IcoDevices = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor">
    <path d="M3 4h17a1 1 0 0 1 1 1v4h-2V6H4v10h8v2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    <path d="M15 11h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zm1 2v6h4v-6h-4z" />
  </svg>
);

const IcoVolume = ({ level }: { level: number }) => (
  <svg viewBox="0 0 24 24" className="ico-vol" fill="none">
    <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z" fill="currentColor" />
    {level === 0 ? (
      <path
        d="M16.5 9.5l5 5m0-5l-5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    ) : (
      <>
        <path d="M15.5 9.8a3.6 3.6 0 010 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        {level >= 0.5 && (
          <path d="M18 7.6a7 7 0 010 8.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        )}
      </>
    )}
  </svg>
);

export function PlaybackBar() {
  const player = usePlayer();
  const [pickerOpen, setPickerOpen] = useState(false);
  const volume = player?.volume ?? 0.8;
  const setVolume = player?.setVolume;
  // The bar re-renders every second for the progress fill, and React 19 rewrites a
  // controlled input's name attribute on every committed update (DevTools shows it as
  // constant attribute churn). Reusing the identical element skips that commit while
  // the volume is unchanged — possible because setVolume is a stable useCallback.
  const volumeSlider = useMemo(
    () =>
      setVolume && (
        <input
          className="pb-vol"
          name="volume"
          aria-label="Volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          style={{ ["--vol" as string]: `${volume * 100}%` }}
        />
      ),
    [volume, setVolume]
  );
  if (!player) return null;
  const {
    state,
    error,
    clearError,
    toggle,
    next,
    prev,
    seek,
    devices,
    remoteName,
    localDeviceId,
    refreshDevices,
    transferTo,
  } = player;

  if (!state && !error) return null;

  return (
    <div className="playbar">
      {error ? (
        <div className="playbar-error">
          <span>{error}</span>
          <button className="msg-close" onClick={clearError} title="Dismiss" aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : state ? (
        <>
          <div className="pb-now">
            {state.cover && <img src={state.cover} className="pb-cover" alt="" />}
            <div className="pb-meta">
              <div className="pb-title">{state.trackName}</div>
              <div className="pb-artist">{state.artists}</div>
            </div>
          </div>
          <div className="pb-center">
            <div className="pb-controls">
              <button className="pb-btn" onClick={prev} title="Previous">
                <IcoPrev />
              </button>
              <button className="pb-btn play" onClick={toggle} title="Play/Pause">
                {state.paused ? <IcoPlay /> : <IcoPause />}
              </button>
              <button className="pb-btn" onClick={next} title="Next">
                <IcoNext />
              </button>
            </div>
            <div className="pb-seek">
              <span className="pb-time">{fmt(state.position)}</span>
              <div
                className="pb-track"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = (e.clientX - rect.left) / rect.width;
                  seek(Math.max(0, Math.min(1, ratio)) * state.duration);
                }}
              >
                <div
                  className="pb-fill"
                  style={{ width: `${(state.position / Math.max(1, state.duration)) * 100}%` }}
                />
              </div>
              <span className="pb-time">{fmt(state.duration)}</span>
            </div>
          </div>
          <div className="pb-right">
            {remoteName ? (
              // Volume here only drives the local SDK player, so while playback lives on
              // another device show where it's playing instead of a dead slider.
              <span className="pb-devname" title={`Playing on ${remoteName}`}>
                {remoteName}
              </span>
            ) : (
              <>
                <span className="pb-vol-icon" title="Volume">
                  <IcoVolume level={volume} />
                </span>
                {volumeSlider}
              </>
            )}
            <div className="pb-devwrap">
              <button
                className={"pb-btn pb-dev-btn" + (remoteName ? " remote" : "")}
                title="Choose playback device"
                aria-label="Choose playback device"
                onClick={() => {
                  if (!pickerOpen) void refreshDevices();
                  setPickerOpen(!pickerOpen);
                }}
              >
                <IcoDevices />
              </button>
              {pickerOpen && (
                <>
                  <div className="pb-dev-backdrop" onClick={() => setPickerOpen(false)} />
                  <div className="pb-devpop">
                    <div className="pb-devpop-title">Play on</div>
                    {devices.length === 0 ? (
                      <div className="pb-dev-empty">
                        No devices found — open Spotify on a device to make it appear.
                      </div>
                    ) : (
                      devices.map((d) => (
                        <button
                          key={d.id}
                          className={"pb-dev-item" + (d.is_active ? " active" : "")}
                          onClick={() => {
                            setPickerOpen(false);
                            void transferTo(d.id);
                          }}
                        >
                          <span className="pb-dev-name">
                            {d.name}
                            {d.id === localDeviceId ? " (this app)" : ""}
                          </span>
                          <span className="pb-dev-kind">{d.kind}</span>
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
