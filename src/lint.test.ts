import { describe, expect, it } from "vitest";
import type { TrackEntry } from "./api";
import {
  crossPlaylistIsrcDuplicates,
  issueCount,
  lintPlaylist,
  removeExactDuplicates,
  removeTracksByIds,
} from "./lint";

// The cleanup doctor proposes removals from real playlists. A false positive here deletes
// something the user meant to keep, so the interesting cases are the ones it must NOT flag.

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

describe("lintPlaylist", () => {
  it("finds nothing wrong with a clean playlist", () => {
    const lint = lintPlaylist([t("a"), t("b"), t("c")]);
    expect(lint.exact).toEqual([]);
    expect(lint.isrc).toEqual([]);
    expect(lint.unavailable).toEqual([]);
    expect(lint.redundant).toBe(0);
    expect(issueCount(lint)).toBe(0);
  });

  it("groups exact duplicates with every position they sit at", () => {
    const lint = lintPlaylist([t("a"), t("b"), t("a"), t("a")]);
    expect(lint.exact).toHaveLength(1);
    expect(lint.exact[0].occurrences.map((o) => o.index)).toEqual([0, 2, 3]);
    // Three copies means two suggested removals, not three.
    expect(lint.redundant).toBe(2);
  });

  it("flags one recording added under two ids, but not the same id twice", () => {
    // The ISRC check is for the remaster/re-upload case: same recording, different releases.
    // A repeat of one id is already the exact check's job, and counting it twice would
    // double-report a single problem.
    const sameRecording = lintPlaylist([
      t("a", { isrc: "GBAAA0000001" }),
      t("b", { isrc: "GBAAA0000001" }),
    ]);
    expect(sameRecording.isrc).toHaveLength(1);
    expect(sameRecording.isrc[0].occurrences.map((o) => o.track.title)).toEqual(["a", "b"]);

    const sameIdTwice = lintPlaylist([
      t("a", { isrc: "GBAAA0000001" }),
      t("a", { isrc: "GBAAA0000001" }),
    ]);
    expect(sameIdTwice.isrc).toEqual([]);
    expect(sameIdTwice.exact).toHaveLength(1);
  });

  it("ignores a missing or blank ISRC instead of grouping on it", () => {
    // Tracks with no ISRC are common. Treating absent-or-empty as a shared key would group
    // every unanalyzed track in the library into one giant false duplicate.
    const lint = lintPlaylist([
      t("a", { isrc: null }),
      t("b", { isrc: null }),
      t("c", { isrc: "   " }),
      t("d", { isrc: "" }),
    ]);
    expect(lint.isrc).toEqual([]);
    expect(lint.redundant).toBe(0);
  });

  it("reports unavailable tracks by position, and only when explicitly false", () => {
    // `is_playable` is null on playlists pulled before the field existed. Unknown is not the
    // same as unplayable, and treating it as such would offer to strip a whole old library.
    const lint = lintPlaylist([
      t("a", { is_playable: false }),
      t("b", { is_playable: true }),
      t("c", { is_playable: null }),
      t("d", {}),
    ]);
    expect(lint.unavailable.map((u) => u.index)).toEqual([0]);
  });

  it("counts one issue per group for the badge, not per copy", () => {
    const lint = lintPlaylist([
      t("a"),
      t("a"),
      t("a"),
      t("b", { isrc: "X1" }),
      t("c", { isrc: "X1" }),
      t("d", { is_playable: false }),
    ]);
    // One exact group + one ISRC group + one unavailable = three things to look at...
    expect(issueCount(lint)).toBe(3);
    // ...but three suggested removals (two extra copies of a, one extra release of the pair).
    expect(lint.redundant).toBe(3);
  });
});

describe("removeExactDuplicates", () => {
  it("keeps the first copy and preserves order", () => {
    const out = removeExactDuplicates([t("a"), t("b"), t("a"), t("c"), t("b")]);
    expect(out.map((x) => x.title)).toEqual(["a", "b", "c"]);
  });

  it("leaves a clean list untouched and returns a new array", () => {
    const input = [t("a"), t("b")];
    const out = removeExactDuplicates(input);
    expect(out.map((x) => x.title)).toEqual(["a", "b"]);
    expect(out).not.toBe(input);
  });
});

describe("removeTracksByIds", () => {
  it("removes by bare id, leaving everything else in order", () => {
    const out = removeTracksByIds([t("a"), t("b"), t("c")], new Set(["b"]));
    expect(out.map((x) => x.title)).toEqual(["a", "c"]);
  });

  it("removes every copy of a targeted id", () => {
    const out = removeTracksByIds([t("a"), t("b"), t("a")], new Set(["a"]));
    expect(out.map((x) => x.title)).toEqual(["b"]);
  });

  it("does nothing when nothing matches", () => {
    const out = removeTracksByIds([t("a")], new Set(["zzz"]));
    expect(out.map((x) => x.title)).toEqual(["a"]);
  });
});

describe("crossPlaylistIsrcDuplicates", () => {
  const pl = (file: string, name: string, tracks: TrackEntry[]) => ({ file, name, tracks });

  it("finds one recording living under different ids in different playlists", () => {
    const groups = crossPlaylistIsrcDuplicates([
      pl("road.json", "Road Trip", [t("a", { isrc: "X1", title: "Hey Jude" })]),
      pl("jog.json", "Jog", [t("b", { isrc: "X1", title: "Hey Jude" })]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].isrc).toBe("X1");
    expect(groups[0].variants.map((v) => v.id).sort()).toEqual(["a", "b"]);
  });

  it("says nothing when the same id is simply in two playlists", () => {
    // Having one track in several playlists is the normal case, not a duplicate.
    const groups = crossPlaylistIsrcDuplicates([
      pl("road.json", "Road Trip", [t("a", { isrc: "X1" })]),
      pl("jog.json", "Jog", [t("a", { isrc: "X1" })]),
    ]);
    expect(groups).toEqual([]);
  });

  it("puts the most-used variant first, so normalizing costs the fewest edits", () => {
    const groups = crossPlaylistIsrcDuplicates([
      pl("one.json", "One", [t("rare", { isrc: "X1" })]),
      pl("two.json", "Two", [t("common", { isrc: "X1" }), t("common", { isrc: "X1" })]),
      pl("three.json", "Three", [t("common", { isrc: "X1" })]),
    ]);
    expect(groups[0].variants[0].id).toBe("common");
    expect(groups[0].variants[0].locations).toHaveLength(2);
    const two = groups[0].variants[0].locations.find((l) => l.file === "two.json");
    expect(two).toMatchObject({ name: "Two", count: 2 });
  });

  it("sorts groups by title so the panel has a stable order", () => {
    const groups = crossPlaylistIsrcDuplicates([
      pl("a.json", "A", [t("z1", { isrc: "Z", title: "Zebra" }), t("m1", { isrc: "M", title: "middle" })]),
      pl("b.json", "B", [t("z2", { isrc: "Z", title: "Zebra" }), t("m2", { isrc: "M", title: "middle" })]),
    ]);
    expect(groups.map((g) => g.title)).toEqual(["middle", "Zebra"]);
  });
});
