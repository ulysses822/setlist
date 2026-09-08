import { fmtDuration } from "./format";
import { bareId } from "./metricsCalc";
import { type Doctor } from "./usePlaylistDoctor";

export interface IssuesStripProps {
  doctor: Doctor;
  /**
   * Spotify's rate limit is in force, so the replacement search can't run. Passed separately
   * from the doctor because it's the host's notion of the app being paused, not the
   * playlist's condition.
   */
  blocked: boolean;
}

/**
 * The per-playlist cleanup panel: what the doctor found, and a button for each fix.
 *
 * Collapsed to a one-line count until opened, because on a clean playlist it shouldn't be
 * there at all and on a messy one it is long. Every fix goes to the draft — nothing here
 * writes to Spotify, which is what makes it safe to offer one-click buttons for.
 *
 * The host decides whether to render it at all (it is hidden in diff mode, where the list on
 * screen is a comparison rather than something you can edit).
 */
export default function IssuesStrip({ doctor, blocked }: IssuesStripProps) {
  const { lint, count, open, toggle, replaceState } = doctor;

  return (
    <div className="issues-strip">
      <button className="issues-toggle" onClick={toggle}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="issues-label">
          ⚠ {count} cleanup issue{count > 1 ? "s" : ""}
        </span>
      </button>
      {open && (
        <div className="issues-body">
          {lint.exact.length > 0 && (
            <div className="issue-group">
              <div className="issue-group-head">
                <span>Exact duplicates</span>
                <button className="btn ghost small" onClick={doctor.fixExactDuplicates}>
                  Remove all duplicates
                </button>
              </div>
              {lint.exact.map((g) => (
                <div className="issue-row" key={g.key}>
                  <span className="issue-title">{g.occurrences[0].track.title}</span>
                  <span className="issue-meta">
                    {g.occurrences[0].track.artists.join(", ")} · appears {g.occurrences.length}×
                  </span>
                </div>
              ))}
            </div>
          )}
          {lint.isrc.length > 0 && (
            <div className="issue-group">
              <div className="issue-group-head">
                <span>Possible duplicates (same recording)</span>
              </div>
              {lint.isrc.map((g) => (
                <div className="issue-isrc" key={g.key}>
                  {g.occurrences.map((o) => (
                    <div className="isrc-variant" key={o.track.id}>
                      <span className="issue-title">{o.track.title}</span>
                      <span className="issue-meta">
                        {o.track.artists.join(", ")} · {fmtDuration(o.track.duration_ms)}
                      </span>
                      <button
                        className="btn ghost small"
                        onClick={() => doctor.keepIsrcVariant(g, bareId(o.track.id))}
                      >
                        Keep this
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {lint.unavailable.length > 0 && (
            <div className="issue-group">
              <div className="issue-group-head">
                <span>Unavailable tracks</span>
                <span className="hint">
                  greyed out on Spotify — find a near-identical playable swap
                </span>
              </div>
              {lint.unavailable.map(({ track: u, index }) => {
                const r = replaceState[u.id];
                return (
                  <div className="issue-unavail" key={`${u.id}-${index}`}>
                    <div className="issue-row">
                      <span className="issue-title">{u.title}</span>
                      <span className="issue-meta">
                        {u.artists.join(", ")} · {fmtDuration(u.duration_ms)}
                      </span>
                      <button
                        className="btn ghost small"
                        disabled={blocked || r === "loading"}
                        onClick={() => void doctor.findReplacement(u)}
                        title={
                          blocked
                            ? "Spotify search paused — rate-limited"
                            : "Look for a playable stand-in"
                        }
                      >
                        {r === "loading"
                          ? "Searching…"
                          : r || r === null
                          ? "Search again"
                          : "Find replacement"}
                      </button>
                    </div>
                    {r && r !== "loading" && (
                      <div className="replacement">
                        <span className="repl-arrow" aria-hidden>
                          ↳
                        </span>
                        <span className="issue-title">{r.title}</span>
                        <span className="issue-meta">
                          {r.artists.join(", ")} · {fmtDuration(r.duration_ms)} ·{" "}
                          {r.source === "library" ? `from "${r.playlist}"` : "from Spotify"}
                        </span>
                        <button
                          className="btn ghost small"
                          onClick={() => doctor.applyReplacement(index, r)}
                        >
                          Replace
                        </button>
                      </div>
                    )}
                    {r === null && (
                      <div className="replacement">
                        <span className="hint">No close playable match found.</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
