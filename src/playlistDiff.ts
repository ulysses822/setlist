// Diff between a playlist's canonical (Spotify-mirror) track list and the current draft —
// the basis for the inline "Show changes" review before pushing. Matches tracks by bare
// Spotify id and uses a longest-common-subsequence so a single reorder marks only the song
// that actually moved (not everything after it). Removed songs are woven back in at their
// original position so they can be shown struck-through, still "in" the list.

import type { TrackEntry } from "./api";
import { bareId } from "./metricsCalc";

export type DiffStatus = "unchanged" | "added" | "removed" | "moved";

export interface DiffRow {
  track: TrackEntry;
  status: DiffStatus;
  position: number | null; // final 1-based position for present tracks; null for removed
  key: string;
}

export interface PlaylistDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  moved: number;
  changed: boolean;
}

// LCS over two id sequences, returned as the matched (baselineIndex, draftIndex) pairs in
// increasing order. Standard O(n·m) DP — fine for realistic playlist sizes.
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

// Cheap fallback for pathologically large playlists: skip move detection (no LCS), just mark
// added (draft ids absent from the baseline multiset) and append removed at the end.
function simpleDiff(baseline: TrackEntry[], draft: TrackEntry[]): PlaylistDiff {
  const baseCount = new Map<string, number>();
  for (const t of baseline) baseCount.set(bareId(t.id), (baseCount.get(bareId(t.id)) ?? 0) + 1);
  const draftCount = new Map<string, number>();
  for (const t of draft) draftCount.set(bareId(t.id), (draftCount.get(bareId(t.id)) ?? 0) + 1);

  const rows: DiffRow[] = [];
  let added = 0;
  const seen = new Map<string, number>();
  draft.forEach((t, idx) => {
    const id = bareId(t.id);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    const isAdded = n > (baseCount.get(id) ?? 0);
    if (isAdded) added++;
    rows.push({
      track: t,
      status: isAdded ? "added" : "unchanged",
      position: idx + 1,
      key: `${isAdded ? "add" : "eq"}-${idx}-${id}`,
    });
  });
  let removed = 0;
  baseline.forEach((t, idx) => {
    const id = bareId(t.id);
    const surplus = (baseCount.get(id) ?? 0) - (draftCount.get(id) ?? 0);
    if (surplus > 0) {
      // Emit the first `surplus` occurrences as removed.
      const already = rows.filter((r) => r.status === "removed" && bareId(r.track.id) === id).length;
      if (already < surplus) {
        removed++;
        rows.push({ track: t, status: "removed", position: null, key: `rm-${idx}-${id}` });
      }
    }
  });
  return { rows, added, removed, moved: 0, changed: added + removed > 0 };
}

/**
 * Compute the inline diff. `baseline` is the canonical (last-synced) order; `draft` is the
 * current edited order.
 */
export function diffTracks(baseline: TrackEntry[], draft: TrackEntry[]): PlaylistDiff {
  if (baseline.length * draft.length > 2_000_000) {
    return simpleDiff(baseline, draft);
  }

  const baseIds = baseline.map((t) => bareId(t.id));
  const draftIds = draft.map((t) => bareId(t.id));
  const lcs = lcsPairs(baseIds, draftIds);

  const matchedBaseline = new Set<number>();
  const matchedDraft = new Set<number>();
  for (const [bi, dj] of lcs) {
    matchedBaseline.add(bi);
    matchedDraft.add(dj);
  }

  // Unmatched baseline indices, queued by id, so unmatched draft items can claim one as the
  // "moved" counterpart (id-matched in order). Whatever's left is genuinely removed.
  const freeBaselineById = new Map<string, number[]>();
  for (let i = 0; i < baseline.length; i++) {
    if (matchedBaseline.has(i)) continue;
    const id = baseIds[i];
    (freeBaselineById.get(id) ?? freeBaselineById.set(id, []).get(id)!).push(i);
  }

  // Classify each draft item; consuming a baseline counterpart marks that baseline index as
  // "moved away" (so it isn't also rendered as removed).
  const draftStatus = new Array<DiffStatus>(draft.length);
  const movedAwayBaseline = new Set<number>();
  let added = 0;
  let moved = 0;
  for (let j = 0; j < draft.length; j++) {
    if (matchedDraft.has(j)) {
      draftStatus[j] = "unchanged";
      continue;
    }
    const queue = freeBaselineById.get(draftIds[j]);
    if (queue && queue.length > 0) {
      const bi = queue.shift()!;
      movedAwayBaseline.add(bi);
      draftStatus[j] = "moved";
      moved++;
    } else {
      draftStatus[j] = "added";
      added++;
    }
  }

  // Baseline items neither matched nor moved-away are removed.
  const removedBaseline = new Set<number>();
  for (let i = 0; i < baseline.length; i++) {
    if (!matchedBaseline.has(i) && !movedAwayBaseline.has(i)) removedBaseline.add(i);
  }

  // Weave the merged list: for each gap between LCS anchors, emit removed rows (anchored to
  // their original spot) then the draft-only rows (added/moved), then the anchor itself.
  const rows: DiffRow[] = [];
  const anchors: Array<[number, number]> = [...lcs, [baseline.length, draft.length]];
  let bi = 0;
  let dj = 0;
  for (const [abi, adj] of anchors) {
    for (let k = bi; k < abi; k++) {
      if (removedBaseline.has(k)) {
        rows.push({ track: baseline[k], status: "removed", position: null, key: `rm-${k}-${baseIds[k]}` });
      }
    }
    for (let k = dj; k < adj; k++) {
      const st = draftStatus[k];
      rows.push({ track: draft[k], status: st, position: k + 1, key: `${st}-${k}-${draftIds[k]}` });
    }
    if (abi < baseline.length) {
      rows.push({ track: draft[adj], status: "unchanged", position: adj + 1, key: `eq-${adj}-${draftIds[adj]}` });
      bi = abi + 1;
      dj = adj + 1;
    }
  }

  const removed = removedBaseline.size;
  return { rows, added, removed, moved, changed: added + removed + moved > 0 };
}
