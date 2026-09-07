import { describe, expect, it } from "vitest";
import type { TrackEntry } from "./api";
import { diffTracks, type DiffRow } from "./playlistDiff";

// This diff is what the user reads before pushing to Spotify. If it under-reports, someone
// approves a change they didn't see; if it over-reports, the review is noise and stops being
// read. Both failures are silent, which is what makes them worth pinning.

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

const list = (...ids: string[]) => ids.map((id) => t(id));
/** The rows a reader actually sees, as "status:title", in order. */
const shown = (rows: DiffRow[]) => rows.map((r) => `${r.status}:${r.track.title}`);

describe("diffTracks", () => {
  it("reports nothing for an untouched playlist", () => {
    const d = diffTracks(list("a", "b", "c"), list("a", "b", "c"));
    expect(d.changed).toBe(false);
    expect([d.added, d.removed, d.moved]).toEqual([0, 0, 0]);
    expect(shown(d.rows)).toEqual(["unchanged:a", "unchanged:b", "unchanged:c"]);
  });

  it("marks only the song that moved, not everything after it", () => {
    // The reason this uses an LCS at all. Dragging "c" to the front must not report b and c
    // and everything downstream as changed — a review that flags the whole playlist for one
    // drag is one nobody reads.
    const d = diffTracks(list("a", "b", "c", "d"), list("c", "a", "b", "d"));
    expect(d.moved).toBe(1);
    expect([d.added, d.removed]).toEqual([0, 0]);
    expect(shown(d.rows)).toEqual(["moved:c", "unchanged:a", "unchanged:b", "unchanged:d"]);
  });

  it("keeps a removed song at the spot it was removed from", () => {
    // Removed rows are rendered struck-through in place, so their position in `rows` is the
    // whole point — appended at the end they would read as a different edit.
    const d = diffTracks(list("a", "b", "c"), list("a", "c"));
    expect([d.added, d.removed, d.moved]).toEqual([0, 1, 0]);
    expect(shown(d.rows)).toEqual(["unchanged:a", "removed:b", "unchanged:c"]);
    expect(d.rows.find((r) => r.status === "removed")?.position).toBeNull();
  });

  it("numbers the surviving rows by their final position, skipping removals", () => {
    // `position` is what the editor prints next to each row, so it has to be the position in
    // the pushed playlist — not the index in this merged view, which includes removals.
    const d = diffTracks(list("a", "b", "c"), list("a", "c", "d"));
    const present = d.rows.filter((r) => r.position !== null);
    expect(present.map((r) => [r.track.title, r.position])).toEqual([
      ["a", 1],
      ["c", 2],
      ["d", 3],
    ]);
  });

  it("counts an add and a remove separately rather than as a move", () => {
    const d = diffTracks(list("a", "b"), list("a", "z"));
    expect([d.added, d.removed, d.moved]).toEqual([1, 1, 0]);
    expect(d.changed).toBe(true);
  });

  it("handles a playlist that gained everything or lost everything", () => {
    const gained = diffTracks([], list("a", "b"));
    expect([gained.added, gained.removed]).toEqual([2, 0]);
    expect(shown(gained.rows)).toEqual(["added:a", "added:b"]);

    const lost = diffTracks(list("a", "b"), []);
    expect([lost.added, lost.removed]).toEqual([0, 2]);
    expect(shown(lost.rows)).toEqual(["removed:a", "removed:b"]);

    const empty = diffTracks([], []);
    expect(empty.changed).toBe(false);
    expect(empty.rows).toEqual([]);
  });

  it("treats duplicate ids as separate copies", () => {
    // A playlist may legitimately hold the same track twice, so the diff counts occurrences
    // rather than membership. Dropping one copy of three is one removal, not none.
    const d = diffTracks(list("a", "a", "a"), list("a", "a"));
    expect([d.added, d.removed]).toEqual([0, 1]);

    const added = diffTracks(list("a"), list("a", "a"));
    expect([added.added, added.removed]).toEqual([1, 0]);
  });

  it("matches on the bare id, so a bare entry and a uri are the same track", () => {
    // The identity rule from metricsCalc.bareId. A hand-edited playlists/*.json carrying bare
    // ids must not read as a wholesale replacement of the library.
    const baseline = [t("a")];
    const draft: TrackEntry[] = [{ ...t("a"), id: "a" }];
    expect(diffTracks(baseline, draft).changed).toBe(false);
  });

  it("gives every row a distinct key", () => {
    // These are React keys. Duplicates don't throw — they quietly render the wrong row, which
    // in a diff means showing the user something other than what they are about to push.
    const d = diffTracks(list("a", "b", "a", "c"), list("c", "a", "a", "d"));
    const keys = d.rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("accounts for every draft track exactly once, whatever the edit", () => {
    // The invariant that matters most: the rows carrying a position are exactly the playlist
    // that will be pushed, in order. Checked across a spread of edits rather than one case.
    const cases: Array<[string[], string[]]> = [
      [["a", "b", "c"], ["c", "b", "a"]],
      [["a", "b", "c"], ["d", "e"]],
      [["a", "a", "b"], ["b", "a", "a"]],
      [["a"], ["a", "b", "c", "d"]],
      [["a", "b", "c", "d", "e"], ["e", "a", "x", "c"]],
    ];
    for (const [base, draft] of cases) {
      const d = diffTracks(list(...base), list(...draft));
      const present = d.rows.filter((r) => r.position !== null);
      expect(present.map((r) => r.track.title), `${base} -> ${draft}`).toEqual(draft);
      expect(present.map((r) => r.position), `${base} -> ${draft}`).toEqual(
        draft.map((_, i) => i + 1)
      );
      // And the counts agree with the rows they summarize.
      expect(d.added, `${base} -> ${draft}`).toBe(
        d.rows.filter((r) => r.status === "added").length
      );
      expect(d.moved, `${base} -> ${draft}`).toBe(
        d.rows.filter((r) => r.status === "moved").length
      );
      expect(d.removed, `${base} -> ${draft}`).toBe(
        d.rows.filter((r) => r.status === "removed").length
      );
      expect(d.changed, `${base} -> ${draft}`).toBe(d.added + d.removed + d.moved > 0);
    }
  });

  it("still reports adds and removes on the large-playlist fallback path", () => {
    // Past 2M comparisons the LCS is skipped for a cheaper pass. It gives up on move
    // detection, but must not give up on the counts — that would understate a real change.
    const baseline = Array.from({ length: 1500 }, (_, i) => t(`t${i}`));
    const draft = [...baseline.slice(0, 1499), t("new")];
    const d = diffTracks(baseline, draft);
    expect(baseline.length * draft.length).toBeGreaterThan(2_000_000);
    expect([d.added, d.removed]).toEqual([1, 1]);
    expect(d.changed).toBe(true);
  });
});
