import { describe, expect, it } from "vitest";
import type { Features, TrackEntry } from "./api";
import { appendMissing, sortTracks } from "./trackList";

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
