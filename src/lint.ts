// Playlist "doctor" checks — local, no network. Two cleanliness checks for v1:
//   • exact duplicates  — the same track id appearing more than once in a playlist
//   • ISRC duplicates   — the same recording added via different releases (remaster /
//                         re-upload), i.e. same ISRC but different track ids
// Pure functions over a track list so the per-playlist chip (live on the draft) and the
// library-wide scan share one source of truth.
//
// One identity rule for the whole file: two entries are the same track when their `bareId`
// matches. Nothing here keys on the full `spotify:track:…` uri. They agree today — stored ids
// always come back from the API in the same form — so mixing them broke nothing and would
// have gone on not breaking anything right up until it silently did.

import type { TrackEntry } from "./api";
import { bareId } from "./metricsCalc";

export interface DupGroup {
  key: string; // the shared track id (exact) or ISRC (near-dup)
  occurrences: { track: TrackEntry; index: number }[];
}

export interface UnavailableTrack {
  track: TrackEntry;
  index: number; // position in the linted track list (so it can be replaced in place)
}

export interface PlaylistLint {
  exact: DupGroup[]; // groups of identical-id tracks (≥2 occurrences)
  isrc: DupGroup[]; // groups sharing an ISRC across ≥2 distinct ids
  unavailable: UnavailableTrack[]; // greyed-out tracks (is_playable === false)
  redundant: number; // suggested removals: extra copies + extra releases
}

export function lintPlaylist(tracks: TrackEntry[]): PlaylistLint {
  // Exact duplicates: group every occurrence by bare id; flag groups with more than one.
  const byId = new Map<string, { track: TrackEntry; index: number }[]>();
  tracks.forEach((track, index) => {
    const id = bareId(track.id);
    const list = byId.get(id);
    if (list) list.push({ track, index });
    else byId.set(id, [{ track, index }]);
  });
  const exact: DupGroup[] = [];
  for (const [key, occ] of byId) {
    if (occ.length > 1) exact.push({ key, occurrences: occ });
  }

  // ISRC near-duplicates: group by ISRC, then keep only groups spanning ≥2 distinct ids
  // (same-id repeats are already covered by the exact check). One representative occurrence
  // per distinct id, so the resolver lists each release once.
  const byIsrc = new Map<string, { track: TrackEntry; index: number }[]>();
  tracks.forEach((track, index) => {
    const code = track.isrc?.trim();
    if (!code) return;
    const list = byIsrc.get(code);
    if (list) list.push({ track, index });
    else byIsrc.set(code, [{ track, index }]);
  });
  const isrc: DupGroup[] = [];
  for (const [key, occ] of byIsrc) {
    const seen = new Set<string>();
    const reps: { track: TrackEntry; index: number }[] = [];
    for (const o of occ) {
      const id = bareId(o.track.id);
      if (seen.has(id)) continue;
      seen.add(id);
      reps.push(o);
    }
    if (reps.length > 1) isrc.push({ key, occurrences: reps });
  }

  // Unavailable (greyed-out) tracks — flagged from is_playable, populated on pull/refresh.
  const unavailable: UnavailableTrack[] = [];
  tracks.forEach((track, index) => {
    if (track.is_playable === false) unavailable.push({ track, index });
  });

  const redundant =
    exact.reduce((n, g) => n + g.occurrences.length - 1, 0) +
    isrc.reduce((n, g) => n + g.occurrences.length - 1, 0);

  return { exact, isrc, unavailable, redundant };
}

/**
 * Total number of issue *groups* (used for badge counts where one group = one thing to look
 * at, regardless of how many copies).
 */
export function issueCount(lint: PlaylistLint): number {
  return lint.exact.length + lint.isrc.length + lint.unavailable.length;
}

// --- cross-playlist near-duplicates ---
// The same recording (ISRC) present under different track ids anywhere in the library —
// e.g. "Hey Jude - Remastered 2015" added from two different albums. Worth normalizing to a
// single id even though the variants live in separate playlists.

export interface CrossVariant {
  id: string; // bare track id, per the identity rule at the top of this file
  track: TrackEntry; // a representative entry, used when normalizing
  locations: { file: string; name: string; count: number }[];
}

export interface CrossDupGroup {
  isrc: string;
  title: string;
  artists: string[];
  variants: CrossVariant[]; // ≥2 distinct ids
}

export function crossPlaylistIsrcDuplicates(
  playlists: { file: string; name: string; tracks: TrackEntry[] }[]
): CrossDupGroup[] {
  // isrc -> (bare track id -> variant accumulator)
  const byIsrc = new Map<
    string,
    Map<string, { track: TrackEntry; locations: Map<string, { name: string; count: number }> }>
  >();
  for (const pl of playlists) {
    for (const t of pl.tracks) {
      const code = t.isrc?.trim();
      if (!code) continue;
      let variants = byIsrc.get(code);
      if (!variants) {
        variants = new Map();
        byIsrc.set(code, variants);
      }
      // Keyed bare, but the representative keeps the entry whole: normalizing rewrites the
      // other variants to this track, and that needs its real uri.
      const id = bareId(t.id);
      let v = variants.get(id);
      if (!v) {
        v = { track: t, locations: new Map() };
        variants.set(id, v);
      }
      const loc = v.locations.get(pl.file);
      if (loc) loc.count++;
      else v.locations.set(pl.file, { name: pl.name, count: 1 });
    }
  }

  const out: CrossDupGroup[] = [];
  for (const [isrc, variants] of byIsrc) {
    if (variants.size < 2) continue; // only the same recording under ≥2 different ids
    const variantList: CrossVariant[] = [...variants.entries()].map(([id, v]) => ({
      id,
      track: v.track,
      locations: [...v.locations.entries()].map(([file, x]) => ({
        file,
        name: x.name,
        count: x.count,
      })),
    }));
    // Most-used variant first (keeping it means the fewest replacements).
    variantList.sort(
      (a, b) =>
        b.locations.reduce((n, l) => n + l.count, 0) - a.locations.reduce((n, l) => n + l.count, 0)
    );
    const first = variantList[0].track;
    out.push({ isrc, title: first.title, artists: first.artists, variants: variantList });
  }
  out.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  return out;
}

/** Drop every duplicate occurrence of a track id, keeping the first. Returns a new array. */
export function removeExactDuplicates(tracks: TrackEntry[]): TrackEntry[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    const id = bareId(t.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Remove every track whose bare id is in `ids`. Used to resolve an ISRC group down to the
 * one release you want to keep.
 */
export function removeTracksByIds(tracks: TrackEntry[], ids: Set<string>): TrackEntry[] {
  return tracks.filter((t) => !ids.has(bareId(t.id)));
}
