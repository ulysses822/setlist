import { describe, expect, it } from "vitest";
import type { Features, TrackEntry } from "./api";
import {
  bareId,
  computeAggregates,
  computeGoalDeviations,
  GOAL_THRESHOLD,
  isLocalTrack,
  type Goal,
} from "./metricsCalc";

function t(id: string, over: Partial<TrackEntry> = {}): TrackEntry {
  return {
    id,
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

function f(over: Partial<Features> = {}): Features {
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

describe("bareId", () => {
  it("reduces a track uri to its id", () => {
    expect(bareId("spotify:track:4cOdK2wGLETKBW3PvgPWqT")).toBe("4cOdK2wGLETKBW3PvgPWqT");
  });

  it("leaves a bare id alone, so both spellings agree", () => {
    // This is the identity rule the diff and the linter both key on. If the two spellings ever
    // disagreed, a hand-edited playlist file would read as a wholesale replacement.
    expect(bareId("4cOdK2wGLETKBW3PvgPWqT")).toBe("4cOdK2wGLETKBW3PvgPWqT");
    expect(bareId("spotify:track:x")).toBe(bareId("x"));
  });

  it("keeps a local file's uri whole", () => {
    // The last segment of a spotify:local: uri is the duration, which collides across songs —
    // truncating to it would merge unrelated local files into one track.
    const local = "spotify:local:Artist:Album:Title:214";
    expect(bareId(local)).toBe(local);
    expect(isLocalTrack(local)).toBe(true);
    expect(isLocalTrack("spotify:track:x")).toBe(false);
  });
});

describe("computeAggregates", () => {
  it("averages only the analyzed tracks, but counts and times them all", () => {
    // Half a library is usually unanalyzed (ReccoBeats doesn't cover everything), so the
    // averages must not be diluted by the tracks it has no data for.
    const tracks = [t("a", { duration_ms: 1000 }), t("b", { duration_ms: 2000 }), t("c")];
    const feats = new Map([
      ["a", f({ valence: 0.2, energy: 0.4, tempo: 100 })],
      ["b", f({ valence: 0.4, energy: 0.8, tempo: 140 })],
    ]);
    const agg = computeAggregates(tracks, (x) => feats.get(x.id));

    expect(agg.total).toBe(3);
    expect(agg.analyzed).toBe(2);
    expect(agg.total_duration_ms).toBe(4000); // includes the unanalyzed track
    expect(agg.avg_valence).toBeCloseTo(0.3);
    expect(agg.avg_energy).toBeCloseTo(0.6);
    expect(agg.avg_tempo).toBeCloseTo(120);
  });

  it("leaves the averages null until something resolves, rather than reporting zero", () => {
    // A zero average would render as a real measurement — "this playlist has no energy" —
    // when the truth is that nothing has been analyzed yet.
    const agg = computeAggregates([t("a"), t("b")], () => undefined);
    expect(agg.total).toBe(2);
    expect(agg.analyzed).toBe(0);
    expect(agg.avg_valence).toBeNull();
    expect(agg.avg_tempo).toBeNull();
  });

  it("handles an empty playlist", () => {
    const agg = computeAggregates([], () => undefined);
    expect(agg).toMatchObject({ total: 0, analyzed: 0, total_duration_ms: 0, avg_valence: null });
  });

  it("treats a missing duration as zero rather than NaN", () => {
    // One null duration propagating through the sum would blank the playlist's total time.
    const agg = computeAggregates([t("a", { duration_ms: null }), t("b", { duration_ms: 5000 })], () => undefined);
    expect(agg.total_duration_ms).toBe(5000);
  });
});

describe("computeGoalDeviations", () => {
  const goal: Goal = {
    valence: 0.5,
    energy: 0.5,
    danceability: 0.5,
    acousticness: 0.5,
    instrumentalness: 0.5,
    liveness: 0.5,
    speechiness: 0.5,
  };

  it("says nothing about a track that matches the goal", () => {
    const devs = computeGoalDeviations([t("a")], () => f(), goal);
    expect(devs.size).toBe(0);
  });

  it("reports direction and worst dimension first", () => {
    const devs = computeGoalDeviations([t("a")], () => f({ valence: 0.9, energy: 0.1 }), goal);
    const offs = devs.get("a")!;
    expect(offs).toHaveLength(2);
    expect(offs[0]).toMatchObject({ feature: "valence", dir: "up" });
    expect(offs[1]).toMatchObject({ feature: "energy", dir: "down" });
    expect(Math.abs(offs[0].diff)).toBeGreaterThanOrEqual(Math.abs(offs[1].diff));
  });

  it("treats the threshold as inclusive, and anything under it as on-target", () => {
    // Pinned because the boundary decides whether a track shows up in the user's cleanup list
    // at all, and `>` versus `>=` is a one-character difference nothing else would catch.
    //
    // Measured from a goal of 0 so the subtraction is exact. Against a goal of 0.5 it is not:
    // `(0.5 + 0.2) - 0.5` is 0.19999999999999996, so a track set to exactly the threshold
    // lands just under it. That is float arithmetic rather than a bug — either verdict at the
    // exact boundary is arbitrary — but it does mean the boundary can only be pinned here.
    const from0: Goal = { ...goal, valence: 0 };
    const at = computeGoalDeviations([t("a")], () => f({ valence: GOAL_THRESHOLD }), from0);
    expect(at.get("a")?.some((d) => d.feature === "valence")).toBe(true);

    const under = computeGoalDeviations(
      [t("a")],
      () => f({ valence: GOAL_THRESHOLD / 2 }),
      from0
    );
    expect(under.get("a")?.some((d) => d.feature === "valence") ?? false).toBe(false);
  });

  it("skips tracks with no features instead of calling them off-goal", () => {
    const devs = computeGoalDeviations([t("a"), t("b")], (x) => (x.id === "a" ? f({ valence: 1 }) : undefined), goal);
    expect([...devs.keys()]).toEqual(["a"]);
  });

  it("honours a caller-supplied threshold", () => {
    const loose = computeGoalDeviations([t("a")], () => f({ valence: 0.8 }), goal, 0.5);
    expect(loose.size).toBe(0);
    const strict = computeGoalDeviations([t("a")], () => f({ valence: 0.55 }), goal, 0.05);
    expect(strict.size).toBe(1);
  });
});
