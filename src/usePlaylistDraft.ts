// The open playlist's edit lifecycle: load it, track whether it has drifted from what's on
// disk and on Spotify, edit it in memory, then save (stage) or push it.
//
// This is the part of Library that was genuinely hard to follow — eight pieces of state and
// two content snapshots that only mean anything together, threaded through a dozen async
// operations that each had to remember to update all of them in the right order. Getting one
// wrong doesn't crash anything; it just makes the "modified" dot lie, which is the worst kind
// of bug in an app whose whole promise is that you can see what you're about to change.
//
// Gathering them here doesn't remove the coupling, but it does make it declared: the host's
// contribution is the `DraftHost` below and nothing else, and the invariants live next to the
// state they constrain.

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  api,
  type PlaylistFile,
  type PushStrategy,
  type SyncStatus,
  type TrackEntry,
} from "./api";
import { bareId } from "./metricsCalc";
import * as prefs from "./prefs";

/**
 * A message for the host's status line. Lives here because this is where most of them are
 * raised.
 */
export type Status = { kind: "ok" | "warn" | "err"; msg: string } | null;

/**
 * Which long-running draft operation is in flight. The sidebar's own list load is tracked
 * separately by the host — it can overlap these, and clearing one must not clear the other.
 */
export type DraftBusy = "open" | "save" | "push" | null;

/** What the draft lifecycle needs from the component hosting it. */
export interface DraftHost {
  /**
   * True while Spotify's rate limit is in force: the background drift check is skipped
   * rather than issuing a call that would fail and extend the cooldown.
   */
  blocked: boolean;
  confirm: (message: string, confirmLabel: string) => Promise<boolean>;
  onStatus: (status: Status) => void;
  /**
   * Staged edits changed. Cheap: staging writes only to the gitignored `staged/` directory,
   * so the sidebar's modified dot moves but the data repo hasn't.
   */
  onPlaylistsChanged: () => void;
  /** A playlist file itself changed, so the data-repo chip needs re-reading too. */
  onLibraryChanged: () => void;
  /**
   * A load is starting — clear host state that shouldn't outlive the previous playlist,
   * and point the per-playlist view choices at `file`.
   */
  onOpening: (file: string) => void;
  /**
   * A track list arrived (from an open, a pull, or a revert): a chance to fetch whatever
   * audio features it needs. Separate from `onOpened` because a pull and a revert replace
   * the tracks without being an "open".
   */
  onTracksLoaded: (tracks: TrackEntry[]) => void;
  /**
   * A playlist finished loading into the editor: reset the host's per-playlist view state,
   * and scroll to `focusTrackId` if the open came from a song search.
   */
  onOpened: (focusTrackId?: string) => void;
}

export interface PlaylistDraft {
  /** File name of the open playlist, or null when none is open. */
  selected: string | null;
  /** The playlist being edited: the staged edit if one existed, else the Spotify mirror. */
  draft: PlaylistFile | null;
  /** The mirror's track order, which the inline diff compares against. */
  baseline: TrackEntry[];
  /** In-memory edits not yet written to the staged file. */
  dirty: boolean;
  /** Saved to the staged file, but not yet pushed to Spotify. */
  staged: boolean;
  busy: DraftBusy;
  /** Set when Spotify changed since the last sync — drives the drift banner. */
  sync: SyncStatus | null;
  /** Set when a push was refused because of that drift — drives the conflict modal. */
  conflict: SyncStatus | null;
  dismissConflict: () => void;
  /** Dismiss the "Spotify changed since your last sync" banner without acting on it. */
  dismissSync: () => void;
  /** Clear the editor because the open playlist no longer exists (it was deleted). */
  closeDeleted: () => void;
  showDiff: boolean;
  setShowDiff: Dispatch<SetStateAction<boolean>>;

  /**
   * Named `openPlaylist`, not `open`, and it has to stay that way. Library destructures
   * this interface into bare names; `open` collides with `window.open`, whose signature
   * `(url?: string, target?: string)` happily accepts `open(file, trackId)`. Leave it off the
   * destructuring list and every call site type-checks, builds, and opens a popup instead of
   * a playlist — which is exactly what shipped once.
   */
  openPlaylist: (file: string, focusTrackId?: string) => Promise<void>;
  /** Replace the local copy with Spotify's, discarding local edits (asks first). */
  pullRemote: () => Promise<void>;
  /** Drop unsaved edits and reload the last saved version (asks first). */
  revert: () => Promise<void>;
  /** Write the in-memory edits to the staged file. */
  save: () => Promise<void>;
  /** Push to Spotify, refusing on drift (asks first). */
  push: () => Promise<void>;
  /** Push again with the user's chosen resolution after a conflict. */
  resolveConflict: (strategy: PushStrategy) => Promise<void>;
  /**
   * Stage whatever is in memory before the host navigates away. False if it couldn't be
   * written — the caller should stay put rather than lose the edits.
   */
  flush: () => Promise<boolean>;

  edit: (tracks: TrackEntry[]) => void;
  setMeta: (patch: Partial<Pick<PlaylistFile, "name" | "description">>) => void;
  /**
   * Adopt a track list that was staged behind the editor's back — the cross-playlist
   * duplicate normalizer writes the open playlist's staged file directly, and without this
   * the next Save would push the stale in-memory list back over it.
   */
  adoptStaged: (tracks: TrackEntry[]) => void;
}

// Overlay availability (is_playable) from the canonical mirror onto an edited track list,
// matched by bare Spotify id. Staged edits don't carry is_playable, so without this the
// greyed-out state is lost whenever a playlist has unpushed edits. Tracks not in the mirror
// (e.g. just added from search) keep their own value.
function withAvailability(tracks: TrackEntry[], mirror: TrackEntry[]): TrackEntry[] {
  const avail = new Map(mirror.map((t) => [bareId(t.id), t.is_playable]));
  return tracks.map((t) => {
    const a = avail.get(bareId(t.id));
    return a === undefined ? t : { ...t, is_playable: a };
  });
}

export function usePlaylistDraft(host: DraftHost): PlaylistDraft {
  const { blocked, confirm, onStatus, onPlaylistsChanged, onLibraryChanged } = host;

  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlaylistFile | null>(null);
  const [baseline, setBaseline] = useState<TrackEntry[]>([]); // canonical Spotify-mirror order
  const [showDiff, setShowDiff] = useState(false); // inline "Show changes" review mode
  const [dirty, setDirty] = useState(false); // in-memory edits not yet staged
  const [staged, setStaged] = useState(false); // saved (cached) but not pushed
  const [busy, setBusy] = useState<DraftBusy>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [conflict, setConflict] = useState<SyncStatus | null>(null);

  // Content snapshot of the last persisted (staged-or-canonical) version of the open
  // playlist. "Dirty" means the draft differs from this — so edits that cancel out (add a
  // song then remove it, swap two songs then swap back) clear the flag again rather than
  // sticking forever.
  const persistedRef = useRef("");
  const contentKey = (name: string, description: string, tracks: TrackEntry[]) =>
    `${name}\u0000${description}\u0000${tracks.map((t) => t.id).join("\u0001")}`;
  const markPersisted = (name: string, description: string, tracks: TrackEntry[]) => {
    persistedRef.current = contentKey(name, description, tracks);
  };
  // Content snapshot of the canonical Spotify mirror (ignores staged edits). When the
  // draft returns to exactly this — e.g. a song was added, staged, then removed again —
  // the staged copy holds nothing real and is dropped so "modified" clears everywhere.
  const canonicalRef = useRef("");

  // Monotonic ticket for async loads that replace the draft (open/pull/revert/push). A
  // slow response from a playlist the user has already navigated away from must not apply
  // its state (or its sync banner) over the newer playlist.
  const openTicket = useRef(0);

  // A playlist's file is named after the playlist, so pulling or pushing a rename moves it
  // out from under the open editor. Re-point at where it landed, and re-read the goal and
  // column stores — the backend moved this playlist's entries to the new key and prefs holds
  // both in memory, so a later save from the stale copy would undo that.
  async function followRename(file: string) {
    if (file === selected) return;
    setSelected(file);
    await prefs.loadPrefs();
  }

  async function openPlaylist(file: string, focusTrackId?: string) {
    // Auto-stage any in-memory edits to the current playlist before (re)loading. Staged
    // edits persist on disk and reload when reopened, so nothing is silently lost. This
    // must also run when re-clicking the playlist that's already open — otherwise the
    // reload below would silently discard unsaved edits.
    if (dirty && draft && selected) {
      try {
        // Edits that cancelled out don't warrant a staged file — clear instead of stage.
        if (contentKey(draft.name, draft.description, draft.tracks) === canonicalRef.current) {
          await api.clearStaged(selected);
        } else {
          await api.stagePlaylist(selected, draft.name, draft.description, draft.tracks);
        }
        onPlaylistsChanged(); // refresh modified dot
      } catch (e) {
        onStatus({ kind: "err", msg: String(e) });
        return; // couldn't preserve the edits — stay put rather than lose them
      }
    }
    const ticket = ++openTicket.current;
    setBusy("open");
    onStatus(null);
    setSync(null);
    setConflict(null);
    // Keep the feature map across playlist switches: features are keyed by track id and are
    // identical wherever a track appears, so reusing them avoids a frame of empty metrics,
    // which reads as a jarring flicker. Only the per-playlist view choices reset.
    host.onOpening(file);
    try {
      const pf = await api.readPlaylist(file); // canonical = Spotify mirror
      const cached = await api.getStaged(file); // saved-but-unpushed edits, if any
      if (ticket !== openTicket.current) return; // superseded by a newer load
      // Availability (is_playable) lives on the freshly-pulled mirror. Staged edits saved
      // before this field existed (or that just never carried it) would otherwise shadow it
      // and lose the greyed-out state — overlay it back by id.
      const stagedTracks = cached ? withAvailability(cached.tracks, pf.tracks) : null;
      const tracks = stagedTracks ?? pf.tracks;
      setSelected(file);
      setBaseline(pf.tracks); // diff against the Spotify mirror
      setShowDiff(false);
      const merged =
        cached && stagedTracks
          ? {
              ...pf,
              name: cached.name ?? pf.name,
              description: cached.description ?? pf.description,
              tracks: stagedTracks,
            }
          : pf;
      setDraft(merged);
      markPersisted(merged.name, merged.description, merged.tracks);
      canonicalRef.current = contentKey(pf.name, pf.description, pf.tracks);
      let isStaged = cached != null;
      if (isStaged && persistedRef.current === canonicalRef.current) {
        // Leftover staged file identical to the mirror (edits that cancelled out) —
        // drop it so the playlist doesn't read as modified.
        isStaged = false;
        api
          .clearStaged(file)
          .then(() => onLibraryChanged())
          .catch(() => {});
      }
      setStaged(isStaged);
      setDirty(false);
      host.onOpened(focusTrackId);
      host.onTracksLoaded(tracks); // background; only fetches tracks we don't already have
      // Check Spotify for drift in the background (don't block opening). Skip while
      // rate-limited (would fail and extend the cooldown) and for local-only playlists
      // (not on Spotify yet, nothing to compare).
      if (!blocked && pf.spotify_id) {
        api
          .syncStatus(file)
          .then((s) => {
            // Don't apply a stale banner to whatever playlist is open by now.
            if (ticket === openTicket.current) setSync(s.remote_changed ? s : null);
          })
          .catch(() => {});
      }
    } catch (e) {
      onStatus({ kind: "err", msg: String(e) });
    } finally {
      if (ticket === openTicket.current) setBusy(null);
    }
  }

  // Pull Spotify's current version into the canonical mirror (discards local edits).
  async function pullRemote() {
    if (!selected) return;
    if (
      (dirty || staged) &&
      !(await confirm(
        "Pull Spotify's version? This discards your local edits.",
        "Pull & discard"
      ))
    )
      return;
    const ticket = ++openTicket.current;
    setBusy("open");
    onStatus(null);
    try {
      await api.clearStaged(selected);
      const { file, playlist: pf } = await api.refreshPlaylist(selected);
      if (ticket !== openTicket.current) return; // user opened another playlist meanwhile
      await followRename(file);
      setDraft(pf);
      markPersisted(pf.name, pf.description, pf.tracks);
      canonicalRef.current = persistedRef.current;
      setBaseline(pf.tracks);
      host.onTracksLoaded(pf.tracks);
      setDirty(false);
      setStaged(false);
      setSync(null);
      onStatus({ kind: "ok", msg: "Pulled Spotify's current version" });
      onLibraryChanged();
    } catch (e) {
      onStatus({ kind: "err", msg: String(e) });
    } finally {
      if (ticket === openTicket.current) setBusy(null);
    }
  }

  // Recompute dirty after a draft change. If the content lands back on exactly the
  // Spotify mirror, any staged copy only holds the now-cancelled edits — drop it so the
  // modified indicators (unsaved tag, sidebar dot, Save/Push buttons) clear everywhere.
  function syncDirty(next: PlaylistFile) {
    const key = contentKey(next.name, next.description, next.tracks);
    if (key !== persistedRef.current && key === canonicalRef.current && selected) {
      persistedRef.current = key;
      setStaged(false);
      api
        .clearStaged(selected)
        .then(() => onPlaylistsChanged()) // refresh the sidebar's modified dot
        .catch(() => {}); // a leftover equal-to-mirror staged file is harmless; openPlaylist() cleans it too
    }
    setDirty(key !== persistedRef.current);
  }

  function edit(tracks: TrackEntry[]) {
    if (!draft) return;
    const next = { ...draft, tracks };
    setDraft(next);
    syncDirty(next);
  }

  // Edit the title/description in the draft (staged on Save, applied on Push).
  function setMeta(patch: Partial<Pick<PlaylistFile, "name" | "description">>) {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    syncDirty(next);
  }

  function adoptStaged(tracks: TrackEntry[]) {
    setDraft((d) => {
      if (!d) return d;
      // Recording the snapshot here is idempotent, so it's safe in the updater.
      markPersisted(d.name, d.description, tracks);
      return { ...d, tracks };
    });
    setDirty(false);
    setStaged(true);
  }

  // Persist any in-memory edit (stage it, or clear the staged file if the edits cancelled
  // out) so the library-wide views read current data. Returns false if persisting failed —
  // the caller should abort whatever it was about to do.
  async function flush(): Promise<boolean> {
    if (!(dirty && draft && selected)) return true;
    try {
      // Edits that cancelled out don't warrant a staged file — clear instead of stage.
      if (contentKey(draft.name, draft.description, draft.tracks) === canonicalRef.current) {
        await api.clearStaged(selected);
        setStaged(false);
      } else {
        await api.stagePlaylist(selected, draft.name, draft.description, draft.tracks);
        setStaged(true);
      }
      markPersisted(draft.name, draft.description, draft.tracks);
      setDirty(false);
      return true;
    } catch (e) {
      onStatus({ kind: "err", msg: String(e) });
      return false;
    }
  }

  async function revert() {
    if (!selected) return;
    if (
      (dirty || staged) &&
      !(await confirm("Discard your edits and reload the saved version?", "Discard"))
    )
      return;
    const ticket = ++openTicket.current;
    setBusy("open");
    onStatus(null);
    try {
      await api.clearStaged(selected); // drop cached edits (local, no Spotify call)
      const pf = await api.readPlaylist(selected); // reload canonical mirror
      if (ticket !== openTicket.current) return; // user opened another playlist meanwhile
      setDraft(pf);
      markPersisted(pf.name, pf.description, pf.tracks);
      canonicalRef.current = persistedRef.current;
      setBaseline(pf.tracks);
      host.onTracksLoaded(pf.tracks);
      setDirty(false);
      setStaged(false);
      onStatus({ kind: "ok", msg: "Reverted — edits discarded" });
      onLibraryChanged();
    } catch (e) {
      onStatus({ kind: "err", msg: String(e) });
    } finally {
      if (ticket === openTicket.current) setBusy(null);
    }
  }

  async function save() {
    if (!draft || !selected) return;
    setBusy("save");
    onStatus(null);
    try {
      if (contentKey(draft.name, draft.description, draft.tracks) === canonicalRef.current) {
        // Edits cancelled out — nothing differs from the Spotify mirror, so saving would
        // only create a no-op staged file. Clear any existing one instead.
        await api.clearStaged(selected);
        markPersisted(draft.name, draft.description, draft.tracks);
        setDirty(false);
        setStaged(false);
        onStatus({ kind: "ok", msg: "No changes — already matches the Spotify mirror" });
      } else {
        await api.stagePlaylist(selected, draft.name, draft.description, draft.tracks);
        setStaged(true);
        markPersisted(draft.name, draft.description, draft.tracks);
        setDirty(false);
        onStatus({ kind: "ok", msg: "Saved (cached locally; not yet pushed to Spotify)" });
      }
      onLibraryChanged();
    } catch (e) {
      onStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function push() {
    if (!draft) return;
    if (!(await confirm(`Push "${draft.name}" to Spotify?`, "Push"))) return;
    void resolveConflict("safe");
  }

  async function resolveConflict(strategy: PushStrategy) {
    if (!draft || !selected) return;
    const ticket = ++openTicket.current;
    setBusy("push");
    onStatus(null);
    setConflict(null);
    try {
      const res = await api.pushPlaylist(
        selected,
        draft.name,
        draft.description,
        draft.tracks,
        strategy
      );
      if (ticket !== openTicket.current) {
        // The push itself landed, but the user opened another playlist meanwhile — just
        // refresh the sidebar instead of overwriting the newer editor state.
        onLibraryChanged();
        return;
      }
      if (res.status === "conflict" && res.conflict) {
        setConflict(res.conflict);
        onStatus({
          kind: "err",
          msg: "Spotify changed since your last sync — choose how to resolve.",
        });
        return;
      }
      if (res.playlist) {
        await followRename(res.file);
        setDraft(res.playlist);
        markPersisted(res.playlist.name, res.playlist.description, res.playlist.tracks);
        canonicalRef.current = persistedRef.current;
        setBaseline(res.playlist.tracks);
        setShowDiff(false);
        setDirty(false);
        setStaged(false);
        setSync(null);
        onStatus(
          res.warning
            ? { kind: "warn", msg: res.warning }
            : {
                kind: "ok",
                msg: `Pushed — Spotify now matches (${res.playlist.tracks.length} tracks)`,
              }
        );
        onLibraryChanged();
      }
    } catch (e) {
      onStatus({ kind: "err", msg: String(e) });
    } finally {
      if (ticket === openTicket.current) setBusy(null);
    }
  }

  return {
    selected,
    draft,
    baseline,
    dirty,
    staged,
    busy,
    sync,
    conflict,
    dismissConflict: () => setConflict(null),
    dismissSync: () => setSync(null),
    closeDeleted: () => {
      setSelected(null);
      setDraft(null);
      setDirty(false);
      setStaged(false);
    },
    showDiff,
    setShowDiff,
    openPlaylist,
    pullRemote,
    revert,
    save,
    push,
    resolveConflict,
    flush,
    edit,
    setMeta,
    adoptStaged,
  };
}
