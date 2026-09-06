import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type Aggregates,
  type Features,
  type HistoryReport,
  type LocalPlaylist,
  type LocalTrackHit,
  type NamedPlaylist,
  type PlaylistFile,
  type PushStrategy,
  type ReplacementSuggestion,
  type SearchResult,
  type SyncStatus,
  type TrackEntry,
} from "./api";
import MetricsPanel, { type GoalControl } from "./MetricsPanel";
import {
  bareId,
  computeAggregates,
  computeGoalDeviations,
  computeOutliersByMode,
  FEATURE_LABEL,
  FEATURE_META,
  fmtFeature,
  GOAL_DIMS,
  isLocalTrack,
  type FeatureKey,
  type Goal,
  type GoalDeviation,
  type Outlier,
  type OutlierMode,
} from "./metricsCalc";
import {
  issueCount,
  lintPlaylist,
  removeExactDuplicates,
  removeTracksByIds,
  type CrossDupGroup,
  type DupGroup,
} from "./lint";
import AllSongsView from "./AllSongsView";
import DoctorView from "./DoctorView";
import StaleView from "./StaleView";
import StatusView, { type DriftState } from "./StatusView";
import SimilarityView from "./SimilarityView";
import { fmtDuration, fmtTotal } from "./format";
import {
  ConfirmModal,
  ConflictModal,
  CreatePlaylistModal,
  DeletePlaylistModal,
} from "./modals";
import { useNowPlaying } from "./player";
import { useGit } from "./git";
import { diffTracks, type DiffStatus } from "./playlistDiff";
import { useRateLimit } from "./rateLimit";
import * as prefs from "./prefs";

type Status = { kind: "ok" | "warn" | "err"; msg: string } | null;
type SidebarMode = "playlists" | "songs";
// View-only sort: the official order ("index"), title/duration, or any audio-feature column.
type SortKey = "index" | "title" | "duration" | FeatureKey;

// Column choices, mood goals and the outlier method all live in the data folder now — see
// prefs.ts for why. These stay synchronous because they run during render; prefs holds both
// stores in memory after a single load at startup.
const loadCols = (file: string): FeatureKey[] => prefs.getCols(file);
const loadGoal = (file: string): Goal | null => prefs.getGoal(file);
const saveGoal = (file: string, goal: Goal | null) => prefs.setGoal(file, goal);
const loadOutlierMode = (): OutlierMode => prefs.getOutlierMode() as OutlierMode;
const saveOutlierMode = (mode: OutlierMode) => prefs.setOutlierMode(mode);

function move<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
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
  const [playlists, setPlaylists] = useState<LocalPlaylist[]>([]);
  const [mode, setMode] = useState<SidebarMode>("playlists");
  const [filter, setFilter] = useState("");
  const [hits, setHits] = useState<LocalTrackHit[]>([]);

  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlaylistFile | null>(null);
  const [baseline, setBaseline] = useState<TrackEntry[]>([]); // canonical Spotify-mirror order
  const [showDiff, setShowDiff] = useState(false); // inline "Show changes" review mode
  // View-only sort of the track list. "index" is the official playlist order (the real
  // order; only this mode is reorderable). Title/duration just change how rows are displayed.
  const [sortKey, setSortKey] = useState<SortKey>("index");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [dirty, setDirty] = useState(false); // in-memory edits not yet staged
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
  const [staged, setStaged] = useState(false); // saved (cached) but not pushed
  const [busy, setBusy] = useState<null | "load" | "open" | "save" | "push">(null);
  const [status, setStatus] = useState<Status>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null); // remote-change banner
  const [conflict, setConflict] = useState<SyncStatus | null>(null); // push conflict modal

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const dragIndex = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // sidebar playlist being dragged onto
  // In-app replacement for window.confirm(): a styled modal that resolves a promise.
  const [confirmState, setConfirmState] = useState<{
    message: string;
    confirmLabel: string;
    resolve: (ok: boolean) => void;
  } | null>(null);

  // Create / delete playlist modals (the modals own their inputs).
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LocalPlaylist | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false); // editor header ⋮ menu
  const [editMeta, setEditMeta] = useState(false); // editing title/description inline

  // Cleanup "doctor": per-playlist issues panel + library-wide scan.
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [doctorData, setDoctorData] = useState<NamedPlaylist[] | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);
  // Replacement search for unavailable tracks, keyed by full track id: "loading", a found
  // suggestion, or null (searched, nothing close). Absent = not searched yet.
  const [replaceState, setReplaceState] = useState<
    Record<string, ReplacementSuggestion | "loading" | null>
  >({});

  // Global library view: every song across all playlists.
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryData, setLibraryData] = useState<NamedPlaylist[] | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);

  // Stale-track view: every song joined with how recently it was played.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyData, setHistoryData] = useState<NamedPlaylist[] | null>(null);
  const [historyReport, setHistoryReport] = useState<HistoryReport | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  // Status dashboard: a git-status-style overview across all playlists. Local signals
  // (unpushed edits, lint counts) render immediately; drift is checked on demand.
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusLocal, setStatusLocal] = useState<LocalPlaylist[] | null>(null);
  const [statusData, setStatusData] = useState<NamedPlaylist[] | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [driftMap, setDriftMap] = useState<Record<string, DriftState>>({});
  const [driftBusy, setDriftBusy] = useState(false);

  // Similarity map: 2D PCA projection of every playlist's mean feature vector.
  const [similarityOpen, setSimilarityOpen] = useState(false);
  const [similarityData, setSimilarityData] = useState<NamedPlaylist[] | null>(null);
  const [similarityFeat, setSimilarityFeat] = useState<Record<string, Features> | null>(null);
  const [similarityBusy, setSimilarityBusy] = useState(false);
  const archivedFiles = useMemo(
    () => new Set(playlists.filter((p) => p.archived).map((p) => p.file)),
    [playlists]
  );

  // Audio features keyed by bare Spotify id, seeded on open and merged as tracks are added.
  const [featureMap, setFeatureMap] = useState<Record<string, Features>>({});
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set()); // track ids in flight
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [cols, setCols] = useState<FeatureKey[]>(prefs.DEFAULT_COLS); // visible feature columns
  const [colPicker, setColPicker] = useState(false);
  const [goal, setGoalState] = useState<Goal | null>(null); // optional per-playlist target
  const [goalEditing, setGoalEditing] = useState(false);

  const player = useNowPlaying();
  const git = useGit();
  const { blocked } = useRateLimit();
  // Monotonic ticket for async loads that replace the draft (open/pull/revert/push). A
  // slow response from a playlist the user has already navigated away from must not apply
  // its state (or its sync banner) over the newer playlist.
  const openTicket = useRef(0);
  const tracksRef = useRef<HTMLOListElement>(null);
  const [focusTrack, setFocusTrack] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  useEffect(() => {
    void loadList();
  }, []);

  // Success/status popups are transient: auto-dismiss after a few seconds. Errors stay
  // until dismissed so they aren't missed.
  useEffect(() => {
    if (status?.kind !== "ok") return;
    const t = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(t);
  }, [status]);

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

  async function loadList() {
    setBusy("load");
    try {
      setPlaylists(await api.listLocalPlaylists());
      // Keep the data-repo chip live after any change that may have written files.
      git?.refresh();
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function togglePin(p: LocalPlaylist) {
    try {
      await api.setPinned(p.file, !p.pinned);
      void loadList();
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  async function doCreate(name: string, description: string) {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const np = await api.createPlaylist(name.trim(), description.trim());
      setCreateOpen(false);
      await loadList();
      void open(np.file);
      setStatus({ kind: "ok", msg: `Created "${np.name}"` });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setCreating(false);
    }
  }

  async function doDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deletePlaylist(deleteTarget.file);
      const name = deleteTarget.name;
      if (selected === deleteTarget.file) {
        setSelected(null);
        setDraft(null);
        setDirty(false);
        setStaged(false);
      }
      setDeleteTarget(null);
      await loadList();
      setStatus({ kind: "ok", msg: `Deleted "${name}"` });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setDeleting(false);
    }
  }

  async function toggleArchive(file: string, currentlyArchived: boolean) {
    try {
      await api.setArchived(file, !currentlyArchived);
      setStatus({
        kind: "ok",
        msg: currentlyArchived
          ? "Unarchived"
          : "Archived (still on Spotify until you unfollow)",
      });
      void loadList();
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  async function unfollowArchivedAll() {
    const n = playlists.filter((p) => p.archived).length;
    if (n === 0) return;
    if (
      !(await confirmDialog(
        `Unfollow ${n} archived playlist(s) from Spotify?\n\nThey'll be removed from your Spotify library but kept in Setlist. You stay the owner, so editing/playback still work, and you can re-add them later.`,
        "Unfollow"
      ))
    )
      return;
    try {
      const r = await api.unfollowArchived();
      if (r.failed.length > 0) {
        setStatus({
          kind: "err",
          msg: `Unfollowed ${r.done}, but ${r.failed.length} failed: ${r.failed[0]}${
            r.failed.length > 1 ? ` (+${r.failed.length - 1} more)` : ""
          }`,
        });
      } else {
        setStatus({ kind: "ok", msg: `Unfollowed ${r.done} playlist(s) from Spotify` });
      }
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  async function refollow(file: string) {
    try {
      await api.followPlaylist(file);
      setStatus({ kind: "ok", msg: "Re-added to your Spotify library" });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  // Fetch audio features for the given tracks in the background and merge them in.
  // Non-blocking: rows render immediately, numbers fill in when the fetch resolves. Tracks
  // already in the map are skipped (features are id-keyed and stable across playlists).
  function loadFeatures(tracks: TrackEntry[]) {
    // Skip tracks we already have *and* tracks already in flight (analyzing) — e.g. when
    // switching back and forth between playlists before the first fetch resolves.
    const pending = tracks.filter(
      (t) => !(bareId(t.id) in featureMap) && !analyzing.has(t.id)
    );
    if (pending.length === 0) return;
    const ids = pending.map((t) => t.id);
    setAnalyzing((prev) => new Set([...prev, ...ids]));
    api
      .trackFeatures(pending)
      .then((map) => setFeatureMap((prev) => ({ ...prev, ...map })))
      .catch(() => {})
      .finally(() =>
        setAnalyzing((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        })
      );
  }

  // Toggle a feature column on/off, keeping canonical order, and persist per playlist.
  function toggleCol(key: FeatureKey) {
    setCols((prev) => {
      const want = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key];
      const ordered = FEATURE_META.filter((m) => want.includes(m.key)).map((m) => m.key);
      if (selected) {
        try {
          prefs.setCols(selected, ordered);
        } catch {
          /* ignore quota/availability errors */
        }
      }
      return ordered;
    });
  }

  async function open(file: string, focusTrackId?: string) {
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
        api.listLocalPlaylists().then(setPlaylists).catch(() => {}); // refresh modified dot
      } catch (e) {
        setStatus({ kind: "err", msg: String(e) });
        return; // couldn't preserve the edits — stay put rather than lose them
      }
    }
    const ticket = ++openTicket.current;
    setBusy("open");
    setStatus(null);
    setResults([]);
    setQuery("");
    setSync(null);
    setConflict(null);
    // Keep the feature map across playlist switches: features are keyed by track id and are
    // identical wherever a track appears, so reusing them avoids a frame of empty metrics,
    // which reads as a jarring flicker.
    setCols(loadCols(file));
    setColPicker(false);
    setGoalState(loadGoal(file));
    setGoalEditing(false);
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
      setSortKey("index"); // open in official order
      setSortDir("asc");
      setIssuesOpen(false);
      setDoctorOpen(false);
      setLibraryOpen(false);
      setHistoryOpen(false);
      setStatusOpen(false);
      setSimilarityOpen(false);
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
          .then(() => void loadList())
          .catch(() => {});
      }
      setStaged(isStaged);
      setEditMeta(false);
      setDirty(false);
      loadFeatures(tracks); // background; only fetches tracks we don't already have
      if (focusTrackId) setFocusTrack(focusTrackId);
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
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      if (ticket === openTicket.current) setBusy(null);
    }
  }

  // A playlist's file is named after the playlist, so pulling or pushing a rename moves it
  // out from under the open editor. Re-point at where it landed, and re-read the goal and
  // column stores — the backend moved this playlist's entries to the new key and prefs holds
  // both in memory, so a later save from the stale copy would undo that.
  async function followRename(file: string) {
    if (file === selected) return;
    setSelected(file);
    await prefs.loadPrefs();
  }

  // Pull Spotify's current version into the canonical mirror (discards local edits).
  async function pullRemote() {
    if (!selected) return;
    if (
      (dirty || staged) &&
      !(await confirmDialog(
        "Pull Spotify's version? This discards your local edits.",
        "Pull & discard"
      ))
    )
      return;
    const ticket = ++openTicket.current;
    setBusy("open");
    setStatus(null);
    try {
      await api.clearStaged(selected);
      const { file, playlist: pf } = await api.refreshPlaylist(selected);
      if (ticket !== openTicket.current) return; // user opened another playlist meanwhile
      await followRename(file);
      setDraft(pf);
      markPersisted(pf.name, pf.description, pf.tracks);
      canonicalRef.current = persistedRef.current;
      setBaseline(pf.tracks);
      loadFeatures(pf.tracks);
      setDirty(false);
      setStaged(false);
      setSync(null);
      setStatus({ kind: "ok", msg: "Pulled Spotify's current version" });
      void loadList();
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
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
        .then(() => void loadList()) // refresh the sidebar's modified dot
        .catch(() => {}); // a leftover equal-to-mirror staged file is harmless; open() also cleans it
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

  function removeAt(i: number) {
    if (!draft) return;
    edit(draft.tracks.filter((_, idx) => idx !== i));
  }

  // --- Cleanup fixes (operate on the draft; reviewable in the diff before push) ---
  function fixExactDuplicates() {
    if (!draft) return;
    edit(removeExactDuplicates(draft.tracks));
  }

  // Resolve an ISRC group down to the one release to keep, removing the other variants.
  function keepIsrcVariant(group: DupGroup, keepId: string) {
    if (!draft) return;
    const remove = new Set(
      group.occurrences.map((o) => bareId(o.track.id)).filter((id) => id !== keepId)
    );
    edit(removeTracksByIds(draft.tracks, remove));
  }

  // Persist any in-memory edit (stage it, or clear the staged file if the edits cancelled
  // out) so the library-wide views read current data. Returns false if persisting failed —
  // the caller should abort opening the view.
  async function flushDirtyEdits(): Promise<boolean> {
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
      setStatus({ kind: "err", msg: String(e) });
      return false;
    }
  }

  // Library-wide scan: (re)load every playlist's effective tracks for the doctor view.
  async function openDoctor() {
    if (!(await flushDirtyEdits())) return;
    setDoctorOpen(true);
    setLibraryOpen(false);
    setHistoryOpen(false);
    setStatusOpen(false);
    setSimilarityOpen(false);
    setDoctorBusy(true);
    try {
      setDoctorData(await api.readAllPlaylists());
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setDoctorBusy(false);
    }
  }

  // Open the global library: every song across every playlist, deduped (see AllSongsView).
  async function openLibrary() {
    if (!(await flushDirtyEdits())) return;
    setLibraryOpen(true);
    setDoctorOpen(false);
    setHistoryOpen(false);
    setStatusOpen(false);
    setSimilarityOpen(false);
    setLibraryBusy(true);
    try {
      setLibraryData(await api.readAllPlaylists());
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setLibraryBusy(false);
    }
  }

  // Open the stale-track view: every song joined with its play history (see StaleView).
  async function openHistory() {
    if (!(await flushDirtyEdits())) return;
    setHistoryOpen(true);
    setLibraryOpen(false);
    setDoctorOpen(false);
    setStatusOpen(false);
    setSimilarityOpen(false);
    setHistoryBusy(true);
    try {
      const [playlists, report] = await Promise.all([
        api.readAllPlaylists(),
        api.historyStats(),
      ]);
      setHistoryData(playlists);
      setHistoryReport(report);
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setHistoryBusy(false);
    }
  }

  // Open the status dashboard: a library-wide overview of unpushed edits, drift, and lint
  // issues. The local signals load here; drift is checked separately (see checkAllDrift).
  async function openStatus() {
    if (!(await flushDirtyEdits())) return;
    setStatusOpen(true);
    setLibraryOpen(false);
    setDoctorOpen(false);
    setHistoryOpen(false);
    setSimilarityOpen(false);
    setStatusBusy(true);
    setDriftMap({}); // stale drift results don't carry across opens
    try {
      const [local, data] = await Promise.all([
        api.listLocalPlaylists(),
        api.readAllPlaylists(),
      ]);
      setStatusLocal(local);
      setStatusData(data);
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setStatusBusy(false);
    }
  }

  // Open the similarity map: every playlist projected to 2D from its mean feature vector.
  // Needs features for ALL tracks across ALL playlists, so it reuses whatever's already in
  // featureMap and only fetches the rest (cached server-side, so repeat opens are cheap).
  async function openSimilarity() {
    if (!(await flushDirtyEdits())) return;
    setSimilarityOpen(true);
    setLibraryOpen(false);
    setDoctorOpen(false);
    setHistoryOpen(false);
    setStatusOpen(false);
    setSimilarityBusy(true);
    try {
      const playlists = await api.readAllPlaylists();
      // Unique tracks across the whole library, minus ones we've already analyzed.
      const seen = new Set<string>();
      const missing: TrackEntry[] = [];
      for (const pl of playlists) {
        for (const t of pl.tracks) {
          const id = bareId(t.id);
          if (seen.has(id)) continue;
          seen.add(id);
          if (!featureMap[id]) missing.push(t);
        }
      }
      const fetched = missing.length ? await api.trackFeatures(missing) : {};
      const merged = { ...featureMap, ...fetched };
      setFeatureMap(merged); // reuse for the editor's metrics later
      setSimilarityData(playlists);
      setSimilarityFeat(merged);
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setSimilarityBusy(false);
    }
  }

  // Check every remote playlist for drift, one cheap snapshot request at a time. The backend
  // rate limiter paces the calls; a rate-limit (or other) error stops the run and surfaces.
  async function checkAllDrift() {
    const targets = (statusLocal ?? []).filter((p) => !p.archived && p.spotify_id !== "");
    if (targets.length === 0) return;
    setDriftBusy(true);
    try {
      for (const p of targets) {
        setDriftMap((m) => ({ ...m, [p.file]: "checking" }));
        const s = await api.syncStatus(p.file);
        setDriftMap((m) => ({ ...m, [p.file]: s.remote_changed ? "drifted" : "clean" }));
      }
    } catch (e) {
      // Drop the in-flight "checking" marker so it doesn't hang, and surface the reason.
      setDriftMap((m) => {
        const next = { ...m };
        for (const k of Object.keys(next)) if (next[k] === "checking") delete next[k];
        return next;
      });
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setDriftBusy(false);
    }
  }

  // Search for a playable stand-in for an unavailable track (library first, then Spotify).
  async function findReplacement(t: TrackEntry) {
    setReplaceState((p) => ({ ...p, [t.id]: "loading" }));
    try {
      const s = await api.suggestReplacement(t);
      setReplaceState((p) => ({ ...p, [t.id]: s }));
    } catch (e) {
      setReplaceState((p) => ({ ...p, [t.id]: null }));
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  // Swap the unavailable track at `index` for its suggested replacement, preserving when/who
  // added it. Staged on Save, reviewable in the diff before pushing.
  function applyReplacement(index: number, s: ReplacementSuggestion) {
    if (!draft) return;
    const old = draft.tracks[index];
    if (!old) return;
    const replaced: TrackEntry = {
      id: s.id,
      isrc: s.isrc,
      title: s.title,
      artists: s.artists,
      added_at: old.added_at,
      added_by: old.added_by,
      duration_ms: s.duration_ms,
      is_playable: true,
    };
    edit(draft.tracks.map((t, i) => (i === index ? replaced : t)));
    loadFeatures([replaced]);
    setStatus({ kind: "ok", msg: `Replaced "${old.title}" with a playable version` });
  }

  // Normalize a cross-playlist near-dup: keep one track id, replace the other variants with
  // it in every playlist they appear in (collapsing any duplicate that creates). Stages each
  // affected playlist so the change is reviewable in its diff before pushing.
  async function normalizeCrossDup(group: CrossDupGroup, keepId: string) {
    const keep = group.variants.find((v) => v.id === keepId);
    if (!keep || !doctorData) return;
    const removeIds = new Set(group.variants.filter((v) => v.id !== keepId).map((v) => v.id));
    try {
      let changed = 0;
      for (const pl of doctorData) {
        if (!pl.tracks.some((t) => removeIds.has(t.id))) continue;
        const replaced = pl.tracks.map((t) =>
          removeIds.has(t.id) ? { ...keep.track, added_at: t.added_at, added_by: t.added_by } : t
        );
        const deduped = removeExactDuplicates(replaced);
        const staged = await api.getStaged(pl.file);
        await api.stagePlaylist(
          pl.file,
          staged?.name ?? null,
          staged?.description ?? null,
          deduped
        );
        if (pl.file === selected) {
          // This staged behind the open editor's back — sync the in-memory draft, or a
          // later Save would clobber the normalization with the stale track list.
          setDraft((d) => {
            if (!d) return d;
            // Recording the snapshot here is idempotent, so it's safe in the updater.
            markPersisted(d.name, d.description, deduped);
            return { ...d, tracks: deduped };
          });
          setDirty(false);
          setStaged(true);
        }
        changed++;
      }
      setStatus({
        kind: "ok",
        msg: `Normalized "${group.title}" across ${changed} playlist${
          changed > 1 ? "s" : ""
        } (staged — open each to review and push)`,
      });
      void openDoctor(); // rescan with the fixes applied
      void loadList();
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  function addResult(r: SearchResult) {
    if (!draft) return;
    const track: TrackEntry = {
      id: r.id,
      isrc: r.isrc,
      title: r.title,
      artists: r.artists,
      added_at: null,
      added_by: null,
      duration_ms: r.duration_ms,
    };
    edit([...draft.tracks, track]);
    loadFeatures([track]); // background fetch for just this track
  }

  // Copy a track (dragged from the open editor) into another playlist's staged edits.
  // The target isn't open in the editor, so we read its effective tracks (staged ?? canonical),
  // append, and re-stage — no Spotify call, no change to the open playlist.
  const TRACK_MIME = "application/x-setlist-track";
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

  async function revert() {
    if (!selected) return;
    if (
      (dirty || staged) &&
      !(await confirmDialog("Discard your edits and reload the saved version?", "Discard"))
    )
      return;
    const ticket = ++openTicket.current;
    setBusy("open");
    setStatus(null);
    try {
      await api.clearStaged(selected); // drop cached edits (local, no Spotify call)
      const pf = await api.readPlaylist(selected); // reload canonical mirror
      if (ticket !== openTicket.current) return; // user opened another playlist meanwhile
      setDraft(pf);
      markPersisted(pf.name, pf.description, pf.tracks);
      canonicalRef.current = persistedRef.current;
      setBaseline(pf.tracks);
      loadFeatures(pf.tracks);
      setDirty(false);
      setStaged(false);
      setStatus({ kind: "ok", msg: "Reverted — edits discarded" });
      void loadList();
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      if (ticket === openTicket.current) setBusy(null);
    }
  }

  async function save() {
    if (!draft || !selected) return;
    setBusy("save");
    setStatus(null);
    try {
      if (contentKey(draft.name, draft.description, draft.tracks) === canonicalRef.current) {
        // Edits cancelled out — nothing differs from the Spotify mirror, so saving would
        // only create a no-op staged file. Clear any existing one instead.
        await api.clearStaged(selected);
        markPersisted(draft.name, draft.description, draft.tracks);
        setDirty(false);
        setStaged(false);
        setStatus({ kind: "ok", msg: "No changes — already matches the Spotify mirror" });
      } else {
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
        setStatus({ kind: "ok", msg: "Saved (cached locally; not yet pushed to Spotify)" });
      }
      void loadList();
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function push() {
    if (!draft) return;
    if (!(await confirmDialog(`Push "${draft.name}" to Spotify?`, "Push"))) return;
    void doPush("safe");
  }

  async function doPush(strategy: PushStrategy) {
    if (!draft || !selected) return;
    const ticket = ++openTicket.current;
    setBusy("push");
    setStatus(null);
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
        void loadList();
        return;
      }
      if (res.status === "conflict" && res.conflict) {
        setConflict(res.conflict);
        setStatus({
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
        setStatus(
          res.warning
            ? { kind: "warn", msg: res.warning }
            : {
                kind: "ok",
                msg: `Pushed — Spotify now matches (${res.playlist.tracks.length} tracks)`,
              }
        );
        void loadList();
      }
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      if (ticket === openTicket.current) setBusy(null);
    }
  }

  // Debounced Spotify search (for adding tracks). Suspended while rate-limited.
  useEffect(() => {
    if (query.trim() === "" || blocked) {
      setResults([]);
      setSearching(false); // clear a stuck "Searching…" when the box is emptied mid-search
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.searchTracks(query);
        if (!cancelled) setResults(r);
      } catch (e) {
        if (!cancelled) setStatus({ kind: "err", msg: String(e) });
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, blocked]);

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

  // Live metrics, recomputed locally from the draft + cached features (no network).
  const featureOf = (t: TrackEntry): Features | undefined => featureMap[bareId(t.id)];
  const [outlierMode, setOutlierModeState] = useState<OutlierMode>(loadOutlierMode);
  function setOutlierMode(mode: OutlierMode) {
    setOutlierModeState(mode);
    saveOutlierMode(mode);
  }
  const aggregates = useMemo(
    () => (draft ? computeAggregates(draft.tracks, featureOf) : null),
    [draft, featureMap]
  );
  const outlierResult = useMemo(
    () =>
      draft
        ? computeOutliersByMode(outlierMode, draft.tracks, featureOf)
        : { map: new Map<string, Outlier>(), effective: outlierMode },
    [draft, featureMap, outlierMode]
  );
  const outliers = outlierResult.map;
  // When a goal is set, flag tracks that deviate from it (this replaces the average-based
  // outlier flags). Keyed by track id; each entry lists the off-goal dimensions, worst first.
  const goalDeviations = useMemo(
    () => (draft && goal ? computeGoalDeviations(draft.tracks, featureOf, goal) : new Map()),
    [draft, featureMap, goal]
  );

  // --- Fingerprint goal controls (persisted per playlist in goals.json) ---
  function updateGoal(next: Goal | null) {
    setGoalState(next);
    if (selected) saveGoal(selected, next);
  }
  const goalControl: GoalControl = {
    goal,
    editing: goalEditing,
    start: () => {
      // Seed from the current averages so you adjust from where the playlist already sits.
      const seed = {} as Goal;
      for (const k of GOAL_DIMS) {
        const v = aggregates ? (aggregates[`avg_${k}` as keyof Aggregates] as number | null) : null;
        seed[k] = v ?? 0.5;
      }
      updateGoal(seed);
      setGoalEditing(true);
    },
    edit: () => setGoalEditing(true),
    done: () => setGoalEditing(false),
    clear: () => {
      updateGoal(null);
      setGoalEditing(false);
    },
    setDim: (dim, value) => {
      if (!goal) return;
      updateGoal({ ...goal, [dim]: value });
    },
  };
  // True while features for the current playlist are still being fetched — used to show a
  // brief "analyzing" note instead of flashing the empty-state on a playlist's first view.
  const metricsLoading = useMemo(
    () => (draft ? draft.tracks.some((t) => analyzing.has(t.id)) : false),
    [draft, analyzing]
  );
  // Gate the "analyzing…" indicator behind a short delay: the common case resolves in a few
  // ms, so showing it immediately just flickers on every switch. Only surface it if the load
  // is genuinely slow (>0.5s).
  const [showAnalyzing, setShowAnalyzing] = useState(false);
  useEffect(() => {
    if (!metricsLoading) {
      setShowAnalyzing(false);
      return;
    }
    const t = setTimeout(() => setShowAnalyzing(true), 500);
    return () => clearTimeout(t);
  }, [metricsLoading]);

  // Inline diff of the draft against the Spotify mirror — drives the "Show changes" review.
  const diff = useMemo(
    () => diffTracks(baseline, draft?.tracks ?? []),
    [baseline, draft]
  );
  const inDiff = showDiff && diff.changed;

  // Live cleanup issues for the open playlist (recomputed as you edit the draft).
  const lint = useMemo(() => lintPlaylist(draft?.tracks ?? []), [draft]);

  // Display order for the editable track list. Each entry keeps its real draft index `i`
  // (used for editing and shown as the official "#"), so a title/duration sort is purely a
  // view — the underlying playlist order never changes.
  const orderedTracks = useMemo(() => {
    const arr = (draft?.tracks ?? []).map((t, i) => ({ t, i }));
    if (sortKey === "index") return arr;
    const dir = sortDir === "asc" ? 1 : -1;
    if (sortKey === "title") {
      return [...arr].sort(
        (a, b) => dir * a.t.title.localeCompare(b.t.title, undefined, { sensitivity: "base" })
      );
    }
    if (sortKey === "duration") {
      return [...arr].sort((a, b) => dir * ((a.t.duration_ms ?? 0) - (b.t.duration_ms ?? 0)));
    }
    // Audio-feature sort. Tracks not yet analyzed (no feature value) always sink to the
    // bottom, regardless of direction, so the sorted block is the songs we actually know.
    const valueOf = (t: TrackEntry): number | null => {
      const f = featureOf(t);
      return f ? (f[sortKey] as number) : null;
    };
    return [...arr].sort((a, b) => {
      const av = valueOf(a.t);
      const bv = valueOf(b.t);
      if (av == null) return bv == null ? 0 : 1;
      if (bv == null) return -1;
      return dir * (av - bv);
    });
  }, [draft, sortKey, sortDir, featureMap]);

  function toggleSort(key: SortKey) {
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
        onClick={() => open(p.file)}
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
      player?.play(ctx, t.id);
      return;
    }
    const from = draft.tracks.findIndex((x) => x.id === t.id);
    const next = draft.tracks.slice(from + 1).find(playable);
    if (!next) {
      setStatus({ kind: "err", msg: "No playable track from here — the rest are unavailable on Spotify." });
      return;
    }
    player?.play(ctx, next.id);
  }

  // One row renderer for both modes. In normal mode (status "normal") it's the editable row
  // with drag + remove; in diff mode it's read-only with add/remove/move styling. Every
  // branch keeps the same grid cells so columns stay aligned.
  function trackRow(
    t: TrackEntry,
    opts: { key: string; status: DiffStatus | "normal"; position: number | null; draftIndex?: number }
  ) {
    const { key, status, position, draftIndex } = opts;
    const editable = status === "normal";
    const removed = status === "removed";
    const canReorder = editable && sortKey === "index"; // drag only in official order
    const i = draftIndex ?? -1;
    const f = featureOf(t);
    // A goal replaces the average-based outlier flag: when set, show off-goal dimensions.
    const o = metricsOpen && !goal ? outliers.get(t.id) : undefined;
    // Goal flags show whenever a goal is set (not just when the metrics panel is open) —
    // the whole point is to surface tracks that miss the target.
    const goalOff: GoalDeviation[] | undefined = goal ? goalDeviations.get(t.id) : undefined;
    const isPlaying = isPlayingTrack(t.id);
    const local = isLocalTrack(t.id);
    const unavailable = t.is_playable === false; // greyed out on Spotify
    const diffClass = status !== "normal" && status !== "unchanged" ? `diff-${status}` : "";
    return (
      <li
        key={key}
        data-tid={t.id}
        className={`track ${metricsOpen ? "with-feats" : ""} ${o ? "has-outlier" : ""} ${
          isPlaying ? "playing" : ""
        } ${isPlaying && playingActive ? "playing-active" : ""} ${
          canReorder && overIndex === i ? "over" : ""
        } ${flashId === t.id ? "flash" : ""} ${unavailable ? "unavailable" : ""} ${diffClass}`}
        draggable={canReorder}
        onDragStart={
          canReorder
            ? (e) => {
                dragIndex.current = i;
                e.dataTransfer.effectAllowed = "copyMove";
                e.dataTransfer.setData("text/plain", String(i));
                e.dataTransfer.setData(TRACK_MIME, JSON.stringify(t));
              }
            : undefined
        }
        onDragOver={
          canReorder
            ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overIndex !== i) setOverIndex(i);
              }
            : undefined
        }
        onDragLeave={canReorder ? () => overIndex === i && setOverIndex(null) : undefined}
        onDrop={
          canReorder
            ? (e) => {
                e.preventDefault();
                onDrop(i);
              }
            : undefined
        }
        onDragEnd={
          canReorder
            ? () => {
                dragIndex.current = null;
                setOverIndex(null);
              }
            : undefined
        }
        onDoubleClick={() => (local || removed ? undefined : playFrom(t))}
      >
        {editable ? (
          canReorder ? (
            <span className="grip" title="Drag to reorder">
              ⋮⋮
            </span>
          ) : (
            <span />
          )
        ) : (
          <span className="diff-mark" aria-hidden>
            {status === "added" ? "+" : status === "removed" ? "−" : status === "moved" ? "↕" : ""}
          </span>
        )}
        <span className="t-num">
          {isPlaying ? (
            <span className="eq" aria-label="Now playing">
              <i />
              <i />
              <i />
            </span>
          ) : (
            position ?? ""
          )}
        </span>
        <span className="t-title">
          <span className="t-title-text">{t.title}</span>
          {local && (
            <span
              className="local-tag"
              title="Local file added on Spotify — playable only in the Spotify desktop app"
            >
              local
            </span>
          )}
          {unavailable && (
            <span
              className="unavail-tag"
              title="Greyed out on Spotify — unavailable in your region or removed. Can't be played by any Spotify client."
            >
              unavailable
            </span>
          )}
          {status === "added" && <span className="diff-badge add">added</span>}
          {status === "removed" && <span className="diff-badge rem">removing</span>}
          {status === "moved" && <span className="diff-badge move">moved</span>}
          {o && (
            <span
              className="outlier-chip"
              title={
                o.method === "multivariate"
                  ? `Unusual combination of metrics for this playlist (distance ${o.z.toFixed(
                      1
                    )}, beyond the 95% envelope). Driven by: ${(o.contributors ?? [])
                      .map(
                        (c) =>
                          `${FEATURE_LABEL[c.feature]} ${c.dir === "up" ? "↑" : "↓"} (${Math.round(
                            c.share * 100
                          )}%)`
                      )
                      .join(", ")}`
                  : `This song's ${FEATURE_LABEL[o.feature]} is well ${
                      o.dir === "up" ? "above" : "below"
                    } the playlist average (${Math.abs(o.z).toFixed(1)}σ)`
              }
            >
              {o.dir === "up" ? "▲" : "▼"} {FEATURE_LABEL[o.feature]}
              {o.method === "multivariate" && (o.contributors?.length ?? 0) > 1 ? " +" : ""}
            </span>
          )}
          {goalOff?.slice(0, 3).map((d) => (
            <span
              key={d.feature}
              className="goal-chip"
              title={`${FEATURE_LABEL[d.feature]} is ${Math.round(
                Math.abs(d.diff) * 100
              )}% ${d.dir === "up" ? "above" : "below"} your goal`}
            >
              {d.dir === "up" ? "▲" : "▼"} {FEATURE_LABEL[d.feature]}
            </span>
          ))}
        </span>
        <span className="t-artists">{t.artists.join(", ")}</span>
        {metricsOpen && (
          <span className="t-feats">
            {cols.map((k, ci) => (
              <span key={k} className="t-feat">
                {f
                  ? fmtFeature(f, k)
                  : ci === 0
                  ? analyzing.has(t.id)
                    ? "…"
                    : "–"
                  : ""}
              </span>
            ))}
          </span>
        )}
        <span className="t-dur">{fmtDuration(t.duration_ms)}</span>
        {removed ? (
          <span />
        ) : (
          <button
            className="t-play"
            title={
              local
                ? "Local file — playable only in the Spotify desktop app"
                : unavailable
                ? "Unavailable on Spotify — plays from the next available track"
                : "Play in Setlist"
            }
            disabled={local}
            onClick={() => playFrom(t)}
          >
            ▶
          </button>
        )}
        {editable ? (
          <button className="t-remove" title="Remove" onClick={() => removeAt(i)}>
            ×
          </button>
        ) : (
          <span />
        )}
      </li>
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
                  {busy === "load" ? "Loading…" : "No playlists. Pull them in Setup first."}
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
                    void open(h.file, h.id);
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
            className={`tool-btn ${libraryOpen ? "active" : ""}`}
            onClick={() => void openLibrary()}
            title="All songs — browse every song across all your playlists"
            aria-label="All songs"
          >
            <IcoSongs />
          </button>
          <button
            className={`tool-btn ${doctorOpen ? "active" : ""}`}
            onClick={() => void openDoctor()}
            title="Cleanup — scan your whole library for duplicate and unavailable tracks"
            aria-label="Cleanup"
          >
            <IcoClean />
          </button>
          <button
            className={`tool-btn ${historyOpen ? "active" : ""}`}
            onClick={() => void openHistory()}
            title="Stale tracks — find tracks you rarely or never play"
            aria-label="Stale tracks"
          >
            <IcoClock />
          </button>
          <button
            className={`tool-btn ${statusOpen ? "active" : ""}`}
            onClick={() => void openStatus()}
            title="Status — unpushed edits, drift from Spotify, and lint issues"
            aria-label="Status"
          >
            <IcoStatus />
          </button>
          <button
            className={`tool-btn ${similarityOpen ? "active" : ""}`}
            onClick={() => void openSimilarity()}
            title="Similarity map — see which playlists have similar audio profiles"
            aria-label="Similarity map"
          >
            <IcoMap />
          </button>
        </div>
      </aside>

      <section className="editor">
        {libraryOpen ? (
          <AllSongsView
            data={libraryData}
            busy={libraryBusy}
            onClose={() => setLibraryOpen(false)}
            onOpenTrack={(file, trackId) => void open(file, trackId)}
          />
        ) : doctorOpen ? (
          <DoctorView
            data={doctorData}
            busy={doctorBusy}
            onClose={() => setDoctorOpen(false)}
            onOpenPlaylist={(file) => void open(file)}
            onNormalize={(group, keepId) => void normalizeCrossDup(group, keepId)}
          />
        ) : historyOpen ? (
          <StaleView
            data={historyData}
            history={historyReport}
            busy={historyBusy}
            onClose={() => setHistoryOpen(false)}
            onOpenTrack={(file, trackId) => void open(file, trackId)}
          />
        ) : statusOpen ? (
          <StatusView
            local={statusLocal}
            data={statusData}
            busy={statusBusy}
            driftMap={driftMap}
            driftBusy={driftBusy}
            onCheckDrift={() => void checkAllDrift()}
            onClose={() => setStatusOpen(false)}
            onOpenPlaylist={(file) => void open(file)}
          />
        ) : similarityOpen ? (
          <SimilarityView
            data={similarityData}
            feat={similarityFeat}
            archived={archivedFiles}
            busy={similarityBusy}
            onClose={() => setSimilarityOpen(false)}
            onOpenPlaylist={(file) => void open(file)}
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
                            toggleArchive(selected!, currentArchived);
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
                              refollow(selected!);
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
                  <button className="link" onClick={() => setSync(null)}>
                    Dismiss
                  </button>
                </span>
              </div>
            )}

            <div className="add-box">
              <input
                className="filter"
                name="spotify-track-search"
                aria-label="Search Spotify to add a track"
                placeholder={
                  blocked
                    ? "Spotify search paused — rate-limited"
                    : "Search Spotify to add a track…"
                }
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={blocked}
              />
              {(searching || results.length > 0) && (
                <ul className="results">
                  {searching && <li className="hint pad">Searching…</li>}
                  {results.map((r) => (
                    <li key={r.id}>
                      <button className="result" onClick={() => addResult(r)}>
                        <span className="r-title">{r.title}</span>
                        <span className="r-meta">
                          {r.artists.join(", ")}
                          {r.album ? ` · ${r.album}` : ""}
                        </span>
                        <span className="r-dur">{fmtDuration(r.duration_ms)}</span>
                        <span className="r-add">+ add</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

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
                          effective: outlierResult.effective,
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

            {!inDiff && issueCount(lint) > 0 && (
              <div className="issues-strip">
                <button className="issues-toggle" onClick={() => setIssuesOpen((o) => !o)}>
                  <span className="caret">{issuesOpen ? "▾" : "▸"}</span>
                  <span className="issues-label">
                    ⚠ {issueCount(lint)} cleanup issue{issueCount(lint) > 1 ? "s" : ""}
                  </span>
                </button>
                {issuesOpen && (
                  <div className="issues-body">
                    {lint.exact.length > 0 && (
                      <div className="issue-group">
                        <div className="issue-group-head">
                          <span>Exact duplicates</span>
                          <button className="btn ghost small" onClick={fixExactDuplicates}>
                            Remove all duplicates
                          </button>
                        </div>
                        {lint.exact.map((g) => (
                          <div className="issue-row" key={g.key}>
                            <span className="issue-title">{g.occurrences[0].track.title}</span>
                            <span className="issue-meta">
                              {g.occurrences[0].track.artists.join(", ")} · appears{" "}
                              {g.occurrences.length}×
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {lint.isrc.length > 0 && (
                      <div className="issue-group">
                        <div className="issue-group-head">
                          <span>Possible duplicates (same recording)</span>
                        </div>
                        {lint.isrc.map((g) => (
                          <div className="issue-isrc" key={g.key}>
                            {g.occurrences.map((o) => (
                              <div className="isrc-variant" key={o.track.id}>
                                <span className="issue-title">{o.track.title}</span>
                                <span className="issue-meta">
                                  {o.track.artists.join(", ")} · {fmtDuration(o.track.duration_ms)}
                                </span>
                                <button
                                  className="btn ghost small"
                                  onClick={() => keepIsrcVariant(g, bareId(o.track.id))}
                                >
                                  Keep this
                                </button>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                    {lint.unavailable.length > 0 && (
                      <div className="issue-group">
                        <div className="issue-group-head">
                          <span>Unavailable tracks</span>
                          <span className="hint">
                            greyed out on Spotify — find a near-identical playable swap
                          </span>
                        </div>
                        {lint.unavailable.map(({ track: u, index }) => {
                          const r = replaceState[u.id];
                          return (
                            <div className="issue-unavail" key={`${u.id}-${index}`}>
                              <div className="issue-row">
                                <span className="issue-title">{u.title}</span>
                                <span className="issue-meta">
                                  {u.artists.join(", ")} · {fmtDuration(u.duration_ms)}
                                </span>
                                <button
                                  className="btn ghost small"
                                  disabled={blocked || r === "loading"}
                                  onClick={() => void findReplacement(u)}
                                  title={
                                    blocked
                                      ? "Spotify search paused — rate-limited"
                                      : "Look for a playable stand-in"
                                  }
                                >
                                  {r === "loading"
                                    ? "Searching…"
                                    : r || r === null
                                    ? "Search again"
                                    : "Find replacement"}
                                </button>
                              </div>
                              {r && r !== "loading" && (
                                <div className="replacement">
                                  <span className="repl-arrow" aria-hidden>
                                    ↳
                                  </span>
                                  <span className="issue-title">{r.title}</span>
                                  <span className="issue-meta">
                                    {r.artists.join(", ")} · {fmtDuration(r.duration_ms)} ·{" "}
                                    {r.source === "library"
                                      ? `from "${r.playlist}"`
                                      : "from Spotify"}
                                  </span>
                                  <button
                                    className="btn ghost small"
                                    onClick={() => applyReplacement(index, r)}
                                  >
                                    Replace
                                  </button>
                                </div>
                              )}
                              {r === null && (
                                <div className="replacement">
                                  <span className="hint">No close playable match found.</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

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

            {sortKey !== "index" && !inDiff && (
              <p className="sort-note hint">
                Sorted by {sortKey} — display only; the playlist's saved order is unchanged.
                <button className="link" onClick={() => toggleSort("index")}>
                  Restore official order
                </button>
              </p>
            )}

            <ol className="tracks" ref={tracksRef}>
              {inDiff
                ? diff.rows.map((r) =>
                    trackRow(r.track, { key: r.key, status: r.status, position: r.position })
                  )
                : orderedTracks.map(({ t, i }) =>
                    trackRow(t, { key: `${t.id}-${i}`, status: "normal", position: i + 1, draftIndex: i })
                  )}
            </ol>
          </>
        )}
      </section>

      {status && (
        <p className={`status ${status.kind} lib-status`}>
          <span>{status.msg}</span>
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
          onMerge={() => void doPush("merge")}
          onOverwrite={() => void doPush("overwrite")}
          onClose={() => setConflict(null)}
        />
      )}
    </div>
  );
}
