import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type LocalPlaylist,
  type LocalTrackHit,
  type StagedEdit,
  type TrackEntry,
} from "./api";
import MetricsPanel from "./MetricsPanel";
import { usePlaylistMetrics } from "./usePlaylistMetrics";
import { usePlaylistDraft, type Status } from "./usePlaylistDraft";
import { usePlaylistLibrary } from "./usePlaylistLibrary";
import { bareId, FEATURE_META, isLocalTrack } from "./metricsCalc";
import { removeExactDuplicates, removeTracksByIds, type CrossDupGroup } from "./lint";
import {
  appendMissing,
  removeAtIndices,
  sortTracks,
  toggleSelection,
  type SortDir,
  type SortKey,
} from "./trackList";
import { usePlaylistDoctor } from "./usePlaylistDoctor";
import IssuesStrip from "./IssuesStrip";
import LibraryOverlay, {
  emptyOverlay,
  type Overlay,
  type OverlayKind,
} from "./LibraryOverlay";
import { fmtTotal } from "./format";
import {
  ConfirmModal,
  ConflictModal,
  CreatePlaylistModal,
  DeletePlaylistModal,
  MergePlaylistModal,
} from "./modals";
import { useNowPlaying } from "./player";
import AddBox from "./AddBox";
import { usePlaylistAdder } from "./usePlaylistAdder";
import { useGit } from "./git";
import { diffTracks } from "./playlistDiff";
import TrackRow, { TRACK_MIME, type RowStatus } from "./TrackRow";
import { useRateLimit } from "./rateLimit";

type SidebarMode = "playlists" | "songs";

/**
 * One playlist's staging as it was before a cross-playlist write, which is all it takes to
 * put that write back. `staged` is null when the playlist had no staged edit at all — a
 * distinct state from an empty one, and the difference between "unmodified" and "modified to
 * match the mirror" in the sidebar.
 */
interface StagedBefore {
  file: string;
  staged: StagedEdit | null;
}

// Column choices, mood goals and the outlier method all live in the data folder now — see
// prefs.ts for why. These stay synchronous because they run during render; prefs holds both
// stores in memory after a single load at startup.

function move<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// Minimalist toolbar icons (inline SVG, currentColor) for the library overview tools —
// matched to the filled-glyph style used by the player controls.
const IcoSongs = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor" aria-hidden="true">
    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
  </svg>
);
const IcoClean = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor" aria-hidden="true">
    <path d="M11 2l1.7 6.3L19 10l-6.3 1.7L11 18l-1.7-6.3L3 10l6.3-1.7L11 2z" />
    <path d="M18.5 13l.85 2.65L22 16.5l-2.65.85L18.5 20l-.85-2.65L15 16.5l2.65-.85L18.5 13z" />
  </svg>
);
const IcoClock = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor" aria-hidden="true">
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z" />
    <path d="M12.5 7H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
  </svg>
);
const IcoStatus = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor" aria-hidden="true">
    <path d="M5 10h3v9H5zM10.5 5h3v14h-3zM16 13h3v6h-3z" />
  </svg>
);
const IcoMap = () => (
  <svg viewBox="0 0 24 24" className="ico" fill="currentColor" aria-hidden="true">
    <circle cx="6" cy="7.5" r="2.2" />
    <circle cx="17" cy="6" r="2.2" />
    <circle cx="9" cy="16.5" r="2.2" />
    <circle cx="18.5" cy="15.5" r="2.2" />
  </svg>
);

export default function Library() {
  const [mode, setMode] = useState<SidebarMode>("playlists");
  const [filter, setFilter] = useState("");
  const [hits, setHits] = useState<LocalTrackHit[]>([]);

  // Editor view state that belongs to this component rather than to the draft: how the
  // track list is sorted, and the message line every operation reports through.
  const [sortKey, setSortKey] = useState<SortKey>("index");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [status, setStatus] = useState<Status>(null);

  // Ticked rows, as draft indices (see `toggleSelection` for why not ids), and the screen
  // position a shift-click measures its range from.
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [selectAnchor, setSelectAnchor] = useState<number | null>(null);

  const dragIndex = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // sidebar playlist being dragged onto
  // In-app replacement for window.confirm(): a styled modal that resolves a promise.
  const [confirmState, setConfirmState] = useState<{
    message: string;
    confirmLabel: string;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const [menuOpen, setMenuOpen] = useState(false); // editor header ⋮ menu
  const [editMeta, setEditMeta] = useState(false); // editing title/description inline
  const [mergeOpen, setMergeOpen] = useState(false); // playlist picker for a merge
  const [merging, setMerging] = useState(false);


  // The library-wide panel currently taking over the editor pane, if any, and whether its
  // loader is still running. One value for all five (see LibraryOverlay): they are
  // alternatives, so opening one cannot leave another behind.
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [overlayBusy, setOverlayBusy] = useState(false);

  // Everything audio-feature-shaped for the open playlist — the cache, the derived
  // aggregates/outliers/goal, and the column and panel choices — lives in one hook. Named
  // back out here so the render reads the same as it always did.
  // The open playlist's whole edit lifecycle — load, dirty/staged tracking, save, push —
  // lives in one hook (see usePlaylistDraft). Named back out here so the render is unchanged.
  const player = useNowPlaying();
  const git = useGit();
  const { blocked } = useRateLimit();

  // Which playlists exist, and every operation that changes that (see usePlaylistLibrary).
  // It knows nothing about the editor: `create` hands back the new playlist and `onDeleted`
  // reports the file that went, leaving both editor decisions here — which is what keeps the
  // two hooks from depending on each other.
  const lib = usePlaylistLibrary({
    onStatus: setStatus,
    confirm: confirmDialog,
    refreshGit: () => git?.refresh(),
    // Closes over `selected` and `draftApi`, declared just below. Safe because nothing calls
    // this until a delete happens, long after both exist — the same forward reference the
    // draft's own `onPlaylistsChanged` makes back the other way.
    onDeleted: (file) => {
      if (selected === file) draftApi.closeDeleted();
    },
  });
  const {
    playlists,
    listBusy,
    archivedFiles,
    togglePin,
    toggleArchive,
    unfollowArchivedAll,
    refollow,
    createOpen,
    setCreateOpen,
    creating,
    deleteTarget,
    setDeleteTarget,
    deleting,
  } = lib;
  const loadList = lib.reload;

  // The two places the collection meets the editor: a playlist you just made should open,
  // and one you just deleted should stop being open.
  async function doCreate(name: string, description: string) {
    const np = await lib.create(name, description);
    if (np) void openPlaylist(np.file);
  }
  const doDelete = lib.remove;

  const draftApi = usePlaylistDraft({
    blocked,
    confirm: confirmDialog,
    onStatus: setStatus,
    // Staged-only change, so skip the data-repo re-read (see loadList).
    onPlaylistsChanged: () => void loadList(false),
    onLibraryChanged: () => void loadList(),
    onOpening: (file) => {
      // Forward reference to the adder below, safe for the same reason `doctor.reset()` in
      // `onOpened` is: nothing calls this until a playlist is opened, long after both exist.
      adder.reset();
      metrics.resetFor(file); // this playlist's saved columns and mood goal
    },
    onTracksLoaded: (tracks) => metrics.loadFeatures(tracks),
    onOpened: (focusTrackId) => {
      setSortKey("index"); // open in official order
      setSortDir("asc");
      // Collapse the cleanup panel so it doesn't arrive open on the new playlist. Forward
      // reference to the hook below, safe for the same reason `onDeleted` above is: nothing
      // calls this until a playlist is opened, long after both exist.
      doctor.reset();
      setOverlay(null); // a playlist takes the pane back from whichever panel had it
      setEditMeta(false);
      if (focusTrackId) setFocusTrack(focusTrackId);
    },
  });
  const {
    selected,
    draft,
    baseline,
    dirty,
    staged,
    busy,
    sync,
    conflict,
    showDiff,
    setShowDiff,
    edit,
    setMeta,
    canUndo,
    undo,
    save,
    push,
    revert,
    pullRemote,
    flush,
    openPlaylist,
  } = draftApi;

  const metrics = usePlaylistMetrics(selected, draft?.tracks ?? null);

  // What's wrong with the open playlist, and the fixes for it (see usePlaylistDoctor). Reads
  // the draft rather than the file, so it re-lints as you edit and every fix lands as an edit
  // you can review in the diff before it is pushed.
  const doctor = usePlaylistDoctor({
    tracks: draft?.tracks ?? null,
    edit,
    onStatus: setStatus,
    onReplaced: (track) => metrics.loadFeatures([track]),
  });
  // Getting songs in: the catalog search and the four ways a track reaches the draft
  // (see usePlaylistAdder). Like the doctor, it only needs the track list and a way to edit it.
  const adder = usePlaylistAdder({
    tracks: draft?.tracks ?? null,
    edit,
    onStatus: setStatus,
    onAdded: (added) => metrics.loadFeatures(added),
    blocked,
  });

  const {
    featureMap,
    setFeatureMap,
    featureOf,
    loadFeatures,
    analyzing,
    metricsLoading,
    showAnalyzing,
    metricsOpen,
    setMetricsOpen,
    cols,
    toggleCol,
    colPicker,
    setColPicker,
    aggregates,
    outliers,
    outlierMode,
    setOutlierMode,
    goal,
    goalDeviations,
    goalControl,
  } = metrics;

  const tracksRef = useRef<HTMLOListElement>(null);
  const [focusTrack, setFocusTrack] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  useEffect(() => {
    void loadList();
  }, []);

  // Success/status popups are transient: auto-dismiss after a few seconds. Errors stay
  // until dismissed so they aren't missed.
  useEffect(() => {
    // A message offering an undo stays until it's used or dismissed: it's an offer, not a
    // report, and four seconds is not long enough to decide.
    if (status?.kind !== "ok" || status.undo) return;
    const t = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(t);
  }, [status]);

  // Ctrl+Z / Cmd+Z steps the draft back. Skipped while the cursor is in a text field, where
  // the browser's own undo is what's wanted and is the only thing that can undo typing —
  // the draft's snapshots are per-edit, so they'd throw away a half-typed name wholesale.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "z" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (!canUndo) return;
      e.preventDefault();
      undo();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canUndo, undo]);

  // Any change to the track list invalidates the selection, because it is held as indices:
  // a removal, a reorder or an add renumbers rows, and a stale index would point at whatever
  // moved into its place. `edit` replaces the array on every change, so this fires on each
  // one — including the bulk removal itself, which should clear the tick boxes anyway. A
  // title or description edit keeps the same array and leaves the selection alone.
  useEffect(() => {
    setSelection(new Set());
    setSelectAnchor(null);
  }, [draft?.tracks]);

  // Open a styled confirmation modal; resolves true (confirm) or false (cancel/dismiss).
  function confirmDialog(message: string, confirmLabel = "OK"): Promise<boolean> {
    return new Promise((resolve) => setConfirmState({ message, confirmLabel, resolve }));
  }
  function resolveConfirm(ok: boolean) {
    setConfirmState((cur) => {
      cur?.resolve(ok);
      return null;
    });
  }

  // Fetch audio features for the given tracks in the background and merge them in.
  // Non-blocking: rows render immediately, numbers fill in when the fetch resolves. Tracks
  // already in the map are skipped (features are id-keyed and stable across playlists).

  function removeAt(i: number) {
    if (!draft) return;
    edit(draft.tracks.filter((_, idx) => idx !== i));
  }

  /**
   * A row's checkbox was clicked. `row` is its position on screen, so a shift-click selects
   * the run the eye sees rather than the run the file happens to hold.
   */
  function pickTrack(row: number, shift: boolean) {
    const displayed = orderedTracks.map(({ i }) => i);
    setSelection((cur) => toggleSelection(cur, displayed, row, shift, selectAnchor));
    // The anchor follows the last plain click. Keeping it across a shift-click is what lets
    // someone widen or narrow a range by shift-clicking again.
    if (!shift) setSelectAnchor(row);
  }

  /** Tick every row currently on screen, or clear the lot if they're all ticked already. */
  function toggleSelectAll() {
    const displayed = orderedTracks.map(({ i }) => i);
    const all = displayed.length > 0 && displayed.every((i) => selection.has(i));
    setSelection(all ? new Set() : new Set(displayed));
    setSelectAnchor(null);
  }

  /**
   * Remove every ticked row at once. One edit, not one per row: each removal renumbers
   * everything after it, so removing them one at a time would take the wrong tracks.
   *
   * Like every other edit it goes to the draft, so a bulk removal is reviewable in the diff
   * and reaches Spotify only on push.
   */
  function removeSelected() {
    if (!draft || selection.size === 0) return;
    const n = selection.size;
    edit(removeAtIndices(draft.tracks, selection));
    setStatus({
      kind: "ok",
      msg: `Removed ${n} song${n === 1 ? "" : "s"} — review the changes and push when you're happy with it`,
    });
  }

  // Open one of the library-wide panels: stage any pending edits (the panels read from disk,
  // so unsaved work would be invisible to them), show the panel immediately in its loading
  // state, then fill it in. One entry point for all five — the previous five near-identical
  // openers each had to remember to close the other four.
  async function openOverlay(kind: OverlayKind, load: () => Promise<Overlay>) {
    if (!(await flush())) return;
    setOverlay(emptyOverlay(kind));
    setOverlayBusy(true);
    try {
      setOverlay(await load());
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setOverlayBusy(false);
    }
  }

  const openSongs = () =>
    openOverlay("songs", async () => ({ kind: "songs", data: await api.readAllPlaylists() }));

  const openDoctor = () =>
    openOverlay("doctor", async () => ({ kind: "doctor", data: await api.readAllPlaylists() }));

  const openStale = () =>
    openOverlay("stale", async () => {
      const [data, history] = await Promise.all([
        api.readAllPlaylists(),
        api.historyStats(),
      ]);
      return { kind: "stale", data, history };
    });

  /**
   * The editor as it is *now*, for callbacks that outlive the render they were made in.
   *
   * `restoreStaged` is reached from a status-line message that can sit on screen for minutes,
   * so its captured `draftApi` would be several renders old by the time it runs — and a stale
   * `openPlaylist` auto-stages using a stale `dirty`/`draft`, which would quietly drop edits
   * made after the message appeared. Written during render, the same way `errorRef` is in
   * player.tsx, and for the same reason.
   */
  const liveRef = useRef({ draftApi, overlayKind: overlay?.kind, openStale: () => openStale() });
  liveRef.current = { draftApi, overlayKind: overlay?.kind, openStale: () => openStale() };

  const openStatus = () =>
    openOverlay("status", async () => {
      const [local, data] = await Promise.all([
        api.listLocalPlaylists(),
        api.readAllPlaylists(),
      ]);
      return { kind: "status", local, data };
    });

  // Needs features for ALL tracks across ALL playlists, so it reuses whatever's already in
  // featureMap and only fetches the rest (cached server-side, so repeat opens are cheap).
  const openSimilarity = () =>
    openOverlay("similarity", async () => {
      const data = await api.readAllPlaylists();
      // Unique tracks across the whole library, minus ones we've already analyzed.
      const seen = new Set<string>();
      const missing: TrackEntry[] = [];
      for (const pl of data) {
        for (const t of pl.tracks) {
          const id = bareId(t.id);
          if (seen.has(id)) continue;
          seen.add(id);
          if (!featureMap[id]) missing.push(t);
        }
      }
      const fetched = missing.length ? await api.trackFeatures(missing) : {};
      const feat = { ...featureMap, ...fetched };
      setFeatureMap(feat); // reuse for the editor's metrics later
      return { kind: "similarity", data, feat };
    });

  // Normalize a cross-playlist near-dup: keep one track id, replace the other variants with
  // it in every playlist they appear in (collapsing any duplicate that creates). Stages each
  // affected playlist so the change is reviewable in its diff before pushing.
  async function normalizeCrossDup(group: CrossDupGroup, keepId: string) {
    const keep = group.variants.find((v) => v.id === keepId);
    // Only reachable from the doctor panel, and it works off the scan that panel is showing.
    const scanned = overlay?.kind === "doctor" ? overlay.data : null;
    if (!keep || !scanned) return;
    const removeIds = new Set(group.variants.filter((v) => v.id !== keepId).map((v) => v.id));
    try {
      let changed = 0;
      for (const pl of scanned) {
        if (!pl.tracks.some((t) => removeIds.has(bareId(t.id)))) continue;
        const replaced = pl.tracks.map((t) =>
          removeIds.has(bareId(t.id))
            ? { ...keep.track, added_at: t.added_at, added_by: t.added_by }
            : t
        );
        const deduped = removeExactDuplicates(replaced);
        const staged = await api.getStaged(pl.file);
        await api.stagePlaylist(
          pl.file,
          staged?.name ?? null,
          staged?.description ?? null,
          deduped
        );
        // This staged behind the open editor's back — sync the in-memory draft, or a
        // later Save would clobber the normalization with the stale track list.
        if (pl.file === selected) draftApi.adoptStaged(deduped);
        changed++;
      }
      // `changed` can be 0 if the scan behind the panel has gone stale — say so rather than
      // reporting a normalization "across 0 playlists" that didn't happen.
      setStatus(
        changed === 0
          ? {
              kind: "err",
              msg: `Nothing to normalize for "${group.title}" — the scan is out of date, it has been refreshed.`,
            }
          : {
              kind: "ok",
              msg: `Normalized "${group.title}" across ${changed} playlist${
                changed === 1 ? "" : "s"
              } (staged — open each to review and push)`,
            }
      );
      void openDoctor(); // rescan with the fixes applied
      void loadList();
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  /**
   * Append another playlist's songs to the open one, skipping the ones already here.
   *
   * Reads the source's *effective* tracks — its staged edits if it has any, else the Spotify
   * mirror — so merging in a playlist you were midway through editing takes the version you
   * last saw rather than the one Spotify still has. The source itself is untouched: this is
   * a copy in, not a move, so an unwanted playlist can be archived afterwards or kept.
   */
  async function mergePlaylist(source: LocalPlaylist) {
    if (!draft || merging) return;
    setMerging(true);
    try {
      const [pf, staged] = await Promise.all([
        api.readPlaylist(source.file),
        api.getStaged(source.file),
      ]);
      const { tracks, added, skipped } = appendMissing(draft.tracks, staged?.tracks ?? pf.tracks);
      if (added.length === 0) {
        setStatus({
          kind: "ok",
          msg: `Nothing to merge — every song in "${source.name}" is already here`,
        });
      } else {
        edit(tracks);
        loadFeatures(added);
        setStatus({
          kind: "ok",
          msg: `Added ${added.length} song${added.length === 1 ? "" : "s"} from "${
            source.name
          }"${skipped > 0 ? `, skipped ${skipped} already here` : ""} — review the changes and push when you're happy with it`,
        });
      }
      setMergeOpen(false);
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setMerging(false);
    }
  }

  /**
   * Remove songs from every playlist they appear in — what the stale view was for, and where
   * it used to stop: it found your dead tracks and then asked you to open each playlist and
   * do it yourself.
   *
   * Stages each affected playlist rather than writing to Spotify, so a removal across a dozen
   * playlists is still a dozen reviewable diffs. Same path as the cross-playlist duplicate
   * fix, including syncing the open editor's draft — staging behind its back would let a later
   * Save clobber the pruning with a stale track list.
   *
   * Archived playlists aren't in the scan, so they aren't touched.
   */
  /**
   * Put back the staged state captured before a cross-playlist write.
   *
   * The editor's Undo button can't reach these: the prune staged playlists that aren't open,
   * so taking it back means restoring each of them on disk. A playlist that had no staged
   * edit before gets none again rather than an empty one, which is the difference between
   * "unmodified" and "modified to match the mirror" in the sidebar.
   *
   * The open playlist is reloaded rather than patched in memory, because it may have gone
   * from staged to unstaged or the other way, and re-reading from disk is the one thing that
   * is right either way.
   */
  async function restoreStaged(before: StagedBefore[]) {
    const live = liveRef.current;
    const wasStale = live.overlayKind === "stale";
    try {
      for (const { file, staged } of before) {
        if (staged) {
          await api.stagePlaylist(file, staged.name, staged.description, staged.tracks);
        } else {
          await api.clearStaged(file);
        }
      }
      const open = live.draftApi.selected;
      if (open && before.some((b) => b.file === open)) {
        // Closes whichever panel was over the editor, and stages any edits made since the
        // message appeared before re-reading — which is why this goes through the live ref.
        await live.draftApi.openPlaylist(open);
      }
      if (wasStale) await live.openStale(); // put the panel back, rescanned
      const n = before.length;
      // Set last: openPlaylist clears the status line on its way through.
      setStatus({
        kind: "ok",
        msg: `Put ${n} playlist${n === 1 ? "" : "s"} back the way they were`,
      });
      void loadList();
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  async function pruneEverywhere(trackIds: string[]) {
    const scanned = overlay?.kind === "stale" ? overlay.data : null;
    if (!scanned || trackIds.length === 0) return;
    const ids = new Set(trackIds.map(bareId));
    const affected = scanned.filter((pl) => pl.tracks.some((t) => ids.has(bareId(t.id))));
    const songs = `${trackIds.length} song${trackIds.length === 1 ? "" : "s"}`;

    // Zero affected playlists means the scan behind the panel has gone stale — say so rather
    // than reporting a removal "across 0 playlists" that didn't happen.
    if (affected.length === 0) {
      setStatus({
        kind: "err",
        msg: "Nothing to remove — the scan is out of date, it has been refreshed.",
      });
      void openStale();
      return;
    }

    const lists = `${affected.length} playlist${affected.length === 1 ? "" : "s"}`;
    const ok = await confirmDialog(
      `Remove ${songs} from ${lists}? The removals are staged, so you can review each playlist's changes before anything reaches Spotify.`,
      "Remove"
    );
    if (!ok) return;

    try {
      // What each playlist's staging looked like first, so the whole prune can be put back.
      // Captured as it goes rather than up front: a failure part-way through then leaves an
      // undo covering exactly the playlists that were actually changed.
      const before: StagedBefore[] = [];
      for (const pl of affected) {
        const kept = removeTracksByIds(pl.tracks, ids);
        const staged = await api.getStaged(pl.file);
        before.push({ file: pl.file, staged });
        await api.stagePlaylist(
          pl.file,
          staged?.name ?? null,
          staged?.description ?? null,
          kept
        );
        if (pl.file === selected) draftApi.adoptStaged(kept);
      }
      setStatus({
        kind: "ok",
        msg: `Removed ${songs} from ${lists} (staged — open each to review and push)`,
        undo: () => restoreStaged(before),
      });
      void openStale(); // rescan so the pruned songs are gone from the list
      void loadList();
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  // Copy a track (dragged from the open editor) into another playlist's staged edits.
  // The target isn't open in the editor, so we read its effective tracks (staged ?? canonical),
  // append, and re-stage — no Spotify call, no change to the open playlist.
  async function copyTrackToPlaylist(track: TrackEntry, target: LocalPlaylist) {
    if (target.file === selected) return; // dropping back on the open playlist: no-op
    try {
      const pf = await api.readPlaylist(target.file);
      const staged = await api.getStaged(target.file);
      const current = staged?.tracks ?? pf.tracks;
      if (current.some((t) => bareId(t.id) === bareId(track.id))) {
        setStatus({ kind: "ok", msg: `"${track.title}" is already in "${target.name}"` });
        return;
      }
      const next = [...current, { ...track, added_at: null, added_by: null }];
      // Preserve any staged title/description override on the target (don't clobber it).
      await api.stagePlaylist(
        target.file,
        staged?.name ?? null,
        staged?.description ?? null,
        next
      );
      setStatus({
        kind: "ok",
        msg: `Added "${track.title}" to "${target.name}" (staged — push to apply on Spotify)`,
      });
      void loadList(); // refresh the modified dot
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  function onDrop(to: number) {
    const from = dragIndex.current;
    dragIndex.current = null;
    setOverIndex(null);
    if (!draft || from === null || from === to) return;
    edit(move(draft.tracks, from, to));
  }

  // Debounced cross-playlist local search (sidebar "Songs" mode).
  useEffect(() => {
    if (mode !== "songs" || filter.trim() === "") {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const h = await api.searchLocalTracks(filter);
        if (!cancelled) setHits(h);
      } catch (e) {
        if (!cancelled) setStatus({ kind: "err", msg: String(e) });
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [filter, mode]);

  // After opening a playlist from a song search, center that track and flash it.
  useEffect(() => {
    if (!draft || !focusTrack) return;
    const el = tracksRef.current?.querySelector(
      `[data-tid="${CSS.escape(focusTrack)}"]`
    ) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setFlashId(focusTrack);
      window.setTimeout(() => setFlashId(null), 1600);
    }
    setFocusTrack(null);
  }, [draft, focusTrack]);

  const filtered = useMemo(
    () => playlists.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase())),
    [playlists, filter]
  );

  // Inline diff of the draft against the Spotify mirror — drives the "Show changes" review.
  const diff = useMemo(
    () => diffTracks(baseline, draft?.tracks ?? []),
    [baseline, draft]
  );
  const inDiff = showDiff && diff.changed;

  // Live cleanup issues for the open playlist (recomputed as you edit the draft).

  // Display order for the editable track list. Each entry keeps its real draft index `i`
  // (used for editing and shown as the official "#"), so a sort is purely a view until
  // `applySortOrder` writes it back.
  const orderedTracks = useMemo(
    () => sortTracks(draft?.tracks ?? [], sortKey, sortDir, featureOf),
    [draft, sortKey, sortDir, featureMap]
  );

  // A feature sort is only as good as the numbers it has, and they arrive a playlist at a
  // time: applying one mid-fetch would bake in an order where everything still pending sat
  // at the bottom together. Title and duration come from the playlist file, so they're
  // always ready.
  const sortIsFeature = sortKey !== "index" && sortKey !== "title" && sortKey !== "duration";
  const canApplySort = sortKey !== "index" && !(sortIsFeature && metricsLoading);

  /**
   * Make the sorted view the playlist's real order. It lands as an ordinary draft edit, so
   * it shows up in the diff and reaches Spotify only on push — and dropping back to the
   * official order afterwards means what's on screen is what was just written, rather than a
   * sorted view of an already-sorted list.
   */
  function applySortOrder() {
    if (!draft || !canApplySort) return;
    const was = sortKey;
    edit(orderedTracks.map(({ t }) => t));
    toggleSort("index");
    setStatus({
      kind: "ok",
      msg: `Reordered by ${was} — review the changes and push when you're happy with it`,
    });
  }

  // Whether the header checkbox reads as ticked: every row on screen is selected. Computed
  // from the displayed rows rather than the draft so it still means something while sorted.
  const allShownSelected =
    orderedTracks.length > 0 && orderedTracks.every(({ i }) => selection.has(i));

  function toggleSort(key: SortKey) {
    // The anchor is a screen position, and re-sorting puts a different row there.
    setSelectAnchor(null);
    if (key === "index") {
      setSortKey("index");
      setSortDir("asc");
    } else if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  // The currently loaded track, matched by bare song id so the highlight follows the
  // song across playlists (not the playlist context it was started from). Spotify may
  // relink a track to a market-specific equivalent at playback time while the playlist
  // file stores the original uri — match against both so relinked songs still highlight.
  const playingId = player?.playing ? bareId(player.playing.uri) : null;
  const playingLinkedId = player?.playing?.linkedFromUri
    ? bareId(player.playing.linkedFromUri)
    : null;
  const isPlayingTrack = (id: string): boolean => {
    if (playingId == null) return false;
    const b = bareId(id);
    return b === playingId || b === playingLinkedId;
  };
  const playingActive = player?.playing != null && !player.playing.paused;

  // What the add box needs to know about the playing song. Derived here rather than in the
  // adder because it leans on `isPlayingTrack` above: a track Spotify relinked still counts
  // as present, so the button can't offer to add a song already sitting in the list. A local
  // file is excluded — it has no catalog entry to read, and a push couldn't accept one.
  const playingAddable =
    player?.playing && !isLocalTrack(player.playing.uri) ? player.playing : null;
  const playingIsHere =
    playingAddable != null && (draft?.tracks ?? []).some((t) => isPlayingTrack(t.id));

  // The playlist context playback was started from — marks that playlist in the sidebar.
  const playingContext = player?.playing?.contextUri ?? null;

  // Every playlist the playing song appears in (by file) — gives those sidebar rows a
  // subtle "also here" mark. Refreshed once per track change; the backend walk is cheap
  // (playlist parsing is mtime-cached).
  const [playingIn, setPlayingIn] = useState<Set<string>>(new Set());
  const playingUri = player?.playing?.uri ?? null;
  const playingLinkedUri = player?.playing?.linkedFromUri ?? null;
  useEffect(() => {
    if (!playingUri) {
      setPlayingIn(new Set());
      return;
    }
    let cancelled = false;
    const ids = playingLinkedUri ? [playingUri, playingLinkedUri] : [playingUri];
    api
      .trackPlaylists(ids)
      .then((files) => {
        if (!cancelled) setPlayingIn(new Set(files));
      })
      .catch(() => {}); // background lookup — a miss just means no marks
    return () => {
      cancelled = true;
    };
  }, [playingUri, playingLinkedUri]);
  // Only the write operations (Save/Push) should disable the action buttons. Disabling them
  // during the now-instant "open"/"load" reads just makes the buttons flash dim on a switch.
  const busyWriting = busy === "save" || busy === "push";

  function isModified(p: LocalPlaylist): boolean {
    return p.modified || (selected === p.file && (dirty || staged));
  }

  const plItem = (p: LocalPlaylist) => {
    const isDropTarget = dropTarget === p.file && selected !== p.file;
    const isPlayingHere =
      p.spotify_id !== "" && playingContext === `spotify:playlist:${p.spotify_id}`;
    // Subtle note mark on the other playlists containing the playing song (the context
    // playlist already gets the equalizer, so no second mark there).
    const alsoHasPlaying = !isPlayingHere && playingIn.has(p.file);
    return (
      <button
        key={p.file}
        className={`pl-item ${selected === p.file ? "active" : ""} ${
          isDropTarget ? "drop-target" : ""
        }`}
        onClick={() => openPlaylist(p.file)}
        onDragOver={(e) => {
          // Only react to a track being dragged in (not playlist-internal reorder).
          if (!e.dataTransfer.types.includes(TRACK_MIME) || p.file === selected) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (dropTarget !== p.file) setDropTarget(p.file);
        }}
        onDragLeave={() => setDropTarget((cur) => (cur === p.file ? null : cur))}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes(TRACK_MIME)) return;
          e.preventDefault();
          setDropTarget(null);
          const raw = e.dataTransfer.getData(TRACK_MIME);
          if (!raw) return;
          try {
            void copyTrackToPlaylist(JSON.parse(raw) as TrackEntry, p);
          } catch {
            /* malformed payload — ignore */
          }
        }}
      >
        <span className="pl-name">
          {p.pinned && (
            <svg
              className="pin-ico"
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="currentColor"
            >
              <title>Pinned</title>
              <path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z" />
            </svg>
          )}
          {p.spotify_id === "" && (
            <span className="local-badge" title="Not on Spotify yet — push to create it">
              new
            </span>
          )}
          {isModified(p) && <span className="mini-dot" title="Has unpushed edits" />}
          {p.name}
        </span>
        {isPlayingHere && (
          <span
            className={`eq pl-eq ${playingActive ? "live" : ""}`}
            title="Currently playing from this playlist"
            aria-label="Currently playing from this playlist"
          >
            <i />
            <i />
            <i />
          </span>
        )}
        {alsoHasPlaying && (
          <span
            className="pl-also"
            title={`"${player?.playing?.trackName ?? "The playing song"}" is also in this playlist`}
            aria-label="The playing song is also in this playlist"
          >
            ♪
          </span>
        )}
        <span className="pl-count">{p.track_count}</span>
      </button>
    );
  };

  const current = playlists.find((p) => p.file === selected);
  const currentArchived = current?.archived ?? false;
  const currentPinned = current?.pinned ?? false;

  // A track Setlist can actually start playback on: not a Spotify-desktop-only local file and
  // not greyed out (unavailable) for this user.
  const playable = (t: TrackEntry) => !isLocalTrack(t.id) && t.is_playable !== false;

  // Play the open playlist starting at `t`. If `t` is unavailable (greyed out), auto-skip to
  // the next playable track so playback still begins — matching how Spotify glides past greyed
  // tracks within a context.
  function playFrom(t: TrackEntry) {
    if (!draft) return;
    const ctx = `spotify:playlist:${draft.spotify_id}`;
    if (playable(t)) {
      void player?.play(ctx, t.id);
      return;
    }
    const from = draft.tracks.findIndex((x) => x.id === t.id);
    const next = draft.tracks.slice(from + 1).find(playable);
    if (!next) {
      setStatus({ kind: "err", msg: "No playable track from here — the rest are unavailable on Spotify." });
      return;
    }
    void player?.play(ctx, next.id);
  }

  // Wire one track into a row. The derivations stay here because they read this component's
  // metrics, playback and drag state; `TrackRow` is handed plain values and holds none of it.
  function renderRow(
    t: TrackEntry,
    opts: {
      key: string;
      status: RowStatus;
      position: number | null;
      draftIndex?: number;
      /** Where the row sits on screen, which is what a shift-click range follows. */
      row?: number;
    }
  ) {
    const i = opts.draftIndex ?? -1;
    return (
      <TrackRow
        key={opts.key}
        track={t}
        status={opts.status}
        position={opts.position}
        index={i}
        canReorder={opts.status === "normal" && sortKey === "index"}
        isDropTarget={overIndex === i}
        isPlaying={isPlayingTrack(t.id)}
        playingActive={playingActive}
        isFlashing={flashId === t.id}
        feature={featureOf(t)}
        // A goal replaces the average-based outlier flag: when set, show off-goal dimensions.
        outlier={metricsOpen && !goal ? outliers.get(t.id) : undefined}
        // Goal flags show whenever a goal is set (not just when the metrics panel is open) —
        // the whole point is to surface tracks that miss the target.
        goalOff={goal ? goalDeviations.get(t.id) : undefined}
        stillAnalyzing={analyzing.has(t.id)}
        metricsOpen={metricsOpen}
        cols={cols}
        onDragStart={(idx) => {
          dragIndex.current = idx;
        }}
        onDragEnter={(idx) => {
          if (overIndex !== idx) setOverIndex(idx);
        }}
        onDragLeave={(idx) => {
          if (overIndex === idx) setOverIndex(null);
        }}
        onDropAt={onDrop}
        onDragEnd={() => {
          dragIndex.current = null;
          setOverIndex(null);
        }}
        onPlay={playFrom}
        onRemove={removeAt}
        isSelected={selection.has(i)}
        onToggleSelect={(shift) => pickTrack(opts.row ?? 0, shift)}
      />
    );
  }

  return (
    <div className="library">
      <aside className="sidebar">
        <div className="mode-toggle">
          <button
            className={`seg ${mode === "playlists" ? "active" : ""}`}
            onClick={() => setMode("playlists")}
          >
            Playlists
          </button>
          <button
            className={`seg ${mode === "songs" ? "active" : ""}`}
            onClick={() => setMode("songs")}
          >
            Find a song
          </button>
        </div>
        <input
          className="filter"
          name="sidebar-filter"
          aria-label={mode === "playlists" ? "Filter playlists" : "Search songs across playlists"}
          placeholder={mode === "playlists" ? "Filter playlists…" : "Search songs across playlists…"}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        {mode === "playlists" && (
          <button
            className="btn ghost small new-pl-btn"
            onClick={() => setCreateOpen(true)}
            title="Create a new playlist (local until you push it to Spotify)"
          >
            + New playlist
          </button>
        )}

        <div className="pl-list">
          {mode === "playlists" ? (
            <>
              {filtered.filter((p) => !p.archived).map(plItem)}
              {filtered.some((p) => p.archived) && (
                <>
                  <div className="pl-section">Archived</div>
                  {filtered.filter((p) => p.archived).map(plItem)}
                  <button
                    className="btn ghost small unfollow-btn"
                    onClick={unfollowArchivedAll}
                    disabled={blocked}
                  >
                    Unfollow archived from Spotify
                  </button>
                </>
              )}
              {filtered.length === 0 && (
                <p className="hint pad">
                  {listBusy ? "Loading…" : "No playlists. Pull them in Setup first."}
                </p>
              )}
            </>
          ) : (
            <>
              {hits.map((h, i) => (
                <button
                  key={`${h.file}-${h.id}-${i}`}
                  className="hit-item"
                  onClick={() => {
                    setMode("playlists");
                    void openPlaylist(h.file, h.id);
                  }}
                >
                  <span className="hit-title">{h.title}</span>
                  <span className="hit-meta">
                    {h.artists.join(", ")} · in <b>{h.playlist}</b>
                  </span>
                </button>
              ))}
              {filter.trim() !== "" && hits.length === 0 && (
                <p className="hint pad">No matches in your playlists.</p>
              )}
            </>
          )}
        </div>

        <div className="sidebar-tools" role="group" aria-label="Library tools">
          <button
            className={`tool-btn ${overlay?.kind === "songs" ? "active" : ""}`}
            onClick={() => void openSongs()}
            title="All songs — browse every song across all your playlists"
            aria-label="All songs"
          >
            <IcoSongs />
          </button>
          <button
            className={`tool-btn ${overlay?.kind === "doctor" ? "active" : ""}`}
            onClick={() => void openDoctor()}
            title="Cleanup — scan your whole library for duplicate and unavailable tracks"
            aria-label="Cleanup"
          >
            <IcoClean />
          </button>
          <button
            className={`tool-btn ${overlay?.kind === "stale" ? "active" : ""}`}
            onClick={() => void openStale()}
            title="Stale tracks — find tracks you rarely or never play"
            aria-label="Stale tracks"
          >
            <IcoClock />
          </button>
          <button
            className={`tool-btn ${overlay?.kind === "status" ? "active" : ""}`}
            onClick={() => void openStatus()}
            title="Status — unpushed edits, drift from Spotify, and lint issues"
            aria-label="Status"
          >
            <IcoStatus />
          </button>
          <button
            className={`tool-btn ${overlay?.kind === "similarity" ? "active" : ""}`}
            onClick={() => void openSimilarity()}
            title="Similarity map — see which playlists have similar audio profiles"
            aria-label="Similarity map"
          >
            <IcoMap />
          </button>
        </div>
      </aside>

      <section className="editor">
        {overlay ? (
          // Keyed on the panel so switching between them remounts: each panel's own scratch
          // state (the status panel's drift results) belongs to that visit, not the next one.
          <LibraryOverlay
            key={overlay.kind}
            overlay={overlay}
            busy={overlayBusy}
            archived={archivedFiles}
            onClose={() => setOverlay(null)}
            onOpenPlaylist={(file) => void openPlaylist(file)}
            onOpenTrack={(file, trackId) => void openPlaylist(file, trackId)}
            onNormalize={(group, keepId) => void normalizeCrossDup(group, keepId)}
            onPrune={pruneEverywhere}
            onError={(msg) => setStatus({ kind: "err", msg })}
          />
        ) : !draft ? (
          <div className="empty">Select a playlist to edit.</div>
        ) : (
          <>
            <header className="editor-head">
              <div className="eh-info">
                {draft.cover_url && (
                  <img src={draft.cover_url} className="eh-cover" alt="" />
                )}
                <div className="eh-text">
                  {editMeta ? (
                    <div className="eh-edit">
                      <input
                        className="eh-name-input"
                        name="playlist-name"
                        aria-label="Playlist name"
                        value={draft.name}
                        onChange={(e) => setMeta({ name: e.target.value })}
                        placeholder="Playlist name"
                        autoFocus
                      />
                      <textarea
                        className="eh-desc-input"
                        value={draft.description}
                        onChange={(e) => setMeta({ description: e.target.value })}
                        placeholder="Add a description…"
                        rows={2}
                      />
                      <button
                        className="btn ghost small"
                        onClick={() => setEditMeta(false)}
                      >
                        Done
                      </button>
                    </div>
                  ) : (
                    <>
                      <h2>
                        {draft.name}
                        {(dirty || staged) && (
                          <span
                            className="dot"
                            title={dirty ? "Unsaved changes" : "Saved, not pushed"}
                          />
                        )}
                        <button
                          className="eh-edit-btn"
                          onClick={() => setEditMeta(true)}
                          title="Edit name & description"
                          aria-label="Edit name & description"
                        >
                          ✎
                        </button>
                      </h2>
                      {draft.description && <p className="eh-desc">{draft.description}</p>}
                    </>
                  )}
                  <p className="hint">
                    {draft.tracks.length} tracks ·{" "}
                    {fmtTotal(draft.tracks.reduce((a, t) => a + (t.duration_ms ?? 0), 0))}
                    {dirty ? " · unsaved" : staged ? " · staged (not pushed)" : ""}
                    {!draft.spotify_id && " · not on Spotify yet — push to create it"}
                  </p>
                </div>
              </div>
              <div className="actions">
                <button
                  className="btn ghost"
                  onClick={undo}
                  disabled={busyWriting || !canUndo}
                  title="Undo the last edit (Ctrl+Z). Steps back one change at a time, unlike Revert."
                >
                  Undo
                </button>
                <button
                  className="btn ghost"
                  onClick={revert}
                  disabled={busyWriting || (!dirty && !staged)}
                >
                  Revert
                </button>
                <button className="btn ghost" onClick={save} disabled={busyWriting || !dirty}>
                  {busy === "save" ? "Saving…" : "Save"}
                </button>
                <button className="btn" onClick={push} disabled={busyWriting || blocked}>
                  {busy === "push" ? "Pushing…" : "Push to Spotify"}
                </button>
                <div className="kebab">
                  <button
                    className="btn ghost icon-btn"
                    onClick={() => setMenuOpen((v) => !v)}
                    disabled={busyWriting}
                    title="More playlist actions"
                    aria-label="More playlist actions"
                  >
                    ⋮
                  </button>
                  {menuOpen && (
                    <>
                      <div className="cols-backdrop" onClick={() => setMenuOpen(false)} />
                      <div className="kebab-menu">
                        <button
                          className="kebab-item"
                          onClick={() => {
                            setMenuOpen(false);
                            if (current) void togglePin(current);
                          }}
                        >
                          {currentPinned ? "Unpin" : "Pin"}
                        </button>
                        <button
                          className="kebab-item"
                          onClick={() => {
                            setMenuOpen(false);
                            setMergeOpen(true);
                          }}
                        >
                          Merge a playlist in…
                        </button>
                        <button
                          className="kebab-item"
                          onClick={() => {
                            setMenuOpen(false);
                            void toggleArchive(selected!, currentArchived);
                          }}
                        >
                          {currentArchived ? "Unarchive" : "Archive"}
                        </button>
                        {currentArchived && (
                          <button
                            className="kebab-item"
                            disabled={blocked}
                            onClick={() => {
                              setMenuOpen(false);
                              void refollow(selected!);
                            }}
                          >
                            Re-add to Spotify
                          </button>
                        )}
                        <button
                          className="kebab-item danger"
                          disabled={blocked}
                          onClick={() => {
                            setMenuOpen(false);
                            if (current) setDeleteTarget(current);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </header>

            {sync?.remote_changed && (
              <div className="sync-banner">
                <span>
                  ⟳ Spotify changed since your last sync:
                  {sync.remote_added.length > 0 && ` +${sync.remote_added.length} added`}
                  {sync.remote_added.length > 0 && sync.remote_removed.length > 0 && ","}
                  {sync.remote_removed.length > 0 && ` −${sync.remote_removed.length} removed`}.
                </span>
                <span className="sb-actions">
                  <button className="btn ghost small" onClick={pullRemote} disabled={blocked}>
                    Pull Spotify's version
                  </button>
                  <button className="link" onClick={draftApi.dismissSync}>
                    Dismiss
                  </button>
                </span>
              </div>
            )}

            <AddBox
              adder={adder}
              blocked={blocked}
              playing={playingAddable}
              playingIsHere={playingIsHere}
            />

            {draft.tracks.length > 0 && (
              <div className="metrics-strip">
                <div className="metrics-strip-head">
                  <button
                    className="metrics-toggle"
                    onClick={() => setMetricsOpen((o) => !o)}
                    title="Mood fingerprint and per-track audio features"
                  >
                    <span className="caret">{metricsOpen ? "▾" : "▸"}</span>
                    <span>Metrics</span>
                    {aggregates && (
                      <span className="hint">
                        {aggregates.analyzed}/{aggregates.total} analyzed
                        {metricsOpen && outliers.size > 0
                          ? ` · ${outliers.size} outlier${outliers.size > 1 ? "s" : ""}`
                          : ""}
                        {showAnalyzing ? " · analyzing…" : ""}
                      </span>
                    )}
                  </button>
                </div>
                {metricsOpen && (
                  <div className="metrics-body">
                    {aggregates && (
                      <MetricsPanel
                        agg={aggregates}
                        loading={metricsLoading}
                        slowLoad={showAnalyzing}
                        goal={goalControl}
                        outlierCtl={{
                          mode: outlierMode,
                          effective: metrics.outlierEffective,
                          setMode: setOutlierMode,
                        }}
                      />
                    )}
                    <div className="metrics-tools">
                      <div className="cols-picker">
                        <button
                          className="btn ghost small"
                          onClick={() => setColPicker((v) => !v)}
                          title="Choose which feature columns to show"
                        >
                          Columns ▾
                        </button>
                        {colPicker && (
                          <>
                            <div className="cols-backdrop" onClick={() => setColPicker(false)} />
                            <div className="cols-menu">
                              <div className="cols-menu-title">Show columns</div>
                              {FEATURE_META.map((m) => (
                                <label key={m.key} className="cols-opt">
                                  <input
                                    type="checkbox"
                                    name={`col-${m.key}`}
                                    checked={cols.includes(m.key)}
                                    onChange={() => toggleCol(m.key)}
                                  />
                                  <span>{m.label}</span>
                                </label>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {!inDiff && doctor.count > 0 && <IssuesStrip doctor={doctor} blocked={blocked} />}

            {diff.changed && (
              <div className="changes-bar">
                <span className="changes-summary">
                  {diff.added > 0 && <span className="cs-add">+{diff.added}</span>}
                  {diff.removed > 0 && <span className="cs-rem">−{diff.removed}</span>}
                  {diff.moved > 0 && <span className="cs-move">~{diff.moved}</span>}
                  <span className="hint">
                    pending change{diff.added + diff.removed + diff.moved > 1 ? "s" : ""} vs Spotify
                  </span>
                </span>
                <button
                  className={`diff-toggle ${showDiff ? "active" : ""}`}
                  onClick={() => setShowDiff((v) => !v)}
                  title="Show planned changes inline before pushing"
                >
                  {showDiff ? "Showing changes" : "Show changes"}
                </button>
              </div>
            )}

            <div className={`tracks-header ${metricsOpen ? "with-feats" : ""}`}>
              {inDiff ? (
                <span />
              ) : (
                <input
                  type="checkbox"
                  className="t-pick"
                  checked={allShownSelected}
                  aria-label={allShownSelected ? "Clear selection" : "Select every song shown"}
                  title={allShownSelected ? "Clear selection" : "Select every song shown"}
                  onChange={toggleSelectAll}
                />
              )}
              <span />
              <button
                className={`th-sort ${sortKey === "index" ? "active" : ""}`}
                onClick={() => toggleSort("index")}
                disabled={inDiff}
                title="Official playlist order"
              >
                #{sortKey === "index" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
              </button>
              <button
                className={`th-sort ${sortKey === "title" ? "active" : ""}`}
                onClick={() => toggleSort("title")}
                disabled={inDiff}
                title="Sort by title (view only)"
              >
                Title{sortKey === "title" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
              </button>
              <span>Artist</span>
              {metricsOpen && (
                <span className="t-feats">
                  {cols.map((k) => {
                    const m = FEATURE_META.find((x) => x.key === k)!;
                    const active = sortKey === k;
                    return (
                      <button
                        key={k}
                        className={`t-feat th-sort th-right ${active ? "active" : ""}`}
                        onClick={() => toggleSort(k)}
                        disabled={inDiff}
                        title={`Sort by ${m.label} (view only)`}
                      >
                        {m.short}
                        {active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                      </button>
                    );
                  })}
                </span>
              )}
              <button
                className={`th-sort th-right ${sortKey === "duration" ? "active" : ""}`}
                onClick={() => toggleSort("duration")}
                disabled={inDiff}
                title="Sort by duration (view only)"
              >
                Time{sortKey === "duration" ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
              </button>
              <span />
              <span />
            </div>

            {selection.size > 0 && !inDiff && (
              <p className="sel-bar">
                <span>
                  <strong>{selection.size}</strong> selected
                </span>
                <button className="btn ghost small danger" onClick={removeSelected}>
                  Remove {selection.size === 1 ? "it" : "them"}
                </button>
                <button className="link" onClick={() => setSelection(new Set())}>
                  Clear
                </button>
              </p>
            )}

            {sortKey !== "index" && !inDiff && (
              <p className="sort-note hint">
                Sorted by {sortKey} — display only; the playlist's saved order is unchanged.
                <button
                  className="link"
                  onClick={applySortOrder}
                  disabled={!canApplySort}
                  title={
                    canApplySort
                      ? "Reorder the playlist to match this view (staged — review and push)"
                      : "Waiting for the remaining audio features"
                  }
                >
                  Apply this order
                </button>
                <button className="link" onClick={() => toggleSort("index")}>
                  Restore official order
                </button>
              </p>
            )}

            <ol className="tracks" ref={tracksRef}>
              {inDiff
                ? diff.rows.map((r) =>
                    renderRow(r.track, { key: r.key, status: r.status, position: r.position })
                  )
                : orderedTracks.map(({ t, i }, row) =>
                    renderRow(t, {
                      key: `${t.id}-${i}`,
                      status: "normal",
                      position: i + 1,
                      draftIndex: i,
                      row,
                    })
                  )}
            </ol>
          </>
        )}
      </section>

      {status && (
        <p className={`status ${status.kind} lib-status`}>
          <span>{status.msg}</span>
          {status.undo && (
            <button className="link" onClick={() => void status.undo?.()}>
              Undo
            </button>
          )}
          <button
            className="msg-close"
            onClick={() => setStatus(null)}
            title="Dismiss"
            aria-label="Dismiss"
          >
            ×
          </button>
        </p>
      )}

      {createOpen && (
        <CreatePlaylistModal
          creating={creating}
          onCreate={(name, description) => void doCreate(name, description)}
          onClose={() => setCreateOpen(false)}
        />
      )}

      {mergeOpen && draft && (
        <MergePlaylistModal
          playlists={playlists.filter((p) => p.file !== selected)}
          busy={merging}
          onMerge={(source) => void mergePlaylist(source)}
          onClose={() => setMergeOpen(false)}
        />
      )}

      {deleteTarget && (
        <DeletePlaylistModal
          target={deleteTarget}
          deleting={deleting}
          onDelete={() => void doDelete()}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {confirmState && (
        <ConfirmModal
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          onResolve={resolveConfirm}
        />
      )}

      {conflict && (
        <ConflictModal
          conflict={conflict}
          onMerge={() => void draftApi.resolveConflict("merge")}
          onOverwrite={() => void draftApi.resolveConflict("overwrite")}
          onClose={draftApi.dismissConflict}
        />
      )}
    </div>
  );
}
