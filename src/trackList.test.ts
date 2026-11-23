import { describe, expect, it } from "vitest";
import type { Features, TrackEntry } from "./api";
import {
  appendMissing,
  removeAtIndices,
  sameTracks,
  sortTracks,
  toggleSelection,
} from "./trackList";

// A sort here can be applied to the playlist, so these are no longer only about what the
// screen shows — getting one wrong reorders someone's real playlist on the next push. The
// cases that matter most are the ones where a value is missing, because that's where an
// order could silently come out arbitrary.

function t(id: string, over: Partial<TrackEntry> = {}): TrackEntry {
  return {
    id: `spotify:track:${id}`,
    isrc: null,
    title: id,
    artists: ["A"],
    added_at: null,
    added_by: null,
    duration_ms: 1000,
    is_playable: true,
    ...over,
  };
}

function features(over: Partial<Features> = {}): Features {
  return {
    acousticness: 0.5,
    danceability: 0.5,
    energy: 0.5,
    instrumentalness: 0.5,
    liveness: 0.5,
    loudness: -8,
    speechiness: 0.5,
    tempo: 120,
    valence: 0.5,
    key: 0,
    mode: 1,
    ...over,
  };
}

/** Resolve features from a map keyed by the short id used in `t`. */
function lookup(map: Record<string, Features>) {
  return (track: TrackEntry) => map[track.title];
}

const none = () => undefined;

describe("sortTracks", () => {
  it("leaves the official order untouched and keeps every track's position", () => {
    const tracks = [t("c"), t("a"), t("b")];
    expect(sortTracks(tracks, "index", "asc", none)).toEqual([
      { t: tracks[0], i: 0 },
      { t: tracks[1], i: 1 },
      { t: tracks[2], i: 2 },
    ]);
  });

  it("carries each track's original position through a sort, so a row still edits the right one", () => {
    const sorted = sortTracks([t("c"), t("a"), t("b")], "title", "asc", none);
    expect(sorted.map((x) => x.t.title)).toEqual(["a", "b", "c"]);
    expect(sorted.map((x) => x.i)).toEqual([1, 2, 0]);
  });

  it("sorts titles case-insensitively", () => {
    const sorted = sortTracks([t("beta"), t("Alpha"), t("alpha2")], "title", "asc", none);
    expect(sorted.map((x) => x.t.title)).toEqual(["Alpha", "alpha2", "beta"]);
  });

  it("reverses on descending", () => {
    const sorted = sortTracks([t("a"), t("c"), t("b")], "title", "desc", none);
    expect(sorted.map((x) => x.t.title)).toEqual(["c", "b", "a"]);
  });

  it("treats a missing duration as zero rather than dropping the track", () => {
    const sorted = sortTracks(
      [t("long", { duration_ms: 9000 }), t("none", { duration_ms: null }), t("short", { duration_ms: 50 })],
      "duration",
      "asc",
      none
    );
    expect(sorted.map((x) => x.t.title)).toEqual(["none", "short", "long"]);
  });

  it("sinks unanalyzed tracks to the bottom whichever way a feature sort runs", () => {
    const feat = lookup({ hi: features({ energy: 0.9 }), lo: features({ energy: 0.1 }) });
    const tracks = [t("hi"), t("unknown"), t("lo")];

    expect(sortTracks(tracks, "energy", "asc", feat).map((x) => x.t.title)).toEqual([
      "lo",
      "hi",
      "unknown",
    ]);
    // Descending flips the two we know about and leaves the unknown at the bottom — it is
    // absent from the ranking, not at the far end of it.
    expect(sortTracks(tracks, "energy", "desc", feat).map((x) => x.t.title)).toEqual([
      "hi",
      "lo",
      "unknown",
    ]);
  });

  it("leaves a playlist alone when nothing has been analyzed", () => {
    const tracks = [t("c"), t("a"), t("b")];
    expect(sortTracks(tracks, "valence", "asc", none).map((x) => x.t.title)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("keeps playlist order among tracks that tie", () => {
    const feat = lookup({
      first: features({ tempo: 100 }),
      second: features({ tempo: 100 }),
      third: features({ tempo: 100 }),
    });
    const sorted = sortTracks([t("first"), t("second"), t("third")], "tempo", "asc", feat);
    expect(sorted.map((x) => x.t.title)).toEqual(["first", "second", "third"]);
  });

  it("does not mutate the list it was given", () => {
    const tracks = [t("c"), t("a")];
    sortTracks(tracks, "title", "asc", none);
    expect(tracks.map((x) => x.title)).toEqual(["c", "a"]);
  });
});

describe("toggleSelection", () => {
  // The playlist's own order, which is what `displayed` looks like when nothing is sorted.
  const plain = [0, 1, 2, 3, 4];

  it("selects a single row, and deselects it again", () => {
    const one = toggleSelection(new Set(), plain, 2, false, null);
    expect([...one]).toEqual([2]);
    expect([...toggleSelection(one, plain, 2, false, null)]).toEqual([]);
  });

  it("adds rows one at a time rather than replacing the selection", () => {
    let sel = toggleSelection(new Set(), plain, 1, false, null);
    sel = toggleSelection(sel, plain, 3, false, null);
    expect([...sel].sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it("shift-clicking takes the whole run back to the anchor", () => {
    const sel = toggleSelection(new Set([1]), plain, 4, true, 1);
    expect([...sel].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("shift-clicks the same run backwards", () => {
    const sel = toggleSelection(new Set([4]), plain, 1, true, 4);
    expect([...sel].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("clears a whole run when the shift-clicked row was already selected", () => {
    // Not an invert-each-row: the clicked row's new state wins for the entire range, so a
    // partly-selected run is cleared rather than inverted into a different partial mess.
    const sel = toggleSelection(new Set([1, 2, 3, 4]), plain, 4, true, 1);
    expect([...sel]).toEqual([]);

    const partial = toggleSelection(new Set([1, 3, 4]), plain, 4, true, 1);
    expect([...partial]).toEqual([]);
  });

  it("takes the rows on screen, not the rows next to each other in the file", () => {
    // A playlist sorted by some feature: the rows shown are draft indices 4, 0, 2, 1, 3.
    const sorted = [4, 0, 2, 1, 3];
    const sel = toggleSelection(new Set(), sorted, 1, false, null);
    expect([...sel]).toEqual([0]);

    // Shift from screen position 1 to 3 picks up what the eye sees: 0, 2, 1.
    const run = toggleSelection(sel, sorted, 3, true, 1);
    expect([...run].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("treats a shift-click with no anchor as an ordinary one", () => {
    expect([...toggleSelection(new Set(), plain, 3, true, null)]).toEqual([3]);
  });

  it("ignores an anchor left behind by a longer list", () => {
    // Re-sorting or removing rows can strand the anchor past the end; a stale anchor must
    // not reach for rows that are no longer there.
    expect([...toggleSelection(new Set(), [0, 1], 1, true, 9)]).toEqual([1]);
  });

  it("ignores a click past the end of the list", () => {
    expect([...toggleSelection(new Set([1]), plain, 99, false, null)]).toEqual([1]);
  });

  it("does not mutate the set it was given", () => {
    const before = new Set([1]);
    toggleSelection(before, plain, 2, false, null);
    expect([...before]).toEqual([1]);
  });
});

describe("sameTracks", () => {
  it("sees an unchanged list through a copy", () => {
    // What a staged write needs to know: `appendMissing` and friends return a fresh array
    // even when they changed nothing, so reference equality would report a change every time.
    const tracks = [t("a"), t("b")];
    expect(sameTracks(tracks, [...tracks])).toBe(true);
    expect(sameTracks(tracks, tracks)).toBe(true);
  });

  it("notices a reorder, an addition and a removal", () => {
    const tracks = [t("a"), t("b")];
    expect(sameTracks(tracks, [t("b"), t("a")])).toBe(false);
    expect(sameTracks(tracks, [t("a"), t("b"), t("c")])).toBe(false);
    expect(sameTracks(tracks, [t("a")])).toBe(false);
  });

  it("notices a track swapped for a different release of the same song", () => {
    // What the cross-playlist duplicate fix does: same song, different uri.
    expect(sameTracks([t("a")], [t("a2")])).toBe(false);
  });

  it("ignores when and by whom a track was added", () => {
    const before = [t("a", { added_at: "2020-01-01T00:00:00Z", added_by: "someone" })];
    expect(sameTracks(before, [t("a")])).toBe(true);
  });

  it("treats two empty lists as the same", () => {
    expect(sameTracks([], [])).toBe(true);
  });
});

describe("removeAtIndices", () => {
  it("removes every selected row in one pass", () => {
    const tracks = [t("a"), t("b"), t("c"), t("d")];
    // Done one at a time this would renumber after the first removal and take "d" instead.
    const left = removeAtIndices(tracks, new Set([1, 2]));
    expect(left.map((x) => x.title)).toEqual(["a", "d"]);
  });

  it("removes one copy of a duplicated track and keeps the other", () => {
    const tracks = [t("a"), t("dup"), t("b"), t("dup")];
    const left = removeAtIndices(tracks, new Set([3]));
    expect(left.map((x) => x.title)).toEqual(["a", "dup", "b"]);
  });

  it("leaves the list alone when nothing is selected", () => {
    const tracks = [t("a"), t("b")];
    expect(removeAtIndices(tracks, new Set())).toEqual(tracks);
  });

  it("ignores an index that isn't in the list", () => {
    const tracks = [t("a"), t("b")];
    expect(removeAtIndices(tracks, new Set([7])).map((x) => x.title)).toEqual(["a", "b"]);
  });

  it("does not mutate the list it was given", () => {
    const tracks = [t("a"), t("b")];
    removeAtIndices(tracks, new Set([0]));
    expect(tracks).toHaveLength(2);
  });
});

describe("appendMissing", () => {
  it("appends the tracks that are new and counts the ones already there", () => {
    const result = appendMissing([t("a"), t("b")], [t("b"), t("c")]);
    expect(result.tracks.map((x) => x.title)).toEqual(["a", "b", "c"]);
    expect(result.added.map((x) => x.title)).toEqual(["c"]);
    expect(result.skipped).toBe(1);
  });

  it("adds a repeated incoming track once", () => {
    const result = appendMissing([], [t("a"), t("a")]);
    expect(result.tracks.map((x) => x.title)).toEqual(["a"]);
    expect(result.skipped).toBe(1);
  });

  it("clears added_at and added_by, which belong to where the track came from", () => {
    const result = appendMissing(
      [],
      [t("a", { added_at: "2020-01-01T00:00:00Z", added_by: "someone" })]
    );
    expect(result.added[0].added_at).toBeNull();
    expect(result.added[0].added_by).toBeNull();
  });

  it("matches a track already present under a different uri form", () => {
    // Playlist files store the full uri, but identity is the bare id — the same recording
    // arriving as a bare id must not be appended a second time.
    const result = appendMissing([t("a")], [{ ...t("a"), id: "a" }]);
    expect(result.added).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("keeps a local file distinct from a track whose id happens to match its tail", () => {
    // `bareId` deliberately leaves a spotify:local: uri whole, so these are two songs.
    const result = appendMissing([t("x")], [{ ...t("x"), id: "spotify:local:::x" }]);
    expect(result.added).toHaveLength(1);
    expect(result.skipped).toBe(0);
  });

  it("leaves the list it was given alone", () => {
    const into = [t("a")];
    appendMissing(into, [t("b")]);
    expect(into).toHaveLength(1);
  });
});
