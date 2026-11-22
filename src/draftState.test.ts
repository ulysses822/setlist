import { describe, expect, it } from "vitest";
import type { PlaylistFile, TrackEntry } from "./api";
import {
  afterEdit,
  afterPersist,
  contentOf,
  draftFile,
  isDirty,
  matchesMirror,
  sameContent,
  sessionOf,
  type Session,
} from "./draftState";

// These four questions used to be answered by five pieces of state that every operation had
// to keep in step. They decide whether the "modified" dot tells the truth, whether Save
// writes anything and whether Revert offers itself, so each one is worth pinning.

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

function mirror(over: Partial<PlaylistFile> = {}): PlaylistFile {
  return {
    spotify_id: "37i9dQZF1DXcBWIGoYBM5M",
    name: "Road trip",
    description: "",
    snapshot_id: "snap1",
    last_synced: "2026-01-01T00:00:00Z",
    cover_url: "https://example.invalid/cover.jpg",
    tracks: [t("a"), t("b")],
    ...over,
  };
}

describe("sameContent", () => {
  it("sees unchanged content through a copy", () => {
    const pf = mirror();
    expect(sameContent(contentOf(pf), contentOf(pf))).toBe(true);
  });

  it("notices a rename, a re-description, a reorder, an addition and a removal", () => {
    const base = contentOf(mirror());
    expect(sameContent(base, { ...base, name: "Other" })).toBe(false);
    expect(sameContent(base, { ...base, description: "now with words" })).toBe(false);
    expect(sameContent(base, { ...base, tracks: [t("b"), t("a")] })).toBe(false);
    expect(sameContent(base, { ...base, tracks: [t("a"), t("b"), t("c")] })).toBe(false);
    expect(sameContent(base, { ...base, tracks: [t("a")] })).toBe(false);
  });

  it("cannot be fooled by a name containing the old key's delimiter", () => {
    // This replaced a `name \0 description \0 ids` key string, which its own delimiter could
    // forge: these two keyed identically, so renaming between them read as no change and Save
    // declined to write it. Spotify lets a playlist name contain anything.
    const a = { name: "Road trip\u0000", description: "", tracks: [t("a")] };
    const b = { name: "Road trip", description: "", tracks: [t("a")] };
    expect(sameContent(a, b)).toBe(false);

    const c = { name: "Road trip", description: "\u0000x", tracks: [t("a")] };
    const d = { name: "Road trip\u0000", description: "x", tracks: [t("a")] };
    expect(sameContent(c, d)).toBe(false);
  });

  it("ignores when and by whom a track was added", () => {
    // Staged edits don't carry those, so treating them as content would make every playlist
    // with unpushed edits read as permanently modified.
    const base = contentOf(mirror({ tracks: [t("a")] }));
    const stamped = { ...base, tracks: [t("a", { added_at: "2020-01-01", added_by: "x" })] };
    expect(sameContent(base, stamped)).toBe(true);
  });
});

describe("a freshly opened session", () => {
  const session = sessionOf("road-trip.json", mirror());

  it("is neither dirty nor staged, and matches the mirror", () => {
    expect(isDirty(session)).toBe(false);
    expect(session.hasStaged).toBe(false);
    expect(matchesMirror(session)).toBe(true);
  });

  it("shows the mirror's own playlist, cover and ids included", () => {
    const shown = draftFile(session);
    expect(shown.name).toBe("Road trip");
    expect(shown.spotify_id).toBe("37i9dQZF1DXcBWIGoYBM5M");
    expect(shown.cover_url).toBe("https://example.invalid/cover.jpg");
    expect(shown.tracks.map((x) => x.title)).toEqual(["a", "b"]);
  });
});

describe("editing a session", () => {
  const opened = sessionOf("road-trip.json", mirror());

  it("goes dirty on an edit and stops matching the mirror", () => {
    const edited: Session = { ...opened, draft: { ...opened.draft, tracks: [t("a")] } };
    expect(isDirty(edited)).toBe(true);
    expect(matchesMirror(edited)).toBe(false);
  });

  it("stops being dirty once the edit is persisted", () => {
    const draft = { ...opened.draft, tracks: [t("a")] };
    const saved: Session = { ...opened, hasStaged: true, persisted: draft, draft };
    expect(isDirty(saved)).toBe(false);
    // Still differs from Spotify, which is what Push is for and what the diff shows.
    expect(matchesMirror(saved)).toBe(false);
  });

  it("knows an edit that cancelled out, even though a staged file is still on disk", () => {
    // Add a song, save, remove it again. The staged file now holds nothing real: the editor
    // is dirty against disk, and the draft matches Spotify, which is the pair of answers
    // that tells the editor to drop the staged copy.
    const staged = { ...opened.draft, tracks: [t("a"), t("b"), t("c")] };
    const session: Session = { ...opened, hasStaged: true, persisted: staged, draft: staged };
    const undone: Session = { ...session, draft: opened.draft };

    expect(isDirty(undone)).toBe(true);
    expect(matchesMirror(undone)).toBe(true);
  });

  it("treats a rename on its own as an edit", () => {
    const renamed: Session = { ...opened, draft: { ...opened.draft, name: "Night drive" } };
    expect(isDirty(renamed)).toBe(true);
    expect(matchesMirror(renamed)).toBe(false);
    // And the draft shown keeps everything that isn't the edit.
    expect(draftFile(renamed).spotify_id).toBe(opened.mirror.spotify_id);
  });

  it("leaves the mirror alone however the draft is edited, so the diff keeps its baseline", () => {
    const edited: Session = { ...opened, draft: { name: "x", description: "y", tracks: [] } };
    expect(edited.mirror.tracks.map((x) => x.title)).toEqual(["a", "b"]);
    expect(edited.mirror.name).toBe("Road trip");
  });
});

describe("a session opened on a staged edit", () => {
  it("is staged but not dirty, and differs from the mirror", () => {
    const pf = mirror();
    const staged = { name: "Road trip", description: "", tracks: [t("a")] };
    const session: Session = {
      file: "road-trip.json",
      mirror: pf,
      hasStaged: true,
      persisted: staged,
      draft: staged,
    };
    expect(isDirty(session)).toBe(false);
    expect(session.hasStaged).toBe(true);
    expect(matchesMirror(session)).toBe(false);
    // The editor shows the staged version, not Spotify's.
    expect(draftFile(session).tracks.map((x) => x.title)).toEqual(["a"]);
  });
});

// The sequences that matter, walked a step at a time. Every one of these used to be an
// ordering question across five pieces of state, and the "modified" dot lying is the bug
// they guard against.

describe("the shape of an editing session", () => {
  const opened = () => sessionOf("road-trip.json", mirror());

  it("add a song, save, push: modified, then saved, then clean", () => {
    let s = opened();
    const added = { ...s.draft, tracks: [t("a"), t("b"), t("c")] };

    s = afterEdit(s, added).session;
    expect([isDirty(s), s.hasStaged]).toEqual([true, false]);

    s = afterPersist(s);
    expect([isDirty(s), s.hasStaged]).toEqual([false, true]);
    // Still ahead of Spotify, which is what the diff shows and Push sends.
    expect(matchesMirror(s)).toBe(false);

    // A push makes what was sent the mirror.
    s = sessionOf(s.file, { ...s.mirror, tracks: added.tracks });
    expect([isDirty(s), s.hasStaged, matchesMirror(s)]).toEqual([false, false, true]);
  });

  it("add a song, save, then remove it again: the staged file goes and nothing is modified", () => {
    let s = opened();
    const added = { ...s.draft, tracks: [t("a"), t("b"), t("c")] };
    s = afterPersist(afterEdit(s, added).session);
    expect(s.hasStaged).toBe(true);

    // Back to the mirror. The staged copy now holds only the edits that cancelled out, so it
    // is dropped — the README's "no phantom unsaved changes".
    const back = afterEdit(s, contentOf(s.mirror));
    expect(back.dropStaged).toBe(true);
    expect([isDirty(back.session), back.session.hasStaged]).toEqual([false, false]);
  });

  it("does not try to drop a staged file that was never there", () => {
    const s = opened();
    const there = afterEdit(s, { ...s.draft, tracks: [t("a")] });
    expect(there.dropStaged).toBe(false);
    // And editing straight back needs no cleanup either: disk already says this.
    const back = afterEdit(there.session, contentOf(s.mirror));
    expect(back.dropStaged).toBe(false);
    expect(isDirty(back.session)).toBe(false);
  });

  it("an edit away from a saved one leaves the staged file alone", () => {
    let s = opened();
    s = afterPersist(afterEdit(s, { ...s.draft, tracks: [t("a")] }).session);
    const further = afterEdit(s, { ...s.draft, tracks: [t("b")] });
    expect(further.dropStaged).toBe(false);
    expect([isDirty(further.session), further.session.hasStaged]).toEqual([true, true]);
  });

  it("saving an edit that cancelled out clears the staged file rather than writing one", () => {
    let s = opened();
    s = afterPersist(afterEdit(s, { ...s.draft, tracks: [t("a")] }).session);
    expect(s.hasStaged).toBe(true);
    // Reach the mirror again without going through afterEdit (a staged write from elsewhere),
    // then save: there is nothing to stage, so the file goes.
    const atMirror: Session = { ...s, draft: contentOf(s.mirror) };
    expect(afterPersist(atMirror).hasStaged).toBe(false);
  });

  it("renaming and then renaming back needs no save", () => {
    const s = opened();
    const renamed = afterEdit(s, { ...s.draft, name: "Night drive" }).session;
    expect(isDirty(renamed)).toBe(true);
    const undone = afterEdit(renamed, s.draft).session;
    expect(isDirty(undone)).toBe(false);
  });

  it("keeps the mirror through every step, so the diff always has its baseline", () => {
    let s = opened();
    s = afterEdit(s, { name: "x", description: "y", tracks: [] }).session;
    s = afterPersist(s);
    s = afterEdit(s, { ...s.draft, tracks: [t("z")] }).session;
    expect(s.mirror.tracks.map((x) => x.title)).toEqual(["a", "b"]);
    expect(draftFile(s).spotify_id).toBe("37i9dQZF1DXcBWIGoYBM5M");
  });
});
