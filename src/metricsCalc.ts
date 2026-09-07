// Client-side audio-feature math: playlist aggregates, outlier detection and goal
// deviations, behind the editor's metrics panel and per-track columns.
//
// All of it lives here and only here. The backend's metrics.rs fetches per-track features
// from ReccoBeats and caches them, and stops there — nothing below has a Rust counterpart,
// so there is no second implementation to keep in step. Outliers are keyed by track id
// rather than array index, so they survive a reorder.

import type { Features, TrackEntry } from "./api";

/// One playlist's rolled-up feature numbers. Defined here rather than in api.ts because no
/// Tauri command returns it — the backend fetches per-track features and stops; every average
/// below is computed in this file.
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

// Dimensions used for outlier detection. tempo is included (z-scored, so its BPM
// scale doesn't matter); key/mode/loudness are excluded as not mood-comparable.
export const FEATURE_KEYS = [
  "valence",
  "energy",
  "danceability",
  "acousticness",
  "instrumentalness",
  "speechiness",
  "liveness",
  "tempo",
] as const;

export const FEATURE_LABEL: Record<string, string> = {
  valence: "valence",
  energy: "energy",
  danceability: "danceability",
  acousticness: "acousticness",
  instrumentalness: "instrumentalness",
  speechiness: "speechiness",
  liveness: "liveness",
  tempo: "tempo",
};

export type FeatureKey = (typeof FEATURE_KEYS)[number];

// Display metadata for the per-track feature columns: full label, short header
// (first-letter for the percentage features, "BPM" for tempo), and how to format.
export const FEATURE_META: {
  key: FeatureKey;
  short: string;
  label: string;
}[] = [
  { key: "valence", short: "V", label: "Valence" },
  { key: "energy", short: "E", label: "Energy" },
  { key: "danceability", short: "D", label: "Danceability" },
  { key: "acousticness", short: "A", label: "Acousticness" },
  { key: "instrumentalness", short: "I", label: "Instrumentalness" },
  { key: "speechiness", short: "S", label: "Speechiness" },
  { key: "liveness", short: "L", label: "Liveness" },
  { key: "tempo", short: "BPM", label: "Tempo (BPM)" },
];

/// Format one feature value for a track cell: BPM rounded, everything else a percentage.
export function fmtFeature(f: Features | undefined, key: FeatureKey): string {
  if (!f) return "";
  return key === "tempo"
    ? String(Math.round(f.tempo))
    : `${Math.round(f[key] * 100)}%`;
}

const OUTLIER_Z = 2; // flag tracks >2 std devs from the playlist mean on some dimension
const MIN_FOR_OUTLIERS = 6; // too few analyzed tracks to characterize a "norm"

// How outliers are detected:
//  - "independent":  each metric is z-scored on its own; a track is flagged when its worst
//                    single metric is ≥2σ from the playlist mean (the original method).
//  - "multivariate": all metrics are modelled jointly (mean vector + covariance matrix) and
//                    a track is flagged when its Mahalanobis distance puts it outside the
//                    95% envelope — this also catches "unusual combinations" that look
//                    normal on every individual axis.
export type OutlierMode = "independent" | "multivariate";

// Below this many analyzed tracks an 8×8 covariance is too noisy to trust — the caller
// falls back to the independent method.
export const MIN_FOR_MULTI = 20;

// 95th-percentile chi-square critical values for squared Mahalanobis distance, indexed
// by degrees of freedom (0 unused). Dimensions with negligible spread are dropped, so the
// effective dof can be anywhere from 2 to FEATURE_KEYS.length.
const CHI2_95 = [0, 3.841, 5.991, 7.815, 9.488, 11.07, 12.592, 14.067, 15.507];

/// One dimension's share of a multivariate outlier's distance (shares sum to ≤1; only
/// meaningfully-positive contributors are kept).
export type Contributor = { feature: string; dir: "up" | "down"; share: number };

export type Outlier = {
  feature: string;
  dir: "up" | "down";
  /// independent: the z-score on `feature`. multivariate: the Mahalanobis distance, with
  /// `feature`/`dir` describing the top contributor.
  z: number;
  method: OutlierMode;
  /// Multivariate only: which dimensions drive the distance, worst first.
  contributors?: Contributor[];
};

export type FeatureLookup = (track: TrackEntry) => Features | undefined;

/// "spotify:track:ABC" -> "ABC"; also tolerates a bare id. Matches bare_id in metrics.rs.
/// Local files (spotify:local:Artist:Album:Title:Duration) have no track id — their last
/// colon-segment is the duration, which collides across unrelated songs — so the whole URI
/// is their identity.
export function bareId(uri: string): string {
  if (uri.startsWith("spotify:local:")) return uri;
  const i = uri.lastIndexOf(":");
  return i === -1 ? uri : uri.slice(i + 1);
}

/// Local files added to a playlist on Spotify have a `spotify:local:…` uri. They can't be
/// played through the Web API / Web Playback SDK (only in the official client, on the machine
/// that has the file), so we treat them specially.
export function isLocalTrack(id: string): boolean {
  return id.startsWith("spotify:local:");
}

/// Playlist-level summary: the mean of each tracked dimension over the tracks that have
/// features (unanalyzed ones count toward `total` and the duration but not the averages,
/// which are null until at least one track resolves).
export function computeAggregates(
  tracks: TrackEntry[],
  feat: FeatureLookup
): Aggregates {
  const agg: Aggregates = {
    total: tracks.length,
    analyzed: 0,
    total_duration_ms: 0,
    avg_valence: null,
    avg_energy: null,
    avg_danceability: null,
    avg_acousticness: null,
    avg_instrumentalness: null,
    avg_liveness: null,
    avg_speechiness: null,
    avg_tempo: null,
  };
  const sums = {
    valence: 0,
    energy: 0,
    danceability: 0,
    acousticness: 0,
    instrumentalness: 0,
    liveness: 0,
    speechiness: 0,
    tempo: 0,
  };
  for (const t of tracks) {
    agg.total_duration_ms += t.duration_ms ?? 0;
    const f = feat(t);
    if (!f) continue;
    agg.analyzed += 1;
    sums.valence += f.valence;
    sums.energy += f.energy;
    sums.danceability += f.danceability;
    sums.acousticness += f.acousticness;
    sums.instrumentalness += f.instrumentalness;
    sums.liveness += f.liveness;
    sums.speechiness += f.speechiness;
    sums.tempo += f.tempo;
  }
  if (agg.analyzed > 0) {
    const n = agg.analyzed;
    agg.avg_valence = sums.valence / n;
    agg.avg_energy = sums.energy / n;
    agg.avg_danceability = sums.danceability / n;
    agg.avg_acousticness = sums.acousticness / n;
    agg.avg_instrumentalness = sums.instrumentalness / n;
    agg.avg_liveness = sums.liveness / n;
    agg.avg_speechiness = sums.speechiness / n;
    agg.avg_tempo = sums.tempo / n;
  }
  return agg;
}

/// Per-track outliers, keyed by track id: the most-deviating dimension (in std devs)
/// vs the playlist mean. Empty until at least MIN_FOR_OUTLIERS tracks are analyzed.
export function computeOutliers(
  tracks: TrackEntry[],
  feat: FeatureLookup
): Map<string, Outlier> {
  const map = new Map<string, Outlier>();
  const withF = tracks.map((t) => feat(t)).filter((f): f is Features => !!f);
  if (withF.length < MIN_FOR_OUTLIERS) return map;

  const stats: Record<string, { mean: number; std: number }> = {};
  for (const k of FEATURE_KEYS) {
    const vals = withF.map((f) => f[k]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    stats[k] = { mean, std: Math.sqrt(variance) };
  }

  for (const t of tracks) {
    const f = feat(t);
    if (!f) continue;
    let best: Outlier | null = null;
    for (const k of FEATURE_KEYS) {
      const { mean, std } = stats[k];
      const floor = k === "tempo" ? 4 : 0.04; // ignore dimensions with negligible spread
      if (std < floor) continue;
      const z = (f[k] - mean) / std;
      if (!best || Math.abs(z) > Math.abs(best.z)) {
        best = { feature: k, dir: z > 0 ? "up" : "down", z, method: "independent" };
      }
    }
    if (best && Math.abs(best.z) >= OUTLIER_Z) map.set(t.id, best);
  }
  return map;
}

// --- Multivariate (Mahalanobis) outlier detection ---

/// Cholesky factorization A = L·Lᵀ for a symmetric positive-definite matrix.
/// Returns null when A isn't positive-definite (singular/degenerate covariance).
function cholesky(a: number[][]): number[][] | null {
  const n = a.length;
  const l: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i][j];
      for (let k = 0; k < j; k++) sum -= l[i][k] * l[j][k];
      if (i === j) {
        if (sum <= 1e-12) return null;
        l[i][i] = Math.sqrt(sum);
      } else {
        l[i][j] = sum / l[j][j];
      }
    }
  }
  return l;
}

/// Solve (L·Lᵀ)·y = b via forward then back substitution.
function choleskySolve(l: number[][], b: number[]): number[] {
  const n = l.length;
  const w = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= l[i][k] * w[k];
    w[i] = s / l[i][i];
  }
  const y = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = w[i];
    for (let k = i + 1; k < n; k++) s -= l[k][i] * y[k];
    y[i] = s / l[i][i];
  }
  return y;
}

/// Joint-distribution outliers: model the analyzed tracks as a multivariate normal
/// (mean vector + shrunk covariance matrix) and flag tracks whose squared Mahalanobis
/// distance exceeds the chi-square 95% critical value. Unlike the per-metric method,
/// this respects correlations between metrics — a track can be flagged for an unusual
/// *combination* (e.g. high energy AND high acousticness in a playlist where those
/// normally move opposite) even when every individual metric is within 2σ.
///
/// Returns null when there isn't enough data to estimate the joint distribution
/// (fewer than MIN_FOR_MULTI analyzed tracks, or fewer than 2 dimensions with real
/// spread, or a degenerate covariance) — callers should fall back to the independent
/// method in that case.
export function computeOutliersMulti(
  tracks: TrackEntry[],
  feat: FeatureLookup
): Map<string, Outlier> | null {
  const withF = tracks.map((t) => feat(t)).filter((f): f is Features => !!f);
  const n = withF.length;
  if (n < MIN_FOR_MULTI) return null;

  // Keep only dimensions with non-negligible spread (same floors as the independent
  // method) — near-constant dimensions carry no outlier signal and make the covariance
  // numerically singular.
  const active: FeatureKey[] = [];
  const means: number[] = [];
  for (const k of FEATURE_KEYS) {
    const vals = withF.map((f) => f[k]);
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const floor = k === "tempo" ? 4 : 0.04;
    if (Math.sqrt(variance) >= floor) {
      active.push(k);
      means.push(mean);
    }
  }
  const d = active.length;
  if (d < 2) return null; // nothing "joint" to model — independent handles this fine

  // Population covariance of the active dimensions.
  const cov: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const f of withF) {
    for (let i = 0; i < d; i++) {
      const di = f[active[i]] - means[i];
      for (let j = 0; j <= i; j++) {
        cov[i][j] += di * (f[active[j]] - means[j]);
      }
    }
  }
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      cov[i][j] /= n;
      cov[j][i] = cov[i][j];
    }
  }

  // Shrink toward the diagonal: with playlist-sized n the raw covariance is noisy (and
  // possibly ill-conditioned). λ→1 degrades gracefully to the independent method's
  // geometry (a diagonal covariance = sum of squared z-scores). More tracks ⇒ trust the
  // sample correlations more.
  const factorize = (lambda: number): number[][] | null => {
    const s = cov.map((row, i) =>
      row.map((v, j) => (i === j ? v : (1 - lambda) * v))
    );
    return cholesky(s);
  };
  let l = factorize(Math.min(0.9, Math.max(0.05, (d + 1) / n)));
  if (!l) l = factorize(0.95); // nearly-degenerate correlations — fall back to ~diagonal
  if (!l) return null;

  const cutoff = CHI2_95[d] ?? CHI2_95[CHI2_95.length - 1];
  const map = new Map<string, Outlier>();
  for (const t of tracks) {
    const f = feat(t);
    if (!f) continue;
    const dev = active.map((k, i) => f[k] - means[i]);
    const y = choleskySolve(l, dev);
    const d2 = dev.reduce((acc, v, i) => acc + v * y[i], 0);
    if (d2 < cutoff) continue;

    // Decompose D² into per-dimension contributions (devᵢ·(Σ⁻¹dev)ᵢ sums to D²); the
    // meaningfully-positive ones explain the flag.
    const contributors: Contributor[] = active
      // Annotated rather than asserted: inside an object literal the ternary would otherwise
      // widen to `string`, and the `as "up" | "down"` that used to fix that reads as
      // redundant to anything looking at the ternary alone.
      .map((k, i): Contributor => ({
        feature: k,
        dir: dev[i] > 0 ? "up" : "down",
        share: (dev[i] * y[i]) / d2,
      }))
      .filter((c) => c.share > 0.1)
      .sort((a, b) => b.share - a.share)
      .slice(0, 3);
    if (contributors.length === 0) continue; // numerically odd — nothing to explain
    map.set(t.id, {
      feature: contributors[0].feature,
      dir: contributors[0].dir,
      z: Math.sqrt(d2),
      method: "multivariate",
      contributors,
    });
  }
  return map;
}

/// Outliers using the requested mode, with automatic fallback: multivariate needs enough
/// analyzed tracks to estimate a covariance, otherwise the independent method is used.
/// `effective` reports which method actually ran (so the UI can say so).
export function computeOutliersByMode(
  mode: OutlierMode,
  tracks: TrackEntry[],
  feat: FeatureLookup
): { map: Map<string, Outlier>; effective: OutlierMode } {
  if (mode === "multivariate") {
    const multi = computeOutliersMulti(tracks, feat);
    if (multi) return { map: multi, effective: "multivariate" };
  }
  return { map: computeOutliers(tracks, feat), effective: "independent" };
}

// --- Fingerprint goal: an optional per-playlist target for the mood dimensions ---

// The seven 0–1 mood dimensions shown on the bars/radar, in display order. Tempo is excluded
// (it's not on the radar and has a different scale), matching the bars in MetricsPanel.
export const GOAL_DIMS = [
  "valence",
  "energy",
  "danceability",
  "acousticness",
  "instrumentalness",
  "liveness",
  "speechiness",
] as const;
export type GoalDim = (typeof GOAL_DIMS)[number];
export type Goal = Record<GoalDim, number>; // each value 0..1

// A track is "off-goal" on a dimension if it differs from the target by more than this.
export const GOAL_THRESHOLD = 0.2;

export type GoalDeviation = { feature: GoalDim; dir: "up" | "down"; diff: number };

/// Per-track deviations from the goal, keyed by track id: every dimension that's off by more
/// than `threshold`, worst first. Tracks within tolerance (or without features) are absent.
export function computeGoalDeviations(
  tracks: TrackEntry[],
  feat: FeatureLookup,
  goal: Goal,
  threshold = GOAL_THRESHOLD
): Map<string, GoalDeviation[]> {
  const map = new Map<string, GoalDeviation[]>();
  for (const t of tracks) {
    const f = feat(t);
    if (!f) continue;
    const offs: GoalDeviation[] = [];
    for (const k of GOAL_DIMS) {
      const diff = f[k] - goal[k];
      if (Math.abs(diff) >= threshold) {
        offs.push({ feature: k, dir: diff > 0 ? "up" : "down", diff });
      }
    }
    if (offs.length) {
      offs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      map.set(t.id, offs);
    }
  }
  return map;
}

// --- PCA: 2D projection of playlists for the similarity map ---

// A playlist needs at least this many analyzed tracks before its mean vector is a stable
// enough fingerprint to place on the map; below it the average is noise.
export const PCA_MIN_ANALYZED = 5;

/// A playlist's mean feature vector in FEATURE_KEYS order, or null if nothing was analyzed
/// (or, defensively, if any dimension is missing). Built from the same aggregates the radar uses.
export function playlistVector(agg: Aggregates): number[] | null {
  if (agg.analyzed === 0) return null;
  const v = [
    agg.avg_valence,
    agg.avg_energy,
    agg.avg_danceability,
    agg.avg_acousticness,
    agg.avg_instrumentalness,
    agg.avg_speechiness,
    agg.avg_liveness,
    agg.avg_tempo,
  ];
  return v.every((x) => x != null) ? v : null;
}

/// One feature's contribution to a principal axis (the standardized-space loading). The view
/// turns the top few into a human axis label like "energy ↑ · acousticness ↓".
export type AxisLoading = { feature: string; weight: number };

/// A fitted PCA projection that can be frozen and reused: it carries everything needed to map
/// any playlist's mean-vector to the same 2D spot, so the map only re-lays-out when the user
/// explicitly re-fits it (see `fitPca` / `projectPca`).
export type PcaBasis = {
  /// Indices into FEATURE_KEYS for the dimensions kept (those with variance at fit time).
  kept: number[];
  /// Z-score standardization params for the kept dimensions, aligned to `kept`.
  means: number[];
  stds: number[];
  /// The two principal axes (loadings over the kept dimensions), sign-canonicalized.
  v1: number[];
  v2: number[];
  /// Share of total variance the two axes capture (0..1) — how faithful the 2D map is.
  varExplained: number;
  /// Per-axis feature loadings, sorted by |weight| desc, for labelling the axes.
  axes: { pc1: AxisLoading[]; pc2: AxisLoading[] };
  /// Fixed per-axis canvas-normalization bounds (robust 8th–92nd percentile of the fit set's
  /// projected coords). Frozen here so re-projecting an edited or brand-new playlist maps
  /// through the same scale instead of rescaling the whole map.
  norm: { x: { lo: number; span: number }; y: { lo: number; span: number } };
};

/// Eigenvalues + eigenvectors of a small symmetric matrix via cyclic Jacobi rotations.
/// `vectors[i][k]` is component i of eigenvector k (columns are eigenvectors).
function jacobiEigen(input: number[][]): { values: number[]; vectors: number[][] } {
  const n = input.length;
  const a = input.map((r) => r.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-20) continue;
        // Rotation angle that zeroes a[p][q]: tan(2θ) = 2·a_pq / (a_qq − a_pp).
        const phi = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        // Two-sided rotation A ← Jᵀ A J: right-multiply (columns) then left-multiply (rows).
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
}

/// Quantile of an already-sorted array (linear interpolation between neighbours).
function sortedQuantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/// Robust per-axis bounds (8th–92nd percentile) so a couple of outliers can't squash the bulk
/// of the map into a blob.
function axisBounds(vals: number[]): { lo: number; span: number } {
  const s = [...vals].sort((a, b) => a - b);
  const lo = sortedQuantile(s, 0.08);
  const hi = sortedQuantile(s, 0.92);
  return { lo, span: Math.max(hi - lo, 1e-6) };
}

/// Fit a 2D PCA projection from playlist mean-vectors (each in FEATURE_KEYS order). Standardizes
/// every feature first (z-score across playlists) so disparate scales — tempo's BPM vs the
/// 0–1 moods — contribute comparably; that's what makes on-screen distance read as "how
/// different these playlists are". Returns null when there isn't enough to form a 2D spread
/// (< 3 playlists, or < 2 features with any variance). The returned basis can be frozen and
/// fed to `projectPca`, so editing a playlist moves only that point rather than re-fitting.
export function fitPca(rows: number[][]): PcaBasis | null {
  const m = rows.length;
  if (m < 3) return null;
  const dimAll = FEATURE_KEYS.length;

  const meansAll: number[] = [];
  const stdsAll: number[] = [];
  for (let j = 0; j < dimAll; j++) {
    const col = rows.map((r) => r[j]);
    const mean = col.reduce((a, b) => a + b, 0) / m;
    const variance = col.reduce((a, b) => a + (b - mean) ** 2, 0) / m;
    meansAll.push(mean);
    stdsAll.push(Math.sqrt(variance));
  }
  // Drop features that are identical across every playlist — they carry no separating signal
  // and would divide-by-zero on standardization.
  const kept: number[] = [];
  for (let j = 0; j < dimAll; j++) if (stdsAll[j] > 1e-9) kept.push(j);
  const d = kept.length;
  if (d < 2) return null;

  const means = kept.map((j) => meansAll[j]);
  const stds = kept.map((j) => stdsAll[j]);
  const z = rows.map((r) => kept.map((j, i) => (r[j] - means[i]) / stds[i]));

  // Sample covariance (÷ m−1) of the standardized columns.
  const denom = m - 1;
  const cov: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const row of z) {
    for (let i = 0; i < d; i++) for (let j = 0; j <= i; j++) cov[i][j] += row[i] * row[j];
  }
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      cov[i][j] /= denom;
      cov[j][i] = cov[i][j];
    }
  }

  const { values, vectors } = jacobiEigen(cov);
  const order = values.map((_, i) => i).sort((a, b) => values[b] - values[a]);
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  const [i1, i2] = [order[0], order[1]];
  // An eigenvector's sign is mathematically arbitrary, so a tiny data change can flip a whole
  // axis and mirror the map even though nothing really moved. Pin each axis's sign to a fixed
  // convention — its largest-magnitude loading points positive — so the orientation stays put
  // across edits (the same trick scikit-learn's `svd_flip` uses).
  const orient = (v: number[]): number[] => {
    let dom = 0;
    for (let i = 1; i < v.length; i++) if (Math.abs(v[i]) > Math.abs(v[dom])) dom = i;
    return v[dom] < 0 ? v.map((x) => -x) : v;
  };
  const v1 = orient(vectors.map((row) => row[i1]));
  const v2 = orient(vectors.map((row) => row[i2]));

  const varExplained =
    total > 0 ? (Math.max(0, values[i1]) + Math.max(0, values[i2])) / total : 0;

  const loadings = (vec: number[]): AxisLoading[] =>
    kept
      .map((j, i) => ({ feature: FEATURE_KEYS[j], weight: vec[i] }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  // Project the fit set once to fix the canvas-normalization bounds for the frozen map.
  const xs = z.map((row) => row.reduce((acc, zi, i) => acc + zi * v1[i], 0));
  const ys = z.map((row) => row.reduce((acc, zi, i) => acc + zi * v2[i], 0));

  return {
    kept,
    means,
    stds,
    v1,
    v2,
    varExplained,
    axes: { pc1: loadings(v1), pc2: loadings(v2) },
    norm: { x: axisBounds(xs), y: axisBounds(ys) },
  };
}

/// Project one playlist mean-vector (FEATURE_KEYS order) through a fitted basis into normalized
/// [0,1]² map space (with the same small overshoot the fit allows for outliers). Because the
/// basis and bounds are fixed, an edited or brand-new playlist moves only itself.
export function projectPca(basis: PcaBasis, row: number[]): { x: number; y: number } {
  const z = basis.kept.map((j, i) => (row[j] - basis.means[i]) / basis.stds[i]);
  const px = z.reduce((acc, zi, i) => acc + zi * basis.v1[i], 0);
  const py = z.reduce((acc, zi, i) => acc + zi * basis.v2[i], 0);
  const norm = (v: number, b: { lo: number; span: number }) =>
    Math.max(-0.06, Math.min(1.06, (v - b.lo) / b.span));
  return { x: norm(px, basis.norm.x), y: norm(py, basis.norm.y) };
}
