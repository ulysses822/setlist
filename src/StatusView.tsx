// Global status dashboard: a "git status across all playlists" overview. One row per
// playlist with badges for unpushed edits, drift (Spotify changed under you), and lint
// issues (duplicates / unavailable tracks). A launcher, not a dead-end report — every row
// opens that playlist in the editor.
//
// Two passes with very different costs:
//   • Local pass (free, no network): unpushed edits come from LocalPlaylist.modified; lint
//     counts are computed here from the effective track lists. Renders immediately on open.
//   • Drift pass (online, opt-in): "Check for drift" runs one cheap snapshot check per
//     playlist via sync_status — so it's a button, not automatic, and fills rows as it goes.

import { useMemo } from "react";
import type { LocalPlaylist, NamedPlaylist } from "./api";
import { issueCount, lintPlaylist } from "./lint";

export type DriftState = "checking" | "drifted" | "clean";

interface Row {
  file: string;
  name: string;
  trackCount: number;
  hasRemote: boolean;
  unpushed: boolean;
  issues: number; // distinct issue groups (dup groups + unavailable)
  redundant: number; // suggested removals across dup groups
  unavailable: number;
}

export default function StatusView({
  local,
  data,
  busy,
  driftMap,
  driftScan,
  blocked,
  onCheckDrift,
  onCancelDrift,
  onClose,
  onOpenPlaylist,
}: {
  local: LocalPlaylist[] | null;
  data: NamedPlaylist[] | null;
  busy: boolean;
  /** Per-file drift result, filled progressively by the drift check. */
  driftMap: Record<string, DriftState>;
  /** Progress of a running drift check, or null when none is running. One request per
   *  playlist, so on a large library this is a long job the user needs to see and stop. */
  driftScan: { done: number; total: number } | null;
  /** Spotify's rate limit is in force — a drift check would only fail and extend it. */
  blocked: boolean;
  onCheckDrift: () => void;
  onCancelDrift: () => void;
  onClose: () => void;
  /** Open a playlist in the editor. */
  onOpenPlaylist: (file: string) => void;
}) {
  // Effective track lists keyed by file, so lint joins onto the playlist list.
  const tracksByFile = useMemo(() => {
    const m = new Map<string, NamedPlaylist["tracks"]>();
    for (const p of data ?? []) m.set(p.file, p.tracks);
    return m;
  }, [data]);

  const rows = useMemo<Row[]>(() => {
    // Archived playlists aren't actively curated — leave them out of the overview.
    const active = (local ?? []).filter((p) => !p.archived);
    const built = active.map((p) => {
      const tracks = tracksByFile.get(p.file);
      const lint = tracks ? lintPlaylist(tracks) : null;
      return {
        file: p.file,
        name: p.name,
        trackCount: p.track_count,
        hasRemote: p.spotify_id !== "",
        unpushed: p.modified,
        issues: lint ? issueCount(lint) : 0,
        redundant: lint ? lint.redundant : 0,
        unavailable: lint ? lint.unavailable.length : 0,
      };
    });
    // Surface playlists that need attention first: drifted, then unpushed, then with issues,
    // then alphabetical. Drift is only known after the check has run.
    const attention = (r: Row) =>
      (driftMap[r.file] === "drifted" ? 4 : 0) +
      (r.unpushed ? 2 : 0) +
      (r.issues > 0 ? 1 : 0);
    return built.sort(
      (a, b) =>
        attention(b) - attention(a) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
  }, [local, tracksByFile, driftMap]);

  const driftChecked = Object.keys(driftMap).length > 0;
  const counts = useMemo(() => {
    const drifted = rows.filter((r) => driftMap[r.file] === "drifted").length;
    const unpushed = rows.filter((r) => r.unpushed).length;
    const withIssues = rows.filter((r) => r.issues > 0).length;
    return { drifted, unpushed, withIssues };
  }, [rows, driftMap]);

  // Anything still worth checking for drift (skip local-only playlists with no remote).
  const remoteCount = rows.filter((r) => r.hasRemote).length;

  return (
    <div className="doctor library-view status-view">
      <header className="doctor-head">
        <div>
          <h2>Status</h2>
          <p className="hint">
            {busy
              ? "Reading your playlists…"
              : rows.length === 0
              ? "No playlists yet — pull some first."
              : [
                  driftChecked
                    ? `${counts.drifted} drifted`
                    : "drift not checked",
                  `${counts.unpushed} unpushed`,
                  `${counts.withIssues} with issues`,
                ].join(" · ")}
          </p>
        </div>
        <div className="row">
          <button
            className="btn ghost"
            onClick={onCheckDrift}
            disabled={busy || driftScan !== null || blocked || remoteCount === 0}
            title={
              blocked
                ? "Paused — Spotify's rate limit is in force"
                : `Check each playlist against Spotify (${remoteCount} lightweight request${
                    remoteCount === 1 ? "" : "s"
                  }, one per playlist)`
            }
          >
            {driftScan
              ? `Checking ${driftScan.done} of ${driftScan.total}…`
              : driftChecked
              ? "Re-check drift"
              : `Check for drift (${remoteCount})`}
          </button>
          {driftScan && (
            <button className="btn ghost" onClick={onCancelDrift} title="Stop after the request in flight">
              Cancel
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      {busy ? (
        <p className="hint pad">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="hint pad">
          Nothing to show yet. Pull your playlists from <strong>Setup</strong>, then come
          back here for a library-wide overview.
        </p>
      ) : (
        <table className="status-table">
          <thead>
            <tr>
              <th>Playlist</th>
              <th className="num">Tracks</th>
              <th>State</th>
              <th>Issues</th>
              <th>Drift</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const drift = driftMap[r.file];
              return (
                <tr key={r.file}>
                  <td>
                    <button
                      className="status-name"
                      onClick={() => onOpenPlaylist(r.file)}
                      title="Open in the editor"
                    >
                      {r.name}
                    </button>
                  </td>
                  <td className="num">{r.trackCount}</td>
                  <td>
                    {r.unpushed ? (
                      <span className="status-badge unpushed" title="Saved edits not pushed to Spotify">
                        Unpushed
                      </span>
                    ) : (
                      <span className="status-badge clean">Clean</span>
                    )}
                  </td>
                  <td>
                    {r.issues === 0 ? (
                      <span className="status-muted">—</span>
                    ) : (
                      <button
                        className="status-badge issues"
                        onClick={() => onOpenPlaylist(r.file)}
                        title="Open the editor to review and clean these up"
                      >
                        {[
                          r.redundant > 0 ? `${r.redundant} dup` : null,
                          r.unavailable > 0 ? `${r.unavailable} unavailable` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </button>
                    )}
                  </td>
                  <td>
                    {!r.hasRemote ? (
                      <span className="status-muted" title="Created locally — not on Spotify yet">
                        local
                      </span>
                    ) : drift === "checking" ? (
                      <span className="status-muted">checking…</span>
                    ) : drift === "drifted" ? (
                      <button
                        className="status-badge drifted"
                        onClick={() => onOpenPlaylist(r.file)}
                        title="Spotify changed since your last sync — open to review"
                      >
                        Drifted
                      </button>
                    ) : drift === "clean" ? (
                      <span className="status-badge clean">In sync</span>
                    ) : (
                      <span className="status-muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
