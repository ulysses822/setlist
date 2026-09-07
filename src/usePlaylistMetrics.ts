// Audio-feature state for the open playlist: the shared feature cache, the derived
// aggregates / outliers / goal deviations, and the per-playlist view choices (which columns
// are shown, whether the metrics panel is open, the mood goal).
//
// Pulled out of Library as one unit because it is one: nine pieces of state that only ever
// change together, five memos derived from them, and the four functions that maintain them.
// Inside Library they were nine `useState` calls scattered between unrelated concerns, and
// anything wanting metrics had to name all of them. Here they are a single value that can be
// passed as one prop, which is what makes splitting the editor out later tractable.
//
// The feature cache is deliberately NOT per-playlist: features are keyed by track id and are
// identical wherever a track appears, so keeping it across switches avoids a frame of empty
// metrics on every click. Only the view choices reset, via `resetFor`.

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { api, type Features, type TrackEntry } from "./api";
import type { GoalControl } from "./MetricsPanel";
import {
  bareId,
  computeAggregates,
  type Aggregates,
  computeGoalDeviations,
  computeOutliersByMode,
  FEATURE_META,
  GOAL_DIMS,
  type FeatureKey,
  type Goal,
  type GoalDeviation,
  type Outlier,
  type OutlierMode,
} from "./metricsCalc";
import * as prefs from "./prefs";

export interface PlaylistMetrics {
  /// Cached features for every track seen this session, keyed by bare Spotify id. Exposed
  /// (with its setter) because the similarity map fetches library-wide features and folds
  /// them in here so the editor doesn't re-fetch them.
  featureMap: Record<string, Features>;
  setFeatureMap: Dispatch<SetStateAction<Record<string, Features>>>;
  featureOf: (t: TrackEntry) => Features | undefined;
  /// Fetch features for any of `tracks` we don't already have or aren't already fetching.
  loadFeatures: (tracks: TrackEntry[]) => void;
  /// Track ids with a fetch in flight.
  analyzing: Set<string>;
  /// True while any track in the open playlist is still being fetched.
  metricsLoading: boolean;
  /// True only once that fetch has been slow enough to be worth mentioning (see below).
  showAnalyzing: boolean;

  metricsOpen: boolean;
  setMetricsOpen: Dispatch<SetStateAction<boolean>>;
  cols: FeatureKey[];
  toggleCol: (key: FeatureKey) => void;
  colPicker: boolean;
  setColPicker: Dispatch<SetStateAction<boolean>>;

  aggregates: Aggregates | null;
  outliers: Map<string, Outlier>;
  /// The method actually used — `computeOutliersByMode` falls back to the independent method
  /// when there are too few analyzed tracks to trust a covariance.
  outlierEffective: OutlierMode;
  outlierMode: OutlierMode;
  setOutlierMode: (mode: OutlierMode) => void;

  goal: Goal | null;
  goalDeviations: Map<string, GoalDeviation[]>;
  goalControl: GoalControl;

  /// Point the per-playlist view choices at `file`'s saved columns and goal. Called when a
  /// playlist is opened; leaves the feature cache alone.
  resetFor: (file: string) => void;
}

/// `tracks` is the open playlist's *draft* track list, or null when no playlist is open —
/// the distinction matters, since "no playlist" and "an empty playlist" produce different
/// aggregates (null vs. a zeroed set).
export function usePlaylistMetrics(
  selected: string | null,
  tracks: TrackEntry[] | null
): PlaylistMetrics {
  const [featureMap, setFeatureMap] = useState<Record<string, Features>>({});
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set()); // track ids in flight
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [cols, setCols] = useState<FeatureKey[]>(prefs.DEFAULT_COLS); // visible feature columns
  const [colPicker, setColPicker] = useState(false);
  const [goal, setGoalState] = useState<Goal | null>(null); // optional per-playlist target
  const [goalEditing, setGoalEditing] = useState(false);
  const [outlierMode, setOutlierModeState] = useState<OutlierMode>(
    () => prefs.getOutlierMode() as OutlierMode
  );

  const featureOf = (t: TrackEntry): Features | undefined => featureMap[bareId(t.id)];

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
      .catch(() => {}) // a miss and a failure both render as blank cells; neither is fatal
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
      const want = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
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

  function setOutlierMode(mode: OutlierMode) {
    setOutlierModeState(mode);
    prefs.setOutlierMode(mode);
  }

  function updateGoal(next: Goal | null) {
    setGoalState(next);
    if (selected) prefs.setGoal(selected, next);
  }

  function resetFor(file: string) {
    setCols(prefs.getCols(file));
    setColPicker(false);
    setGoalState(prefs.getGoal(file));
    setGoalEditing(false);
  }

  // Live metrics, recomputed locally from the draft + cached features (no network).
  const aggregates = useMemo(
    () => (tracks ? computeAggregates(tracks, featureOf) : null),
    [tracks, featureMap]
  );
  const outlierResult = useMemo(
    () =>
      tracks
        ? computeOutliersByMode(outlierMode, tracks, featureOf)
        : { map: new Map<string, Outlier>(), effective: outlierMode },
    [tracks, featureMap, outlierMode]
  );
  // When a goal is set, flag tracks that deviate from it (this replaces the average-based
  // outlier flags). Keyed by track id; each entry lists the off-goal dimensions, worst first.
  const goalDeviations = useMemo(
    () => (tracks && goal ? computeGoalDeviations(tracks, featureOf, goal) : new Map()),
    [tracks, featureMap, goal]
  );

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

  // True while features for the current playlist are still being fetched.
  const metricsLoading = useMemo(
    () => (tracks ? tracks.some((t) => analyzing.has(t.id)) : false),
    [tracks, analyzing]
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

  return {
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
    outliers: outlierResult.map,
    outlierEffective: outlierResult.effective,
    outlierMode,
    setOutlierMode,
    goal,
    goalDeviations,
    goalControl,
    resetFor,
  };
}
