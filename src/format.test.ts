import { describe, expect, it } from "vitest";
import { fmtDuration, fmtTotal } from "./format";

describe("fmtDuration", () => {
  it("formats a track length with a zero-padded seconds field", () => {
    expect(fmtDuration(187_000)).toBe("3:07");
    expect(fmtDuration(240_000)).toBe("4:00");
    expect(fmtDuration(59_000)).toBe("0:59");
  });

  it("rolls 59.6s up to the next minute rather than printing 0:60", () => {
    // It rounds rather than truncates, so the seconds field can carry — and a bare
    // `total % 60` on an unrounded value is how you get "3:60".
    expect(fmtDuration(59_600)).toBe("1:00");
    expect(fmtDuration(119_600)).toBe("2:00");
  });

  it("shows a dash for an unknown duration", () => {
    // Distinguishable from a real zero: null means Spotify didn't say, not a silent track.
    expect(fmtDuration(null)).toBe("–");
    expect(fmtDuration(0)).toBe("0:00");
  });
});

describe("fmtTotal", () => {
  it("drops the hours part below an hour", () => {
    expect(fmtTotal(47 * 60_000)).toBe("47 min");
    expect(fmtTotal(0)).toBe("0 min");
  });

  it("splits into hours and minutes above one", () => {
    expect(fmtTotal(72 * 60_000)).toBe("1 hr 12 min");
    expect(fmtTotal(60 * 60_000)).toBe("1 hr 0 min");
    expect(fmtTotal(3 * 3_600_000 + 5 * 60_000)).toBe("3 hr 5 min");
  });
});
