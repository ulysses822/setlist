// Stale-track view: every song across your playlists joined with how recently (if ever) you
// played it, so you can find tracks worth pruning. Curation aid, not a stats dashboard —
// the signal is "last played" / "never played", honest about the logging window.

import { useMemo, useState } from "react";
import type { HistoryReport, NamedPlaylist, PlayStat, TrackEntry } from "./api";
import { bareId, isLocalTrack } from "./metricsCalc";
import { useNowPlaying } from "./player";

type StaleSort = "stale" | "count" | "recent";
type Threshold = "all" | "30" | "90" | "180" | "never";

const DAY = 86_400_000;

function fmtAgo(iso: string | null): string {
  if (!iso) return "Never";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "Never";
  const d = Math.floor((Date.now() - ms) / DAY);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  const y = Math.floor(d / 365);
  return y === 1 ? "1yr ago" : `${y}yr ago`;
}

interface SongEntry {
  track: TrackEntry;
  playlists: { file: string; name: string }[];
  addedAt: string | null; // earliest added_at across occurrences
}

export default function StaleView({
  data,
  history,
  busy,
  onClose,
  onOpenTrack,
}: {
  data: NamedPlaylist[] | null;
  history: HistoryReport | null;
  busy: boolean;
  onClose: () => void;
  /** Open a playlist in the editor, centered on the given track (to prune it there). */
  onOpenTrack: (file: string, trackId: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<StaleSort>("stale");
  const [threshold, setThreshold] = useState<Threshold>("90");
  const player = useNowPlaying();
  const playingId = player?.playing ? bareId(player.playing.uri) : null;
  const playingLinkedId = player?.playing?.linkedFromUri ? bareId(player.playing.linkedFromUri) : null;

  // Re-key stats by bareId so they join the playlist tracks (stored as original uris).
  const statByBare = useMemo(() => {
    const m = new Map<string, PlayStat>();
    for (const s of history?.stats ?? []) m.set(bareId(s.id), s);
    return m;
  }, [history]);

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
          if (t.added_at && (!e.addedAt || t.added_at < e.addedAt)) e.addedAt = t.added_at;
        } else {
          map.set(id, {
            track: t,
            playlists: [{ file: pl.file, name: pl.name }],
            addedAt: t.added_at ?? null,
          });
        }
      }
    }
    return [...map.values()];
  }, [data]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const now = Date.now();
    const trackedSince = history?.tracked_since ? Date.parse(history.tracked_since) : null;

    const joined = allSongs.map((e) => {
      const stat = statByBare.get(bareId(e.track.id));
      return { ...e, lastPlayed: stat?.last_played ?? null, count: stat?.count ?? 0 };
    });

    const filtered = joined.filter((e) => {
      if (q && !`${e.track.title} ${e.track.artists.join(" ")}`.toLowerCase().includes(q)) {
        return false;
      }
      if (threshold === "all") return true;
      const lastMs = e.lastPlayed ? Date.parse(e.lastPlayed) : null;
      const addedMs = e.addedAt ? Date.parse(e.addedAt) : null;
      if (threshold === "never") {
        // Never played, and present since before logging began — so we had full coverage and
        // still saw nothing. (A track added after we started logging isn't a fair "never".)
        if (lastMs != null || trackedSince == null) return false;
        return addedMs == null || addedMs <= trackedSince;
      }
      // "not played in N days" — and added at least N days ago so a fresh track isn't stale.
      const cutoff = now - Number(threshold) * DAY;
      const playedRecently = lastMs != null && lastMs > cutoff;
      const isNew = addedMs != null && addedMs > cutoff;
      return !playedRecently && !isNew;
    });

    filtered.sort((a, b) => {
      if (sort === "count") return a.count - b.count; // least played first
      const am = a.lastPlayed ? Date.parse(a.lastPlayed) : -Infinity;
      const bm = b.lastPlayed ? Date.parse(b.lastPlayed) : -Infinity;
      // "recent": most-recently played first; "stale": never/oldest first.
      return sort === "recent" ? bm - am : am - bm;
    });
    return filtered;
  }, [allSongs, statByBare, filter, sort, threshold, history]);

  const noLog = !history || !history.has_file || history.tracked_since == null;
  const since = history?.tracked_since
    ? new Date(history.tracked_since).toLocaleDateString()
    : null;

  return (
    <div className="doctor library-view stale-view">
      <header className="doctor-head">
        <div>
          <h2>Stale tracks</h2>
          <p className="hint">
            {noLog
              ? "Find songs you don't listen to anymore."
              : `Logging since ${since} · ${history!.total_plays} plays. “Never” means not played since then.`}
          </p>
        </div>
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </header>

      {noLog ? (
        <p className="hint pad">
          No listening history yet. Set up the logger in <strong>Setup → Install logger</strong>{" "}
          (and add the GitHub secrets) — once it's recorded some plays, your least-played
          tracks show up here.
        </p>
      ) : (
        <>
          <div className="lib-controls">
            <input
              className="filter"
              name="stale-filter"
              aria-label="Filter by title or artist"
              placeholder="Filter by title or artist…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="lib-sort" title="Show tracks not played in…">
              {(
                [
                  ["30", "30d"],
                  ["90", "90d"],
                  ["180", "6mo"],
                  ["never", "Never"],
                  ["all", "All"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={`seg ${threshold === k ? "active" : ""}`}
                  onClick={() => setThreshold(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="lib-sort">
              {(
                [
                  ["stale", "Stalest"],
                  ["recent", "Recent"],
                  ["count", "Fewest plays"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={`seg ${sort === k ? "active" : ""}`}
                  onClick={() => setSort(k)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {busy ? (
            <p className="hint pad">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="hint pad">
              {allSongs.length === 0
                ? "No songs yet — pull your playlists first."
                : "Nothing matches — every track here has been played within that window."}
            </p>
          ) : (
            <ol className="lib-list">
              {rows.map(({ track, playlists, lastPlayed, count }) => {
                const local = isLocalTrack(track.id);
                const unavailable = track.is_playable === false;
                const isPlaying =
                  playingId != null &&
                  (bareId(track.id) === playingId || bareId(track.id) === playingLinkedId);
                return (
                  <li
                    key={bareId(track.id)}
                    className={`lib-row stale-row ${unavailable ? "unavailable" : ""} ${
                      isPlaying ? "playing" : ""
                    }`}
                  >
                    <button
                      className="lib-play"
                      title={local ? "Local file" : unavailable ? "Unavailable on Spotify" : "Play"}
                      disabled={local || unavailable}
                      onClick={() => player?.play(null, null, [track.id])}
                    >
                      ▶
                    </button>
                    <span className="lib-title">
                      <span className="t-title-text">{track.title}</span>
                      {local && <span className="local-tag">local</span>}
                    </span>
                    <span className="lib-artists">{track.artists.join(", ")}</span>
                    <span className={`stale-when ${lastPlayed ? "" : "never"}`}>
                      {fmtAgo(lastPlayed)}
                    </span>
                    <span className="stale-count" title={`${count} play${count === 1 ? "" : "s"}`}>
                      {count}×
                    </span>
                    <span className="lib-in">
                      {playlists.map((p) => (
                        <button
                          key={p.file}
                          className="lib-chip"
                          onClick={() => onOpenTrack(p.file, track.id)}
                          title={`Open "${p.name}" to remove it`}
                        >
                          {p.name}
                        </button>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
