// What the editor has open, and the questions asked of it.
//
// The editor used to track its own answers. `dirty`, `staged`, `baseline` and two
// content-key refs were separate pieces of state, and every operation had to remember to
// update all of them in the right order — `setDirty` appeared ten times, `setStaged` eleven,
// and getting one wrong didn't crash anything, it just made the "modified" dot lie, which is
// the worst kind of bug in an app whose whole promise is that you can see what you're about
// to change.
//
// None of it was independent. A playlist in the editor is three contents: the Spotify mirror
// it was loaded from, whatever is on disk for it, and what is on screen. Everything the UI
// asks follows from comparing those, so they are what gets stored and the rest is derived.

import type { PlaylistFile, TrackEntry } from "./api";

/**
 * The part of a playlist an edit can change.
 *
 * Everything else a `PlaylistFile` carries — its Spotify id, snapshot id, cover, last-synced
 * time — describes the playlist rather than the edit, and belongs to the mirror.
 */
export interface Content {
  name: string;
  description: string;
  tracks: TrackEntry[];
}

export function contentOf(pf: PlaylistFile): Content {
  return { name: pf.name, description: pf.description, tracks: pf.tracks };
}

/**
 * Whether two contents are the same playlist content: same name, same description, same
 * tracks in the same order.
 *
 * Compared field by field rather than through a joined key string, which is what this
 * replaced. A key of `name \0 description \0 ids` can be forged by its own delimiter — a
 * playlist named `"Road trip\u0000"` with no description keys identically to one named
 * `"Road trip"` described as `""`, so renaming between the two read as no change at all and
 * Save would decline to write it. Spotify lets a name contain anything, so that was reachable
 * rather than theoretical.
 *
 * Tracks are compared by uri, matching `sameTracks` in trackList.ts, so a staged write and
 * the editor agree on the word "changed".
 */
export function sameContent(a: Content, b: Content): boolean {
  if (a === b) return true;
  if (a.name !== b.name || a.description !== b.description) return false;
  if (a.tracks.length !== b.tracks.length) return false;
  return a.tracks.every((t, i) => t.id === b.tracks[i].id);
}

/**
 * One playlist open in the editor.
 *
 * The invariant that used to live across five pieces of state: `persisted` is what is on disk
 * for this playlist — the staged file's content when `hasStaged`, and the mirror's content
 * when not. Nothing else needs saying, because everything else is a comparison.
 */
export interface Session {
  /** The playlist's file name, which is also its identity in every other store. */
  file: string;
  /** The Spotify mirror as last pulled. What the inline diff compares against. */
  mirror: PlaylistFile;
  /** Whether a staged (saved-but-unpushed) file exists on disk for this playlist. */
  hasStaged: boolean;
  /** The content on disk: the staged file's when `hasStaged`, else the mirror's. */
  persisted: Content;
  /** The content on screen. */
  draft: Content;
}

/** A session on a freshly-loaded mirror: nothing staged, nothing edited. */
export function sessionOf(file: string, mirror: PlaylistFile): Session {
  const content = contentOf(mirror);
  return { file, mirror, hasStaged: false, persisted: content, draft: content };
}

/**
 * The draft as a whole playlist, for everything that wants more than the edited fields.
 *
 * The mirror with the draft's content over it, which is exactly what the editor is showing:
 * your track order under the cover art and ids the playlist actually has.
 */
export function draftFile(s: Session): PlaylistFile {
  return { ...s.mirror, ...s.draft };
}

/** In-memory edits not yet written to disk — what Save writes and what Revert discards. */
export function isDirty(s: Session): boolean {
  return !sameContent(s.draft, s.persisted);
}

/**
 * The draft is exactly the Spotify mirror again.
 *
 * Which means any staged file for it holds nothing real: the edits in it cancelled out, and
 * leaving it would show the playlist as modified when it matches Spotify.
 */
export function matchesMirror(s: Session): boolean {
  return sameContent(s.draft, contentOf(s.mirror));
}

/**
 * The session after putting edited content on screen, and whether the staged file on disk has
 * become redundant.
 *
 * `dropStaged` is the README's promise in one flag: add a song, remove it again, and the
 * playlist is simply unmodified. Once the draft is the mirror once more, a staged copy holds
 * only the edits that cancelled out, and leaving it would show the playlist as modified when
 * it matches Spotify.
 *
 * Returned as a decision rather than acted on here. Its predecessor computed the dirty flag,
 * rewrote a content key and deleted a file in nine lines, which is three jobs and the reason
 * the answer couldn't be tested.
 */
export function afterEdit(
  s: Session,
  draft: Content
): { session: Session; dropStaged: boolean } {
  const dropStaged = s.hasStaged && sameContent(draft, contentOf(s.mirror));
  return {
    session: dropStaged
      ? { ...s, hasStaged: false, persisted: draft, draft }
      : { ...s, draft },
    dropStaged,
  };
}

/** The session after what is on screen has been written to disk. */
export function afterPersist(s: Session): Session {
  // A draft equal to the mirror is written by *clearing* the staged file, not creating one.
  return { ...s, hasStaged: !matchesMirror(s), persisted: s.draft };
}
