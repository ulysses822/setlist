import { describe, expect, it } from "vitest";
import type { TrackEntry } from "./api";
import { popSnapshot, recordSnapshot, UNDO_LIMIT, type Snapshot } from "./undo";

// Undo is the counterweight to editing in bulk, so the properties worth pinning are the ones
// that decide whether one press undoes one thing.

function t(id: string): TrackEntry {
  return {
    id: `spotify:track:${id}`,
    isrc: null,
    title: id,
    artists: ["A"],
    added_at: null,
    added_by: null,
    duration_ms: 1000,
    is_playable: true,
  };
}

function snap(key: string, tracks: TrackEntry[] = [t("a")]): Snapshot {
  return { key, name: "Playlist", description: "", tracks };
}

describe("recordSnapshot", () => {
  it("records a step", () => {
    const stack = recordSnapshot([], snap("one"));
    expect(stack).toHaveLength(1);
    expect(stack[0].key).toBe("one");
  });

  it("keeps steps in the order they happened", () => {
    let stack = recordSnapshot([], snap("one"));
    stack = recordSnapshot(stack, snap("two"));
    expect(stack.map((s) => s.key)).toEqual(["one", "two"]);
  });

  it("drops an edit that changed nothing, so one press is not needed twice", () => {
    const first = recordSnapshot([], snap("same"));
    const second = recordSnapshot(first, snap("same"));
    // Same array back, so a caller holding this in state doesn't re-render either.
    expect(second).toBe(first);
    expect(second).toHaveLength(1);
  });

  it("only compares against the top, so returning to an earlier state is still a step", () => {
    // Remove a track, then put it back: the content matches an older snapshot but the way
    // back to it is a step of its own.
    let stack = recordSnapshot([], snap("a+b"));
    stack = recordSnapshot(stack, snap("a"));
    stack = recordSnapshot(stack, snap("a+b"));
    expect(stack.map((s) => s.key)).toEqual(["a+b", "a", "a+b"]);
  });

  it("keeps the most recent steps once it is full", () => {
    let stack: Snapshot[] = [];
    for (let i = 0; i < UNDO_LIMIT + 10; i++) stack = recordSnapshot(stack, snap(`k${i}`));
    expect(stack).toHaveLength(UNDO_LIMIT);
    // The oldest ten went, not the newest.
    expect(stack[0].key).toBe("k10");
    expect(stack[stack.length - 1].key).toBe(`k${UNDO_LIMIT + 9}`);
  });

  it("does not mutate the stack it was given", () => {
    const before = recordSnapshot([], snap("one"));
    recordSnapshot(before, snap("two"));
    expect(before).toHaveLength(1);
  });

  it("holds the track list it was handed rather than a copy of it", () => {
    // The draft replaces its array on every edit instead of mutating it, which is what lets
    // a snapshot keep the reference. Copying fifty track lists would not be free.
    const tracks = [t("a"), t("b")];
    const stack = recordSnapshot([], snap("one", tracks));
    expect(stack[0].tracks).toBe(tracks);
  });
});

describe("popSnapshot", () => {
  it("reports nothing to undo on an empty stack", () => {
    expect(popSnapshot([])).toBeNull();
  });

  it("takes the most recent step and leaves the rest", () => {
    const stack = [snap("one"), snap("two"), snap("three")];
    const popped = popSnapshot(stack);
    expect(popped?.snapshot.key).toBe("three");
    expect(popped?.rest.map((s) => s.key)).toEqual(["one", "two"]);
  });

  it("walks all the way back one step at a time", () => {
    let stack = [snap("one"), snap("two")];
    const seen: string[] = [];
    for (let popped = popSnapshot(stack); popped; popped = popSnapshot(stack)) {
      seen.push(popped.snapshot.key);
      stack = popped.rest;
    }
    expect(seen).toEqual(["two", "one"]);
    expect(stack).toEqual([]);
  });

  it("does not mutate the stack it was given", () => {
    const stack = [snap("one"), snap("two")];
    popSnapshot(stack);
    expect(stack).toHaveLength(2);
  });
});
