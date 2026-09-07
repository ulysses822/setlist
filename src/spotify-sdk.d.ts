// Types for the Spotify Web Playback SDK.
//
// The SDK ships no types and is loaded at runtime from sdk.scdn.co, so everything it hands
// back arrived as `any` and nothing in player.tsx was checked: a typo in `track_window` or
// `linked_from` would have read as undefined and quietly blanked the now-playing bar.
//
// Deliberately partial. This declares the surface player.tsx actually touches and nothing
// else — a fuller transcription of Spotify's docs would be a second source of truth to keep
// in sync, and the parts we don't call can't break us. If you start using another method,
// add it here rather than reaching for `any`.

/** A track as the SDK reports it — a subset of Spotify's full track object. */
export interface SpotifyWebPlaybackTrack {
  name: string;
  uri: string;
  artists?: { name: string }[];
  album?: { images?: { url: string }[] };
  /** Set when the played track is a relink of the one that was requested (regional catalogues). */
  linked_from?: { uri: string };
}

export interface SpotifyWebPlaybackState {
  paused: boolean;
  position: number;
  duration: number;
  context?: { uri: string | null };
  track_window?: { current_track?: SpotifyWebPlaybackTrack };
}

interface SpotifyDeviceEvent {
  device_id: string;
}

interface SpotifyErrorEvent {
  message: string;
}

export interface SpotifyPlayer {
  addListener(event: "ready" | "not_ready", cb: (e: SpotifyDeviceEvent) => void): boolean;
  addListener(
    event: "player_state_changed",
    cb: (state: SpotifyWebPlaybackState | null) => void
  ): boolean;
  addListener(
    event: "initialization_error" | "authentication_error" | "account_error" | "playback_error",
    cb: (e: SpotifyErrorEvent) => void
  ): boolean;
  connect(): Promise<boolean>;
  disconnect(): void;
  getCurrentState(): Promise<SpotifyWebPlaybackState | null>;
  setVolume(volume: number): Promise<void>;
  togglePlay(): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  seek(positionMs: number): Promise<void>;
}

interface SpotifyPlayerOptions {
  name: string;
  /**
   * The SDK asks for a token by handing over a callback and then waiting — the request isn't
   * finished until `cb` is called, however long that takes. See the handler in player.tsx.
   */
  getOAuthToken: (cb: (token: string) => void) => void;
  volume?: number;
}

declare global {
  interface Window {
    /** Present only once the SDK script has loaded. */
    Spotify?: {
      Player: new (options: SpotifyPlayerOptions) => SpotifyPlayer;
    };
    /** The SDK calls this when it's ready; it must exist before the script runs. */
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}
