// Global library view: every song across every playlist, deduped by bare id, with the
// playlists each one lives in. A read-only browse/play view (open a playlist to actually
// edit). Owns its filter/sort state; the library walk is memoized so it doesn't rerun on
// unrelated re-renders.

import { useMemo, useState } from "react";
import type { NamedPlaylist, TrackEntry } from "./api";
import { fmtDuration } from "./format";
import { bareId, isLocalTrack } from "./metricsCalc";
import { useNowPlaying } from "./player";

type LibSort = "title" | "count" | "duration";

interface SongEntry {
  track: TrackEntry;
  playlists: { file: string; name: string }[];
}

export default function AllSongsView({
  data,
  busy,
  onClose,
  onOpenTrack,
}: {
  data: NamedPlaylist[] | null;
  busy: boolean;
  onClose: () => void;
  /** Open a playlist in the editor, centered on the given track. */
  onOpenTrack: (file: string, trackId: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<LibSort>("title");
  const player = useNowPlaying();
  // Match by bare id, against both the playing uri and its pre-relink original (Spotify
  // may substitute a market equivalent at playback time; files store the original).
  const playingId = player?.playing ? bareId(player.playing.uri) : null;
  const playingLinkedId = player?.playing?.linkedFromUri
    ? bareId(player.playing.linkedFromUri)
    : null;

  const allSongs = useMemo(() => {
    const map = new Map<string, SongEntry>();
    for (const pl of data ?? []) {
      for (const t of pl.tracks) {
        const id = bareId(t.id);
        const e = map.get(id);
        if (e) {
          if (!e.playlists.some((p) => p.file === pl.file)) {
            e.playlists.push({ file: pl.file, name: pl.name });
          }
        } else {
          map.set(id, { track: t, playlists: [{ file: pl.file, name: pl.name }] });
        }
      }
    }
    return [...map.values()];
  }, [data]);

  const songs = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q
      ? allSongs.filter(({ track }) =>
          `${track.title} ${track.artists.join(" ")}`.toLowerCase().includes(q)
        )
      : allSongs;
    return [...matched].sort((a, b) => {
      if (sort === "count") return b.playlists.length - a.playlists.length;
      if (sort === "duration") return (b.track.duration_ms ?? 0) - (a.track.duration_ms ?? 0);
      return a.track.title.localeCompare(b.track.title, undefined, { sensitivity: "base" });
    });
  }, [allSongs, filter, sort]);

  const total = allSongs.length;
  const filtering = filter.trim() !== "";

  return (
    <div className="doctor library-view">
      <header className="doctor-head">
        <div>
          <h2>All songs</h2>
          <p className="hint">
            {total} unique song{total === 1 ? "" : "s"} across your playlists
            {filtering ? ` · ${songs.length} matching` : ""}
          </p>
        </div>
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="lib-controls">
        <input
          className="filter"
          name="library-filter"
          aria-label="Filter by title or artist"
          placeholder="Filter by title or artist…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="lib-sort">
          {(["title", "count", "duration"] as const).map((k) => (
            <button
              key={k}
              className={`seg ${sort === k ? "active" : ""}`}
              onClick={() => setSort(k)}
            >
              {k === "title" ? "Title" : k === "count" ? "Playlists" : "Length"}
            </button>
          ))}
        </div>
      </div>
      {busy ? (
        <p className="hint pad">Loading your library…</p>
      ) : songs.length === 0 ? (
        <p className="hint pad">
          {total === 0 ? "No songs yet — pull your playlists first." : "No songs match that filter."}
        </p>
      ) : (
        <ol className="lib-list">
          {songs.map(({ track, playlists }) => {
            const local = isLocalTrack(track.id);
            const unavailable = track.is_playable === false;
            const isPlaying =
              playingId != null &&
              (bareId(track.id) === playingId || bareId(track.id) === playingLinkedId);
            return (
              <li
                key={bareId(track.id)}
                className={`lib-row ${unavailable ? "unavailable" : ""} ${
                  isPlaying ? "playing" : ""
                }`}
              >
                <button
                  className="lib-play"
                  title={
                    local
                      ? "Local file — playable only in the Spotify desktop app"
                      : unavailable
                      ? "Unavailable on Spotify"
                      : "Play"
                  }
                  disabled={local || unavailable}
                  onClick={() => player?.play(null, null, [track.id])}
                >
                  ▶
                </button>
                <span className="lib-title">
                  <span className="t-title-text">{track.title}</span>
                  {local && <span className="local-tag">local</span>}
                  {unavailable && <span className="unavail-tag">unavailable</span>}
                </span>
                <span className="lib-artists">{track.artists.join(", ")}</span>
                <span className="lib-in">
                  {playlists.map((p) => (
                    <button
                      key={p.file}
                      className="lib-chip"
                      onClick={() => onOpenTrack(p.file, track.id)}
                      title={`Open "${p.name}"`}
                    >
                      {p.name}
                    </button>
                  ))}
                </span>
                <span className="lib-dur">{fmtDuration(track.duration_ms)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
