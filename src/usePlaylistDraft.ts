// The open playlist's edit lifecycle: load it, track whether it has drifted from what's on
// disk and on Spotify, edit it in memory, then save (stage) or push it.
//
// This was the part of Library that was genuinely hard to follow: eight pieces of state and
// two content snapshots that only meant anything together, threaded through a dozen async
// operations that each had to remember to update all of them in the right order. Getting one
// wrong didn't crash anything; it just made the "modified" dot lie, which is the worst kind
// of bug in an app whose whole promise is that you can see what you're about to change.
//
// Gathering them in one file made the coupling declared. Removing it meant noticing that none
// of those pieces were independent: a playlist in the editor is three contents, and `dirty`,
// `staged` and the diff's baseline are all comparisons between them. `draftState.ts` holds
// that model and the comparisons; what is left here is the asynchronous part — reading,
// writing, pushing, and the ordering those need.

import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  api,
  type PlaylistFile,
  type PushStrategy,
  type SyncStatus,
  type TrackEntry,
} from "./api";
import {
  afterEdit,
  afterPersist,
  draftFile,
  isDirty,
  matchesMirror,
  sessionOf,
  type Content,
  type Session,
} from "./draftState";
import { bareId } from "./metricsCalc";
import * as prefs from "./prefs";
import { popSnapshot, recordSnapshot } from "./undo";

/** Stable empty baseline for when nothing is open, so memos keyed on it don't rerun. */
const NO_TRACKS: TrackEntry[] = [];

/**
 * A message for the host's status line. Lives here because this is where most of them are
 * raised.
 */
export type Status = {
  kind: "ok" | "warn" | "err";
  msg: string;
  /**
   * Offered beside the message when what was just done can be taken back.
   *
   * Only for operations that wrote *outside* the open draft — the editor's own edits are
   * undone with the Undo button, which doesn't need a message to hang off and shouldn't
   * depend on one still being on screen. A message carrying this one isn't auto-dismissed,
   * since it's an offer rather than a report.
   */
  undo?: () => Promise<void>;
} | null;

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
  /** Whether there is a step to go back to. False on a freshly opened playlist. */
  canUndo: boolean;
  /**
   * Step the draft back to how it was before the last edit. In-memory only, like any other
   * edit: it re-dirties the draft rather than touching the staged file, so Save is still what
   * writes it and Push is still what sends it.
   */
  undo: () => void;
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

  // The one playlist open in the editor, or null. Everything the UI asks of it — dirty,
  // staged, the diff's baseline, the playlist shown — is derived from this (see draftState.ts)
  // rather than tracked beside it.
  const [session, setSession] = useState<Session | null>(null);
  // Genuinely independent of the content: what long operation is running, what Spotify said,
  // and whether the user asked to see the diff.
  const [busy, setBusy] = useState<DraftBusy>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [conflict, setConflict] = useState<SyncStatus | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  // Steps the editor can go back to, newest last.
  //
  // In a ref, not state, because `undo` has to read the *current* stack: Ctrl+Z auto-repeats
  // when held, and two presses can land before a re-render, which with a state value would
  // pop the same step twice from the same stale closure and swallow one press. The depth is
  // mirrored in state purely so the button's enabled state re-renders.
  const undoStack = useRef<Content[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);

  /**
   * Forget the steps the editor could go back to. Called wherever the draft is *replaced*
   * rather than edited — opening another playlist, pulling, reverting, pushing, or adopting a
   * staged list written by another path. The old steps describe content that is no longer on
   * screen, so stepping back into them would be a surprise rather than an undo.
   *
   * Deliberately not called from `save` or `flush`: those persist what is already on screen,
   * and the steps that got there are still the steps the user took.
   */
  const dropUndoHistory = () => {
    undoStack.current = [];
    setUndoDepth(0);
  };

  /** Record where the draft is, so the edit about to replace it can be stepped back out of. */
  function pushUndo(content: Content) {
    const next = recordSnapshot(undoStack.current, content);
    if (next === undoStack.current) return; // an edit that changed nothing isn't a step
    undoStack.current = next;
    setUndoDepth(next.length);
  }

  /**
   * Put edited content on screen, carrying out whatever `afterEdit` decided — which is only
   * ever deleting a staged file that the edit made redundant.
   */
  function withDraft(s: Session, draft: Content): Session {
    const { session, dropStaged } = afterEdit(s, draft);
    if (dropStaged) {
      // Fire-and-forget: a leftover file that equals the mirror is harmless, and
      // `openPlaylist` clears it too.
      api
        .clearStaged(s.file)
        .then(() => onPlaylistsChanged()) // refresh the sidebar's modified dot
        .catch(() => {});
    }
    return session;
  }

  /**
   * Write what is on screen to disk: stage it, or clear the staged file when the edits
   * cancelled out and the mirror already says the same thing.
   *
   * Returns the session that write produced; throws if it failed. Three callers used to carry
   * their own copy of this (the auto-stage in `openPlaylist`, `flush` and `save`), each with
   * its own stage-or-clear branch and its own pair of flags to set afterwards.
   */
  async function persist(s: Session): Promise<Session> {
    if (matchesMirror(s)) {
      await api.clearStaged(s.file);
    } else {
      await api.stagePlaylist(s.file, s.draft.name, s.draft.description, s.draft.tracks);
    }
    return afterPersist(s);
  }

  // Monotonic ticket for async loads that replace the draft (open/pull/revert/push). A
  // slow response from a playlist the user has already navigated away from must not apply
  // its state (or its sync banner) over the newer playlist.
  const openTicket = useRef(0);

  // A playlist's file is named after the playlist, so pulling or pushing a rename moves it
  // out from under the open editor. The caller rebuilds the session on the new file; this
  // re-reads the goal and column stores, because the backend moved this playlist's entries to
  // the new key and prefs holds both in memory — a later save from the stale copy would
  // undo that.
  async function followRename(file: string) {
    if (file === session?.file) return;
    await prefs.loadPrefs();
  }

  async function openPlaylist(file: string, focusTrackId?: string) {
    // Auto-stage any in-memory edits to the current playlist before (re)loading. Staged
    // edits persist on disk and reload when reopened, so nothing is silently lost. This
    // must also run when re-clicking the playlist that's already open — otherwise the
    // reload below would silently discard unsaved edits.
    if (session && isDirty(session)) {
      try {
        await persist(session);
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
      const [mirror, cached] = await Promise.all([
        api.readPlaylist(file), // canonical = Spotify mirror
        api.getStaged(file), // saved-but-unpushed edits, if any
      ]);
      if (ticket !== openTicket.current) return; // superseded by a newer load

      // Availability (is_playable) lives on the freshly-pulled mirror. Staged edits saved
      // before this field existed (or that just never carried it) would otherwise shadow it
      // and lose the greyed-out state — overlay it back by id.
      const staged: Content | null = cached
        ? {
            name: cached.name ?? mirror.name,
            description: cached.description ?? mirror.description,
            tracks: withAvailability(cached.tracks, mirror.tracks),
          }
        : null;

      const opened = sessionOf(file, mirror);
      // A staged file identical to the mirror holds edits that cancelled out — open on the
      // mirror and drop it, so the playlist doesn't read as modified.
      const redundant = staged != null && matchesMirror({ ...opened, draft: staged });
      setSession(
        staged && !redundant
          ? { ...opened, hasStaged: true, persisted: staged, draft: staged }
          : opened
      );
      dropUndoHistory();
      setShowDiff(false);
      if (redundant) {
        api
          .clearStaged(file)
          .then(() => onLibraryChanged())
          .catch(() => {});
      }

      const shown = staged && !redundant ? staged.tracks : mirror.tracks;
      host.onOpened(focusTrackId);
      host.onTracksLoaded(shown); // background; only fetches tracks we don't already have
      // Check Spotify for drift in the background (don't block opening). Skip while
      // rate-limited (would fail and extend the cooldown) and for local-only playlists
      // (not on Spotify yet, nothing to compare).
      if (!blocked && mirror.spotify_id) {
        api
          .syncStatus(file)
          .then((st) => {
            // Don't apply a stale banner to whatever playlist is open by now.
            if (ticket === openTicket.current) setSync(st.remote_changed ? st : null);
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
    if (!session) return;
    if (
      (isDirty(session) || session.hasStaged) &&
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
      await api.clearStaged(session.file);
      const { file, playlist: mirror } = await api.refreshPlaylist(session.file);
      if (ticket !== openTicket.current) return; // user opened another playlist meanwhile
      await followRename(file);
      setSession(sessionOf(file, mirror));
      dropUndoHistory();
      host.onTracksLoaded(mirror.tracks);
      setSync(null);
      onStatus({ kind: "ok", msg: "Pulled Spotify's current version" });
      onLibraryChanged();
    } catch (e) {
      onStatus({ kind: "err", msg: String(e) });
    } finally {
      if (ticket === openTicket.current) setBusy(null);
    }
  }

  function edit(tracks: TrackEntry[]) {
    if (!session) return;
    pushUndo(session.draft);
    setSession(withDraft(session, { ...session.draft, tracks }));
  }

  // Edit the title/description in the draft (staged on Save, applied on Push).
  function setMeta(patch: Partial<Pick<PlaylistFile, "name" | "description">>) {
    if (!session) return;
    pushUndo(session.draft);
    setSession(withDraft(session, { ...session.draft, ...patch }));
  }

  /**
   * Step back to before the last edit.
   *
   * The step comes from the ref so a held Ctrl+Z can't pop the same one twice; the rest of
   * the session comes from this render, which is safe because nothing else about it — the
   * mirror, what is on disk, which file — changes between two presses.
   */
  function undo() {
    const popped = popSnapshot(undoStack.current);
    if (!popped || !session) return;
    undoStack.current = popped.rest;
    setUndoDepth(popped.rest.length);
    setSession(withDraft(session, popped.snapshot));
  }

  /**
   * Adopt a track list that was staged behind the editor's back — the cross-playlist writes
   * stage the open playlist's file directly, and without this the next Save would push the
   * stale in-memory list back over it.
   *
   * Only the tracks come across, so this takes the draft's name and description to be what
   * the staged file already holds. That is true because every path that writes behind the
   * editor runs from a library panel, and opening one flushes the draft first — a rename
   * typed but not saved is on disk by then.
   */
  function adoptStaged(tracks: TrackEntry[]) {
    dropUndoHistory();
    setSession((s) => {
      if (!s) return s;
      const adopted = { ...s.draft, tracks };
      return { ...s, hasStaged: true, persisted: adopted, draft: adopted };
    });
  }

  // Persist any in-memory edit (stage it, or clear the staged file if the edits cancelled
  // out) so the library-wide views read current data. Returns false if persisting failed —
  // the caller should abort whatever it was about to do.
  async function flush(): Promise<boolean> {
    if (!session || !isDirty(session)) return true;
    try {
      setSession(await persist(session));
      return true;
    } catch (e) {
      onStatus({ kind: "err", msg: String(e) });
      return false;
    }
  }

  async function revert() {
    if (!session) return;
    if (
      (isDirty(session) || session.hasStaged) &&
      !(await confirm("Discard your edits and reload the saved version?", "Discard"))
    )
      return;
    const ticket = ++openTicket.current;
    setBusy("open");
    onStatus(null);
    try {
      await api.clearStaged(session.file); // drop cached edits (local, no Spotify call)
      const mirror = await api.readPlaylist(session.file); // reload canonical mirror
      if (ticket !== openTicket.current) return; // user opened another playlist meanwhile
      setSession(sessionOf(session.file, mirror));
      dropUndoHistory();
      host.onTracksLoaded(mirror.tracks);
      onStatus({ kind: "ok", msg: "Reverted — edits discarded" });
      onLibraryChanged();
    } catch (e) {
      onStatus({ kind: "err", msg: String(e) });
    } finally {
      if (ticket === openTicket.current) setBusy(null);
    }
  }

  async function save() {
    if (!session) return;
    const cancelled = matchesMirror(session);
    setBusy("save");
    onStatus(null);
    try {
      setSession(await persist(session));
      onStatus({
        kind: "ok",
        // `persist` cleared the staged file rather than writing one: the edits cancelled out,
        // so there is nothing to save that Spotify doesn't already have.
        msg: cancelled
          ? "No changes — already matches the Spotify mirror"
          : "Saved (cached locally; not yet pushed to Spotify)",
      });
      onLibraryChanged();
    } catch (e) {
      onStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function push() {
    if (!session) return;
    if (!(await confirm(`Push "${session.draft.name}" to Spotify?`, "Push"))) return;
    void resolveConflict("safe");
  }

  async function resolveConflict(strategy: PushStrategy) {
    if (!session) return;
    const { file, draft } = session;
    const ticket = ++openTicket.current;
    setBusy("push");
    onStatus(null);
    setConflict(null);
    try {
      const res = await api.pushPlaylist(
        file,
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
        // Spotify now holds what was pushed, so the pushed version *is* the mirror.
        setSession(sessionOf(res.file, res.playlist));
        dropUndoHistory();
        setShowDiff(false);
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

  // Memoized because it builds a new object: `Library` keys memos on `draft`, and a fresh
  // identity every render would recompute all of them every render.
  const draft = useMemo(() => (session ? draftFile(session) : null), [session]);

  return {
    selected: session?.file ?? null,
    draft,
    baseline: session?.mirror.tracks ?? NO_TRACKS,
    // Compared on every render rather than tracked. Cheap in practice: when nothing has been
    // edited, `persisted` and `draft` are the same object, which `sameContent` answers on the
    // first line — and when something has, the comparison stops at the first difference.
    dirty: session ? isDirty(session) : false,
    staged: session?.hasStaged ?? false,
    busy,
    sync,
    conflict,
    dismissConflict: () => setConflict(null),
    dismissSync: () => setSync(null),
    closeDeleted: () => {
      setSession(null);
      dropUndoHistory();
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
    canUndo: undoDepth > 0,
    undo,
    adoptStaged,
  };
}
