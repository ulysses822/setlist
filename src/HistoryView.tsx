// The listening log as its own tab: every play the GitHub Actions poller recorded, newest
// first.
//
// A tab rather than a view inside Library because the two don't hold the same set. The log
// records what Spotify says you played, so it keeps songs you have since removed from every
// playlist, songs you heard from someone else's playlist or a radio session, and songs that
// were never yours. Hanging it off Library would promise a join that doesn't exist.
//
// Everything shown comes from history/plays.jsonl, which is self-describing — each line
// carries the title and artists as they were at the time. That is why a play can still be
// read back after the track has left the library, and why this view never needs the
// playlist files for anything except the "in library" mark.

import { useMemo, useState } from "react";
import { api, type PlayLog } from "./api";

/** Rendered rows are capped: the log only grows, and a few years of plays would be tens of
 *  thousands of nodes. The count above the list always reports the true number of matches,
 *  so the cap narrows what you scroll, never what you searched. */
const MAX_ROWS = 500;

type Scope = "all" | "outside";

export default function HistoryView() {
  const [log, setLog] = useState<PlayLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<Scope>("all");

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setLog(await api.historyLog());
    } catch (e) {
      setLog(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Not loaded on mount: the log is the largest read in the app and most sessions never
  // open this tab. One button beats paying for it on every launch.
  const matches = useMemo(() => {
    if (!log) return [];
    const q = filter.trim().toLowerCase();
    return log.plays.filter((p) => {
      if (scope === "outside" && p.in_library) return false;
      if (!q) return true;
      return `${p.title} ${p.artists.join(" ")}`.toLowerCase().includes(q);
    });
  }, [log, filter, scope]);

  const outsideCount = useMemo(
    () => (log ? log.plays.filter((p) => !p.in_library).length : 0),
    [log]
  );

  return (
    <main className="app history-app">
      <header className="history-head">
        <h1>Listening history</h1>
        <p className="hint">
          Every play the logger has recorded, newest first — including songs that aren&apos;t
          in any of your playlists.
        </p>
      </header>

      {!log && (
        <section className="card">
          <p className="hint">
            Read <code>history/plays.jsonl</code> from your data folder. The logger that
            writes it is set up in <strong>Setup</strong>, step 5.
          </p>
          <button className="btn" onClick={load} disabled={busy}>
            {busy ? "Reading…" : "Load history"}
          </button>
          {error && <p className="status err">{error}</p>}
        </section>
      )}

      {log && !log.has_file && (
        <section className="card">
          <p className="hint">
            No log yet. The listening-history logger runs in GitHub Actions and appends to{" "}
            <code>history/plays.jsonl</code> — set it up in <strong>Setup</strong>, step 5,
            then come back once it has run.
          </p>
        </section>
      )}

      {log && log.has_file && (
        <section className="card">
          <p className="hint history-summary">
            {log.total_plays.toLocaleString()} plays
            {log.tracked_since &&
              ` since ${new Date(log.tracked_since).toLocaleDateString()}`}
            {outsideCount > 0 &&
              ` · ${outsideCount.toLocaleString()} of them not in any playlist`}
            <button className="link" onClick={load} disabled={busy}>
              {busy ? "Reading…" : "Reload"}
            </button>
          </p>

          <div className="lib-controls">
            <input
              className="filter"
              name="history-filter"
              aria-label="Filter by title or artist"
              placeholder="Filter by title or artist…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="lib-sort">
              <button
                className={`seg ${scope === "all" ? "active" : ""}`}
                onClick={() => setScope("all")}
              >
                All plays
              </button>
              <button
                className={`seg ${scope === "outside" ? "active" : ""}`}
                onClick={() => setScope("outside")}
              >
                Not in a playlist
              </button>
            </div>
          </div>

          <p className="hint">
            {matches.length.toLocaleString()}
            {matches.length === 1 ? " play" : " plays"}
            {matches.length > MAX_ROWS && ` · showing the most recent ${MAX_ROWS}`}
          </p>

          <ol className="play-log">
            {matches.slice(0, MAX_ROWS).map((p) => (
              // played_at is unique per track from Spotify's own history, so the pair is a
              // stable key even though the same song appears many times.
              <li key={`${p.track_id}|${p.played_at}`} className="play-row">
                <span className="play-when" title={new Date(p.played_at).toLocaleString()}>
                  {new Date(p.played_at).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="play-title">{p.title || p.track_id}</span>
                <span className="play-artist">{p.artists.join(", ")}</span>
                {!p.in_library && (
                  <span className="play-outside" title="Not in any of your playlists">
                    not in a playlist
                  </span>
                )}
              </li>
            ))}
          </ol>

          {matches.length === 0 && (
            <p className="hint pad">
              {scope === "outside"
                ? "Every play is a song you still have in a playlist."
                : "No plays match that filter."}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
