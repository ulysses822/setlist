import { invoke } from "@tauri-apps/api/core";

export interface AppConfig {
  client_id: string;
  data_dir: string;
}

export interface Profile {
  id: string;
  display_name: string | null;
}

export interface PlaylistSummary {
  spotify_id: string;
  name: string;
  track_count: number;
  file: string | null;
  error: string | null;
}

export interface ProbeStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface TrackEntry {
  id: string;
  isrc: string | null;
  title: string;
  artists: string[];
  added_at: string | null;
  added_by: string | null;
  duration_ms: number | null;
  // false = greyed out / unplayable on Spotify; null on playlists pulled before this existed.
  is_playable?: boolean | null;
}

export interface PlaylistFile {
  spotify_id: string;
  name: string;
  description: string;
  snapshot_id: string;
  last_synced: string;
  cover_url: string | null;
  tracks: TrackEntry[];
}

export interface StagedEdit {
  name: string | null;
  description: string | null;
  tracks: TrackEntry[];
}

export interface NamedPlaylist {
  file: string;
  name: string;
  tracks: TrackEntry[];
}

export interface LocalPlaylist {
  file: string;
  name: string;
  spotify_id: string;
  track_count: number;
  snapshot_id: string;
  modified: boolean;
  archived: boolean;
  pinned: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  artists: string[];
  isrc: string | null;
  album: string | null;
  duration_ms: number | null;
}

export interface ReplacementSuggestion {
  source: "library" | "spotify";
  id: string;
  title: string;
  artists: string[];
  isrc: string | null;
  album: string | null;
  duration_ms: number | null;
  playlist: string | null; // source playlist name when source === "library"
}

export interface LocalTrackHit {
  file: string;
  playlist: string;
  id: string;
  title: string;
  artists: string[];
}

export interface Features {
  acousticness: number;
  danceability: number;
  energy: number;
  instrumentalness: number;
  liveness: number;
  loudness: number;
  speechiness: number;
  tempo: number;
  valence: number;
  key: number;
  mode: number;
}

export interface Aggregates {
  total: number;
  analyzed: number;
  total_duration_ms: number;
  avg_valence: number | null;
  avg_energy: number | null;
  avg_danceability: number | null;
  avg_acousticness: number | null;
  avg_instrumentalness: number | null;
  avg_liveness: number | null;
  avg_speechiness: number | null;
  avg_tempo: number | null;
}

export interface TrackLite {
  id: string;
  title: string;
  artists: string[];
}

export interface SyncStatus {
  remote_changed: boolean;
  baseline_snapshot: string;
  remote_snapshot: string;
  remote_added: TrackLite[];
  remote_removed: TrackLite[];
}

export type PushStrategy = "safe" | "merge" | "overwrite";

export interface UnfollowReport {
  done: number;
  failed: string[]; // per-playlist failure notes, e.g. "Name (HTTP 403: …)"
}

// Which logger template files were written into the data repo (paths relative to its root).
export interface ScaffoldReport {
  created: string[];
  updated: string[];
}

// One changed path in the data repo, with a human summary of what changed.
export interface FileChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  summary: string;
}

// Snapshot of the data repo's git state for the Version-history panel.
export interface RepoStatus {
  branch: string;
  has_remote: boolean;
  has_upstream: boolean;
  ahead: number; // local commits not yet on the remote
  clean: boolean;
  identity_ok: boolean; // git user.name + user.email are set
  changes: FileChange[];
}

export interface PushOutcome {
  pushed: boolean;
  message: string;
}

// Aggregated plays for one track (id is the raw uri; re-key with bareId to join playlists).
export interface PlayStat {
  id: string;
  count: number;
  last_played: string; // ISO-8601
}

export interface HistoryReport {
  has_file: boolean; // false when history/plays.jsonl doesn't exist yet
  tracked_since: string | null; // earliest logged play — the start of the tracking window
  total_plays: number;
  stats: PlayStat[];
}

export interface DeviceInfo {
  id: string;
  name: string;
  kind: string; // "Computer", "Smartphone", "Speaker", …
  is_active: boolean;
}

export interface RemotePlayback {
  device_id: string;
  device_name: string;
  paused: boolean;
  position: number;
  duration: number;
  track_name: string;
  uri: string;
  artists: string[];
  cover: string | null;
  context_uri: string | null; // e.g. "spotify:playlist:…" when playing from a playlist
  linked_from_uri: string | null; // original uri when Spotify relinked to a market equivalent
}

export type PlayerAction = "pause" | "resume" | "next" | "previous" | "seek";

export interface PushResult {
  status: "applied" | "conflict";
  playlist: PlaylistFile | null;
  conflict: SyncStatus | null;
  /** Non-fatal note after a successful push (e.g. Spotify ignored a description clear). */
  warning: string | null;
}

export const api = {
  getConfig: () => invoke<AppConfig>("get_config"),
  setConfig: (clientId: string, dataDir: string) =>
    invoke<void>("set_config", { clientId, dataDir }),
  // Native folder picker (resolves to null if the user cancels).
  pickFolder: () => invoke<string | null>("pick_folder"),
  // Show a folder in the system file explorer.
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  redirectUri: () => invoke<string>("redirect_uri"),
  authStatus: () => invoke<boolean>("auth_status"),
  // One-time, minimal-scope refresh token for the GitHub Actions history poller. Confidential
  // flow (client secret, no PKCE) so the token doesn't rotate; the secret isn't persisted.
  mintHistoryToken: (clientSecret: string) =>
    invoke<string>("mint_history_token", { clientSecret }),
  // Write the listening-history logger (workflow + script) into the configured data repo.
  scaffoldHistoryLogger: () => invoke<ScaffoldReport>("scaffold_history_logger"),
  // Data-repo version control.
  gitRepoStatus: () => invoke<RepoStatus>("git_repo_status"),
  gitSuggestMessage: () => invoke<string>("git_suggest_message"),
  gitCommit: (message: string) => invoke<RepoStatus>("git_commit", { message }),
  gitPush: () => invoke<PushOutcome>("git_push"),
  // Per-track listening stats from the data repo's plays.jsonl (stale-track view).
  historyStats: () => invoke<HistoryReport>("history_stats"),
  // Open an allowlisted external page (GitHub / Spotify dashboard) in the browser.
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  rateLimitStatus: () => invoke<number>("rate_limit_status"),
  login: () => invoke<Profile>("spotify_login"),
  logout: () => invoke<void>("spotify_logout"),
  probeWrite: () => invoke<ProbeStep[]>("probe_write"),
  pullPlaylists: () => invoke<PlaylistSummary[]>("pull_playlists"),
  listRemotePlaylists: () => invoke<PlaylistSummary[]>("list_remote_playlists"),
  pullPlaylist: (spotifyId: string) =>
    invoke<PlaylistSummary>("pull_playlist", { spotifyId }),

  listLocalPlaylists: () => invoke<LocalPlaylist[]>("list_local_playlists"),
  readPlaylist: (file: string) => invoke<PlaylistFile>("read_playlist", { file }),
  stagePlaylist: (
    file: string,
    name: string | null,
    description: string | null,
    tracks: TrackEntry[]
  ) => invoke<void>("stage_playlist", { file, name, description, tracks }),
  getStaged: (file: string) => invoke<StagedEdit | null>("get_staged", { file }),
  readAllPlaylists: () => invoke<NamedPlaylist[]>("read_all_playlists"),
  clearStaged: (file: string) => invoke<void>("clear_staged", { file }),
  setArchived: (file: string, archived: boolean) =>
    invoke<void>("set_archived", { file, archived }),
  setPinned: (file: string, pinned: boolean) =>
    invoke<void>("set_pinned", { file, pinned }),
  createPlaylist: (name: string, description: string) =>
    invoke<LocalPlaylist>("create_playlist", { name, description }),
  deletePlaylist: (file: string) => invoke<void>("delete_playlist", { file }),
  unfollowArchived: () => invoke<UnfollowReport>("unfollow_archived"),
  followPlaylist: (file: string) => invoke<void>("follow_playlist", { file }),
  searchTracks: (query: string) => invoke<SearchResult[]>("search_tracks", { query }),
  suggestReplacement: (track: TrackEntry) =>
    invoke<ReplacementSuggestion | null>("suggest_replacement", { track }),
  searchLocalTracks: (query: string) =>
    invoke<LocalTrackHit[]>("search_local_tracks", { query }),
  // Files of the local playlists containing any of these track uris (bare-id matched).
  trackPlaylists: (trackIds: string[]) =>
    invoke<string[]>("track_playlists", { trackIds }),
  pushPlaylist: (
    file: string,
    name: string,
    description: string,
    tracks: TrackEntry[],
    strategy: PushStrategy
  ) => invoke<PushResult>("push_playlist", { file, name, description, tracks, strategy }),
  syncStatus: (file: string) => invoke<SyncStatus>("sync_status", { file }),
  refreshPlaylist: (file: string) => invoke<PlaylistFile>("refresh_playlist", { file }),
  trackFeatures: (tracks: TrackEntry[]) =>
    invoke<Record<string, Features>>("track_features", { tracks }),

  getAccessToken: () => invoke<string>("get_access_token"),
  playerPlay: (
    deviceId: string,
    contextUri: string | null,
    offsetUri: string | null,
    uris: string[] | null
  ) => invoke<void>("player_play", { deviceId, contextUri, offsetUri, uris }),
  playerTransfer: (deviceId: string, play: boolean) =>
    invoke<void>("player_transfer", { deviceId, play }),
  playerDevices: () => invoke<DeviceInfo[]>("player_devices"),
  playerState: () => invoke<RemotePlayback | null>("player_state"),
  playerCommand: (action: PlayerAction, positionMs?: number) =>
    invoke<void>("player_command", { action, positionMs: positionMs ?? null }),
};
