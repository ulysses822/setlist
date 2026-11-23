import { useEffect, useState } from "react";
import {
  api,
  type CatalogSearch,
  type SearchResult,
  type TrackEntry,
} from "./api";
import { appendMissing } from "./trackList";
import { bareId } from "./metricsCalc";
import { type Status } from "./usePlaylistDraft";

/**
 * Getting songs into the open playlist: the catalog search and the four ways in that use it.
 *
 * Split out of `Library` alongside the draft, collection, metrics and doctor hooks, and for
 * the same reason — a self-contained concern with its own state, where the only things it
 * needs from the editor are the track list and a way to edit it. Every add goes to the draft,
 * so nothing here reaches Spotify or the disk on its own.
 *
 * The three paths that add more than one candidate — the playing song, an album, an artist —
 * skip tracks already in the playlist and report how many they skipped, which is what makes
 * adding the album you own half of add the other half rather than doubling what is there.
 * Picking a single search hit does not: asking for one specific song twice is a thing people
 * do on purpose, and the cleanup doctor is where a duplicate gets questioned.
 */

/** What the adder needs from the component hosting it. */
export interface AdderHost {
  /**
   * The open playlist's draft track list, or null when nothing is open. Additions are
   * computed against this, so it has to be the draft rather than the file.
   */
  tracks: TrackEntry[] | null;
  /**
   * Apply an addition to the draft. Every add goes through here rather than to disk: it is an
   * edit like any other, staged on Save and reviewable in the diff before it is pushed.
   */
  edit: (tracks: TrackEntry[]) => void;
  onStatus: (s: Status) => void;
  /**
   * Tracks were added. The host fetches their audio features; the adder doesn't know metrics
   * exist.
   */
  onAdded: (tracks: TrackEntry[]) => void;
  /**
   * True while Spotify's rate limit is in force: searching is suspended rather than issuing
   * a call that would fail and extend the cooldown.
   */
  blocked: boolean;
}

export interface PlaylistAdder {
  query: string;
  setQuery: (q: string) => void;
  /** The last search's answer, or null when the box is empty or rate-limited. */
  results: CatalogSearch | null;
  searching: boolean;
  /** Whether anything was found at all — checked across all three kinds. */
  hasResults: boolean;
  /** An add of the playing song is in flight. */
  addingPlaying: boolean;
  /** Id of the album or artist being expanded, so only that row says so. */
  expanding: string | null;
  /**
   * Empty the box. Called when a playlist opens, so one playlist's search results don't
   * arrive over the next one.
   */
  reset: () => void;

  addTrack: (r: SearchResult) => void;
  /** Add the song playing now, by its uri. */
  addPlaying: (uri: string) => Promise<void>;
  addAlbum: (id: string, name: string) => Promise<void>;
  addArtist: (id: string, name: string) => Promise<void>;
}

export function usePlaylistAdder({
  tracks,
  edit,
  onStatus,
  onAdded,
  blocked,
}: AdderHost): PlaylistAdder {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [addingPlaying, setAddingPlaying] = useState(false);
  const [expanding, setExpanding] = useState<string | null>(null);

  // Debounced catalog search. Suspended while rate-limited.
  useEffect(() => {
    if (query.trim() === "" || blocked) {
      setResults(null);
      setSearching(false); // clear a stuck "Searching…" when the box is emptied mid-search
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.searchCatalog(query);
        if (!cancelled) setResults(r);
      } catch (e) {
        if (!cancelled) onStatus({ kind: "err", msg: String(e) });
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, blocked, onStatus]);

  /**
   * Append tracks read from Spotify, skipping any already present, and report what happened.
   * Shared by the three paths that add more than one candidate at a time, so they can't
   * disagree about what "already here" means or word the outcome differently.
   */
  function absorb(incoming: TrackEntry[], label: string) {
    if (!tracks) return;
    const { tracks: next, added, skipped } = appendMissing(tracks, incoming);
    if (added.length === 0) {
      onStatus({ kind: "ok", msg: `Every track from "${label}" is already here` });
      return;
    }
    edit(next);
    onAdded(added);
    onStatus({
      kind: "ok",
      msg: `Added ${added.length} track${added.length === 1 ? "" : "s"} from "${label}"${
        skipped > 0 ? `, skipped ${skipped} already here` : ""
      }`,
    });
  }

  /** Read tracks for one search result and add them. `fetch` is a request, so this is async. */
  async function expand(id: string, label: string, fetch: () => Promise<TrackEntry[]>) {
    if (!tracks || expanding) return;
    setExpanding(id);
    try {
      const incoming = await fetch();
      if (incoming.length === 0) {
        onStatus({ kind: "warn", msg: `Spotify listed no playable tracks for "${label}"` });
        return;
      }
      absorb(incoming, label);
    } catch (e) {
      onStatus({ kind: "err", msg: String(e) });
    } finally {
      setExpanding(null);
    }
  }

  return {
    query,
    setQuery,
    results,
    searching,
    hasResults:
      results != null &&
      (results.tracks.length > 0 || results.albums.length > 0 || results.artists.length > 0),
    addingPlaying,
    expanding,
    reset: () => {
      setQuery("");
      setResults(null);
    },

    // A search hit is added as-is: the search already answered with everything a playlist
    // entry needs, ISRC included, so there is nothing to look up.
    addTrack: (r) => {
      if (!tracks) return;
      const track: TrackEntry = {
        id: r.id,
        isrc: r.isrc,
        title: r.title,
        artists: r.artists,
        added_at: null,
        added_by: null,
        duration_ms: r.duration_ms,
      };
      edit([...tracks, track]);
      onAdded([track]);
    },

    /**
     * The entry is read back from Spotify rather than assembled from the player's own state,
     * which knows the title, artists and duration but not the ISRC — and the ISRC is what the
     * duplicate checks key on, so an entry built here would be invisible to them until the
     * next pull refilled it.
     */
    addPlaying: async (uri) => {
      if (!tracks || addingPlaying) return;
      setAddingPlaying(true);
      try {
        const entry = await api.trackEntry(bareId(uri));
        // Re-checked rather than trusted from the button's disabled state: the fetch is a
        // round trip, and the track could have been added elsewhere while it was in flight.
        const { tracks: next, added } = appendMissing(tracks, [entry]);
        if (added.length === 0) {
          onStatus({ kind: "ok", msg: `"${entry.title}" is already in this playlist` });
          return;
        }
        edit(next);
        onAdded(added);
        onStatus({
          kind: "ok",
          msg: `Added "${entry.title}" — save or push when you're ready`,
        });
      } catch (e) {
        onStatus({ kind: "err", msg: String(e) });
      } finally {
        setAddingPlaying(false);
      }
    },

    addAlbum: (id, name) => expand(id, name, () => api.albumTracks(id)),
    addArtist: (id, name) => expand(id, name, () => api.artistTopTracks(id)),
  };
}
