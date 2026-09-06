// Library-wide cleanup ("doctor") view: per-playlist lint findings (duplicate and
// unavailable tracks) plus cross-playlist same-recording variants, with one-click
// normalization. Pure presentation over the scan data — fixes are applied by Library
// (they stage edits and need the editor's state).

import { useMemo } from "react";
import type { NamedPlaylist } from "./api";
import {
  crossPlaylistIsrcDuplicates,
  issueCount,
  lintPlaylist,
  type CrossDupGroup,
} from "./lint";
import { bareId } from "./metricsCalc";

export default function DoctorView({
  data,
  busy,
  onClose,
  onOpenPlaylist,
  onNormalize,
}: {
  data: NamedPlaylist[] | null;
  busy: boolean;
  onClose: () => void;
  onOpenPlaylist: (file: string) => void;
  /** Keep `keepId` and replace the other variants of the group everywhere they appear. */
  onNormalize: (group: CrossDupGroup, keepId: string) => void;
}) {
  const { findings, cross, totalIssues } = useMemo(() => {
    const findings = (data ?? [])
      .map((p) => ({ p, lint: lintPlaylist(p.tracks) }))
      .filter((x) => issueCount(x.lint) > 0);
    const cross = crossPlaylistIsrcDuplicates(data ?? []);
    const totalIssues = findings.reduce((n, f) => n + issueCount(f.lint), 0);
    return { findings, cross, totalIssues };
  }, [data]);

  return (
    <div className="doctor">
      <header className="doctor-head">
        <div>
          <h2>Cleanup</h2>
          <p className="hint">
            Duplicate and unavailable tracks across your library. Fixes are staged so you can
            review them in each playlist's diff before pushing.
          </p>
        </div>
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </header>
      {busy ? (
        <p className="hint pad">Scanning your library…</p>
      ) : findings.length === 0 && cross.length === 0 ? (
        <p className="hint pad">No issues found — your library is clean. ✨</p>
      ) : (
        <>
          {cross.length > 0 && (
            <div className="doctor-section">
              <h3>Same recording in multiple places</h3>
              <p className="hint">
                One recording (matching ISRC) saved under different track ids. Keep one to
                replace the others everywhere they appear.
              </p>
              <div className="doctor-list">
                {cross.map((g) => (
                  <div className="doctor-item" key={g.isrc}>
                    <div className="doctor-item-head">
                      <span className="di-name">{g.title}</span>
                      <span className="di-meta">{g.artists.join(", ")}</span>
                    </div>
                    <div className="cross-variants">
                      {g.variants.map((v) => (
                        <div className="cross-variant" key={v.id}>
                          <div className="cv-info">
                            <span className="cv-where">
                              in {v.locations.map((l) => l.name).join(", ")}
                            </span>
                            <span className="cv-id">{bareId(v.id)}</span>
                          </div>
                          <button
                            className="btn ghost small"
                            onClick={() => onNormalize(g, v.id)}
                            title="Keep this id and replace the other variants everywhere"
                          >
                            Keep this
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {findings.length > 0 && (
            <div className="doctor-section">
              <h3>Issues within a playlist</h3>
              <p className="hint">
                {totalIssues} issue{totalIssues > 1 ? "s" : ""} across {findings.length} playlist
                {findings.length > 1 ? "s" : ""}
              </p>
              <div className="doctor-list">
                {findings.map(({ p, lint: pl }) => (
                  <div className="doctor-item" key={p.file}>
                    <div className="doctor-item-head">
                      <span className="di-name">{p.name}</span>
                      <span className="di-counts">
                        {pl.exact.length > 0 && (
                          <span className="cs-rem">{pl.exact.length} duplicate</span>
                        )}
                        {pl.isrc.length > 0 && (
                          <span className="cs-move">{pl.isrc.length} near-dup</span>
                        )}
                        {pl.unavailable.length > 0 && (
                          <span className="cs-rem">{pl.unavailable.length} unavailable</span>
                        )}
                      </span>
                      <button
                        className="btn ghost small"
                        onClick={() => onOpenPlaylist(p.file)}
                        title="Open this playlist to fix the issues"
                      >
                        Open
                      </button>
                    </div>
                    <div className="doctor-item-detail">
                      {pl.exact.slice(0, 5).map((g) => (
                        <div className="di-row" key={`e-${g.key}`}>
                          <span className="di-title">{g.occurrences[0].track.title}</span>
                          <span className="di-meta">
                            {g.occurrences[0].track.artists.join(", ")} · appears{" "}
                            {g.occurrences.length}×
                          </span>
                        </div>
                      ))}
                      {pl.isrc.slice(0, 5).map((g) => (
                        <div className="di-row" key={`i-${g.key}`}>
                          <span className="di-title">{g.occurrences[0].track.title}</span>
                          <span className="di-meta">
                            same recording · {g.occurrences.length} releases
                          </span>
                        </div>
                      ))}
                      {pl.unavailable.slice(0, 5).map(({ track }) => (
                        <div className="di-row" key={`u-${track.id}`}>
                          <span className="di-title">{track.title}</span>
                          <span className="di-meta">
                            {track.artists.join(", ")} · unavailable
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
