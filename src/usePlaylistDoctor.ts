import { useMemo, useState } from "react";
import { api, type ReplacementSuggestion, type TrackEntry } from "./api";
import { bareId } from "./metricsCalc";
import {
  issueCount,
  lintPlaylist,
  removeExactDuplicates,
  removeTracksByIds,
  type DupGroup,
  type PlaylistLint,
} from "./lint";
import { type Status } from "./usePlaylistDraft";

/// What a replacement search has turned up for one unavailable track: still running, the
/// suggestion it found, or null for "searched, nothing close". A track absent from the map
/// hasn't been searched — which is a different thing from having been searched and missed,
/// and the button says so.
export type ReplaceState = Record<string, ReplacementSuggestion | "loading" | null>;

/// What the doctor needs from the component hosting it.
export interface DoctorHost {
  /// The open playlist's draft track list, or null when nothing is open. Everything the
  /// doctor reports is derived from this, so it re-lints as the draft is edited.
  tracks: TrackEntry[] | null;
  /// Apply a fix to the draft. Every fix goes through here rather than to disk: a cleanup is
  /// an edit like any other, staged on Save and reviewable in the diff before it is pushed.
  edit: (tracks: TrackEntry[]) => void;
  onStatus: (s: Status) => void;
  /// A track was swapped in. The host fetches its audio features; the doctor doesn't know
  /// metrics exist.
  onReplaced: (track: TrackEntry) => void;
}

export interface Doctor {
  /// What's wrong with the open playlist, recomputed as it's edited.
  lint: PlaylistLint;
  /// Number of issue groups — zero means the strip isn't shown at all.
  count: number;
  open: boolean;
  toggle: () => void;
  /// Collapse the panel. Called when a playlist opens, so it doesn't arrive expanded on
  /// someone who was reading something else.
  ///
  /// Deliberately does not clear `replaceState`. It is keyed by track id and only ever read
  /// for tracks in the open playlist, so a kept entry can only surface against the very track
  /// it was found for — the same unavailable song in a second playlist, where the answer is
  /// still right and re-searching would cost another Spotify call.
  reset: () => void;

  replaceState: ReplaceState;
  /// Remove every extra copy of a track that appears more than once.
  fixExactDuplicates: () => void;
  /// Resolve an ISRC group down to the one release to keep, removing the other variants.
  keepIsrcVariant: (group: DupGroup, keepId: string) => void;
  /// Look for a playable stand-in for an unavailable track (library first, then Spotify).
  findReplacement: (track: TrackEntry) => Promise<void>;
  /// Swap the unavailable track at `index` for the suggestion found for it.
  applyReplacement: (index: number, suggestion: ReplacementSuggestion) => void;
}

/// The per-playlist cleanup doctor: what's wrong with the open playlist, and the fixes for it.
///
/// Split out of `Library` alongside the draft, collection and metrics hooks, and for the same
/// reason — it is a self-contained concern with its own state, and the only things it needs
/// from the editor are the track list and a way to edit it. Every fix goes to the draft, so
/// nothing here reaches Spotify or the disk on its own.
///
/// The library-wide scan is a different feature living in `LibraryOverlay`: it reads every
/// playlist from disk, while this one lints whatever is currently in the editor, unsaved edits
/// included. They share their checks through `lint.ts` so the two can't disagree about what
/// counts as a duplicate.
export function usePlaylistDoctor({
  tracks,
  edit,
  onStatus,
  onReplaced,
}: DoctorHost): Doctor {
  const [open, setOpen] = useState(false);
  const [replaceState, setReplaceState] = useState<ReplaceState>({});

  const lint = useMemo(() => lintPlaylist(tracks ?? []), [tracks]);

  return {
    lint,
    count: issueCount(lint),
    open,
    toggle: () => setOpen((o) => !o),
    reset: () => setOpen(false),
    replaceState,

    fixExactDuplicates: () => {
      if (!tracks) return;
      edit(removeExactDuplicates(tracks));
    },

    keepIsrcVariant: (group, keepId) => {
      if (!tracks) return;
      const remove = new Set(
        group.occurrences.map((o) => bareId(o.track.id)).filter((id) => id !== keepId)
      );
      edit(removeTracksByIds(tracks, remove));
    },

    findReplacement: async (track) => {
      setReplaceState((p) => ({ ...p, [track.id]: "loading" }));
      try {
        const s = await api.suggestReplacement(track);
        setReplaceState((p) => ({ ...p, [track.id]: s }));
      } catch (e) {
        setReplaceState((p) => ({ ...p, [track.id]: null }));
        onStatus({ kind: "err", msg: String(e) });
      }
    },

    // Preserves when and by whom the original was added: the swap is for a track that can't
    // be played, not a re-add, and the history is the same song's.
    applyReplacement: (index, s) => {
      if (!tracks) return;
      const old = tracks[index];
      if (!old) return;
      const replaced: TrackEntry = {
        id: s.id,
        isrc: s.isrc,
        title: s.title,
        artists: s.artists,
        added_at: old.added_at,
        added_by: old.added_by,
        duration_ms: s.duration_ms,
        is_playable: true,
      };
      edit(tracks.map((t, i) => (i === index ? replaced : t)));
      onReplaced(replaced);
      onStatus({ kind: "ok", msg: `Replaced "${old.title}" with a playable version` });
    },
  };
}
