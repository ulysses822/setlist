// Pure operations on a track list: how the editor orders one for display, and how it takes
// tracks in from somewhere else. Both were inline in `Library`, and both became worth testing
// once an edit could be built from them — a sort you can apply writes the playlist, so its
// comparator is no longer only a view concern.
//
// `appendMissing` follows the same identity rule as lint.ts: two entries are the same track
// when their `bareId` matches, never the full `spotify:track:…` uri.

import type { Features, TrackEntry } from "./api";
import { bareId, type FeatureKey } from "./metricsCalc";

/** The official order ("index"), title, duration, or any audio-feature column. */
export type SortKey = "index" | "title" | "duration" | FeatureKey;
export type SortDir = "asc" | "desc";

/**
 * A track with its position in the playlist. Sorting keeps the two together because the
 * position is what the row edits against and what the "#" column shows — so a sorted view
 * can still remove the right track.
 */
export interface PositionedTrack {
  t: TrackEntry;
  i: number;
}

/**
 * Order a track list for display. `featureOf` resolves a track's audio features, which only
 * the caller's cache knows about.
 *
 * Ties keep playlist order, because `Array.prototype.sort` is stable: sorting a playlist by a
 * feature every track shares — or by one nothing has been analyzed for — leaves it alone
 * rather than shuffling it. That matters now the result can be applied.
 */
export function sortTracks(
  tracks: TrackEntry[],
  key: SortKey,
  dir: SortDir,
  featureOf: (t: TrackEntry) => Features | undefined
): PositionedTrack[] {
  const arr: PositionedTrack[] = tracks.map((t, i) => ({ t, i }));
  if (key === "index") return arr;
  const sign = dir === "asc" ? 1 : -1;
  if (key === "title") {
    return [...arr].sort(
      (a, b) => sign * a.t.title.localeCompare(b.t.title, undefined, { sensitivity: "base" })
    );
  }
  if (key === "duration") {
    return [...arr].sort((a, b) => sign * ((a.t.duration_ms ?? 0) - (b.t.duration_ms ?? 0)));
  }
  // Audio-feature sort. Tracks not yet analyzed (no feature value) always sink to the
  // bottom, regardless of direction, so the sorted block is the songs we actually know.
  const valueOf = (t: TrackEntry): number | null => {
    const f = featureOf(t);
    return f ? f[key] : null;
  };
  return [...arr].sort((a, b) => {
    const av = valueOf(a.t);
    const bv = valueOf(b.t);
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    return sign * (av - bv);
  });
}

/** What `appendMissing` added, and what it left out because the track was already there. */
export interface AppendResult {
  /** The combined list — `into` with the new entries after it. */
  tracks: TrackEntry[];
  /** Just the appended entries: what a status line counts and what needs audio features. */
  added: TrackEntry[];
  /** How many incoming entries were already present. */
  skipped: number;
}

/**
 * Append `incoming` to `into`, skipping any track already in the list — and any repeat
 * within `incoming` itself, so adding an album that lists the same recording twice doesn't
 * create a duplicate the cleanup doctor then has to report.
 *
 * The appended entries lose `added_at` / `added_by`: Spotify stamps those when the push
 * actually adds the track, and carrying another playlist's values over would date the
 * addition to the day someone else made it.
 */
export function appendMissing(into: TrackEntry[], incoming: TrackEntry[]): AppendResult {
  const have = new Set(into.map((t) => bareId(t.id)));
  const added: TrackEntry[] = [];
  let skipped = 0;
  for (const t of incoming) {
    const id = bareId(t.id);
    if (have.has(id)) {
      skipped++;
      continue;
    }
    have.add(id);
    added.push({ ...t, added_at: null, added_by: null });
  }
  return { tracks: [...into, ...added], added, skipped };
}
