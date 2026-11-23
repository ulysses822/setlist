// The editor's add box: one search field, and the four ways a song gets into the open
// playlist. Presentational — every value it shows and every action it offers comes from
// `usePlaylistAdder` or the host, so this file holds no state and reads top to bottom.

import { fmtDuration } from "./format";
import type { PlaylistAdder } from "./usePlaylistAdder";

/** The playing song, once the host has decided it is one that could be added. */
export interface AddablePlaying {
  uri: string;
  trackName: string;
}

export default function AddBox({
  adder,
  blocked,
  playing,
  playingIsHere,
}: {
  adder: PlaylistAdder;
  /** Spotify's rate limit is in force: nothing here can reach the API. */
  blocked: boolean;
  /** The playing song if it can be added, else null — a local file is not offerable. */
  playing: AddablePlaying | null;
  /** That song is already in the open playlist, so the button has nothing to do. */
  playingIsHere: boolean;
}) {
  const { results, expanding } = adder;
  return (
    <div className="add-box">
      <div className="add-row">
        <input
          className="filter"
          name="spotify-track-search"
          aria-label="Search Spotify for a song, album or artist"
          placeholder={
            blocked
              ? "Spotify search paused — rate-limited"
              : "Search Spotify for a song, album or artist…"
          }
          value={adder.query}
          onChange={(e) => adder.setQuery(e.target.value)}
          disabled={blocked}
        />
        {playing && (
          <button
            className="btn ghost small"
            onClick={() => void adder.addPlaying(playing.uri)}
            disabled={adder.addingPlaying || playingIsHere || blocked}
            title={
              playingIsHere
                ? `"${playing.trackName}" is already in this playlist`
                : `Add "${playing.trackName}" to this playlist`
            }
          >
            {adder.addingPlaying ? "Adding…" : "+ Playing song"}
          </button>
        )}
      </div>

      {(adder.searching || adder.hasResults) && (
        <ul className="results">
          {adder.searching && <li className="hint pad">Searching…</li>}
          {results && results.tracks.length > 0 && (
            <>
              <li className="results-head">Songs</li>
              {results.tracks.map((r) => (
                <li key={r.id}>
                  <button className="result" onClick={() => adder.addTrack(r)}>
                    <span className="r-title">{r.title}</span>
                    <span className="r-meta">
                      {r.artists.join(", ")}
                      {r.album ? ` · ${r.album}` : ""}
                    </span>
                    <span className="r-dur">{fmtDuration(r.duration_ms)}</span>
                    <span className="r-add">+ add</span>
                  </button>
                </li>
              ))}
            </>
          )}
          {results && results.albums.length > 0 && (
            <>
              <li className="results-head">Albums</li>
              {results.albums.map((a) => (
                <li key={a.id}>
                  <button
                    className="result"
                    disabled={expanding != null || blocked}
                    onClick={() => void adder.addAlbum(a.id, a.name)}
                  >
                    <span className="r-title">{a.name}</span>
                    <span className="r-meta">
                      {[
                        a.artists.join(", "),
                        a.year,
                        `${a.total_tracks} track${a.total_tracks === 1 ? "" : "s"}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span className="r-add">
                      {expanding === a.id ? "adding…" : "+ add all"}
                    </span>
                  </button>
                </li>
              ))}
            </>
          )}
          {results && results.artists.length > 0 && (
            <>
              <li className="results-head">Artists</li>
              {results.artists.map((a) => (
                <li key={a.id}>
                  <button
                    className="result"
                    disabled={expanding != null || blocked}
                    onClick={() => void adder.addArtist(a.id, a.name)}
                  >
                    <span className="r-title">{a.name}</span>
                    <span className="r-add">
                      {expanding === a.id ? "adding…" : "+ top tracks"}
                    </span>
                  </button>
                </li>
              ))}
            </>
          )}
        </ul>
      )}
    </div>
  );
}
