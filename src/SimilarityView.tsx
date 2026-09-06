// Similarity map: a 2D PCA projection of every playlist's mean audio-feature vector, so
// playlists with similar metrics sit close together and dissimilar ones sit far apart.
// Distance is the whole point — features are standardized before projecting and both axes
// share one scale, so on-screen Euclidean distance reads as "how different these are".

import { useEffect, useMemo, useState } from "react";
import type { Features, NamedPlaylist } from "./api";
import {
  bareId,
  computeAggregates,
  FEATURE_LABEL,
  fitPca,
  PCA_MIN_ANALYZED,
  playlistVector,
  projectPca,
} from "./metricsCalc";
import type { PcaBasis } from "./metricsCalc";

type ColorBy = "none" | "valence" | "energy";

const W = 900;
const H = 520;
const PAD = 60;

// The frozen projection basis persists across edits/restarts so the map doesn't reshuffle every
// time a playlist changes; the user re-fits it deliberately with "Recalculate".
const BASIS_KEY = "setlist.simBasis";

// Dim slate → accent green, for the optional colour-by-feature encoding.
function heat(t: number): string {
  const a = [0x3a, 0x4a, 0x5c];
  const b = [0x1d, 0xb9, 0x54];
  const x = Math.max(0, Math.min(1, t));
  const c = a.map((av, i) => Math.round(av + (b[i] - av) * x));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// "energy ↑ · acousticness ↓" — the features that most define one axis, with direction.
function axisLabel(loadings: { feature: string; weight: number }[]): string {
  return loadings
    .slice(0, 3)
    .map((l) => `${FEATURE_LABEL[l.feature] ?? l.feature} ${l.weight >= 0 ? "↑" : "↓"}`)
    .join(" · ");
}

interface Entry {
  file: string;
  name: string;
  analyzed: number;
  total: number;
  vector: number[] | null;
  valence: number | null;
  energy: number | null;
}

export default function SimilarityView({
  data,
  feat,
  archived,
  busy,
  onClose,
  onOpenPlaylist,
}: {
  data: NamedPlaylist[] | null;
  /** bare-id → audio features, covering every track across all playlists. */
  feat: Record<string, Features> | null;
  /** Files of archived playlists, hidden from the map by default. */
  archived: Set<string>;
  busy: boolean;
  onClose: () => void;
  onOpenPlaylist: (file: string) => void;
}) {
  const [colorBy, setColorBy] = useState<ColorBy>("none");
  const [showArchived, setShowArchived] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  // The projection axes are frozen (loaded from localStorage) so the map only re-lays-out on an
  // explicit Recalculate. null until the first fit (or after a clear).
  const [basis, setBasis] = useState<PcaBasis | null>(() => {
    try {
      const raw = localStorage.getItem(BASIS_KEY);
      return raw ? (JSON.parse(raw) as PcaBasis) : null;
    } catch {
      return null;
    }
  });

  const archivedCount = useMemo(
    () => (data ?? []).filter((pl) => archived.has(pl.file)).length,
    [data, archived]
  );

  const entries = useMemo<Entry[]>(() => {
    const lookup = (id: string) => feat?.[bareId(id)];
    // Archived playlists aren't actively curated; hide them by default so the map (and its PCA
    // axes) reflect only live playlists. The "All" toggle brings them back when wanted.
    return (data ?? [])
      .filter((pl) => showArchived || !archived.has(pl.file))
      .map((pl) => {
        const agg = computeAggregates(pl.tracks, (t) => lookup(t.id));
        return {
          file: pl.file,
          name: pl.name,
          analyzed: agg.analyzed,
          total: agg.total,
          vector: playlistVector(agg),
          valence: agg.avg_valence,
          energy: agg.avg_energy,
        };
      });
  }, [data, feat, archived, showArchived]);

  const plottable = useMemo(
    () => entries.filter((e) => e.vector && e.analyzed >= PCA_MIN_ANALYZED),
    [entries]
  );
  const excluded = useMemo(
    () => entries.filter((e) => !(e.vector && e.analyzed >= PCA_MIN_ANALYZED)),
    [entries]
  );

  // Re-fit the axes from the current playlists and persist them. Called once automatically when
  // there's no frozen basis yet, and on demand from the Recalculate button.
  function refit() {
    if (plottable.length < 3) return;
    const fitted = fitPca(plottable.map((e) => e.vector as number[]));
    if (!fitted) return;
    setBasis(fitted);
    try {
      localStorage.setItem(BASIS_KEY, JSON.stringify(fitted));
    } catch {
      /* localStorage full/unavailable — the map still works for this session. */
    }
  }

  // First-ever open (or after the saved basis is cleared): fit once so there's a map to show.
  useEffect(() => {
    if (!basis && plottable.length >= 3) refit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basis, plottable]);

  // Place each playlist by projecting it through the frozen basis. Because the basis (axes +
  // canvas bounds) is fixed, editing a playlist moves only its own dot rather than reshuffling
  // the whole map; Recalculate is what re-lays it out.
  const placed = useMemo(() => {
    if (!basis) return null;
    const pts = plottable.map((e) => {
      const { x, y } = projectPca(basis, e.vector as number[]);
      return {
        ...e,
        cx: PAD + x * (W - 2 * PAD),
        cy: H - PAD - y * (H - 2 * PAD), // higher PC2 = higher on screen
      };
    });
    // Label de-collision by displacement so EVERY label is printed: each starts beside its
    // dot, then overlapping labels are nudged apart along their least-overlap axis while a weak
    // spring keeps them near their dot. A leader line links any label that ends up displaced.
    const L = pts.map((p) => {
      const w = p.name.length * 5.7 + 6;
      // Dots near the right edge label to the LEFT so the text never clamps back across the
      // dot; everyone else labels to the right of their dot.
      const flip = p.cx + 12 + w > W - 4;
      const ax = flip ? p.cx - 9 - w / 2 : p.cx + 9 + w / 2;
      return { w, h: 14, flip, ax, ay: p.cy, cx: ax, cy: p.cy };
    });
    for (let iter = 0; iter < 90; iter++) {
      for (let a = 0; a < L.length; a++) {
        for (let b = a + 1; b < L.length; b++) {
          const A = L[a];
          const B = L[b];
          const dx = B.cx - A.cx;
          const dy = B.cy - A.cy;
          const ox = (A.w + B.w) / 2 - Math.abs(dx);
          const oy = (A.h + B.h) / 2 - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            if (ox < oy) {
              const s = (dx < 0 ? -1 : 1) * (ox / 2 + 0.4);
              A.cx -= s;
              B.cx += s;
            } else {
              const s = (dy < 0 ? -1 : 1) * (oy / 2 + 0.4);
              A.cy -= s;
              B.cy += s;
            }
          }
        }
      }
      for (const l of L) {
        l.cx += 0.06 * (l.ax - l.cx); // weak pull back toward the dot
        l.cy += 0.06 * (l.ay - l.cy);
        l.cx = Math.max(l.w / 2, Math.min(W - l.w / 2, l.cx));
        l.cy = Math.max(l.h / 2, Math.min(H - l.h / 2, l.cy));
      }
    }
    return pts.map((p, i) => {
      const l = L[i];
      if (l.flip) {
        const right = l.cx + l.w / 2;
        const gap = Math.hypot(right - p.cx, l.cy - p.cy);
        return {
          ...p,
          lx: right - 3,
          ly: l.cy + 4,
          anchorEnd: true,
          leader: gap > 16 ? { x2: right + 2, y2: l.cy } : null,
        };
      }
      const left = l.cx - l.w / 2;
      const gap = Math.hypot(left - p.cx, l.cy - p.cy);
      return {
        ...p,
        lx: left + 3,
        ly: l.cy + 4,
        anchorEnd: false,
        leader: gap > 16 ? { x2: left - 2, y2: l.cy } : null,
      };
    });
  }, [basis, plottable]);

  return (
    <div className="doctor library-view similarity-view">
      <header className="doctor-head">
        <div>
          <h2>Similarity map</h2>
          <p className="hint">
            {busy
              ? "Analyzing your library…"
              : placed && basis
              ? `Captures ${Math.round(basis.varExplained * 100)}% of the variation across ${
                  placed.length
                } playlists. Closer = more similar. Axes stay fixed — Recalculate to re-fit.`
              : "A 2D map of how your playlists' audio profiles relate."}
          </p>
        </div>
        <div className="row">
          {archivedCount > 0 && (
            <div className="lib-sort" title="Show or hide archived playlists">
              {(
                [
                  [false, "Live"],
                  [true, "All"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={label}
                  className={`seg ${showArchived === k ? "active" : ""}`}
                  onClick={() => setShowArchived(k)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {placed && (
            <div className="lib-sort" title="Shade each playlist by a feature">
              {(
                [
                  ["none", "Plain"],
                  ["valence", "Valence"],
                  ["energy", "Energy"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={`seg ${colorBy === k ? "active" : ""}`}
                  onClick={() => setColorBy(k)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {placed && (
            <button
              className="btn ghost"
              onClick={refit}
              title="Re-fit the axes to your current playlists. The map is otherwise frozen so edits don't reshuffle it."
            >
              Recalculate
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      {busy ? (
        <p className="hint pad">Loading features for every playlist…</p>
      ) : !placed || !basis ? (
        <p className="hint pad">
          {entries.length === 0
            ? "No playlists yet — pull some first."
            : `Need at least 3 playlists with ${PCA_MIN_ANALYZED}+ analyzed tracks to draw a map. ` +
              "Open a few playlists so their audio features get analyzed, then come back."}
        </p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="simmap" role="img">
            <title>Playlist similarity map</title>
            {/* faint origin crosshairs for orientation */}
            <line className="simmap-axis" x1={PAD / 2} y1={H / 2} x2={W - PAD / 2} y2={H / 2} />
            <line className="simmap-axis" x1={W / 2} y1={PAD / 2} x2={W / 2} y2={H - PAD / 2} />
            {placed.map((p) => {
              const val = colorBy === "valence" ? p.valence : colorBy === "energy" ? p.energy : null;
              const fill = colorBy === "none" || val == null ? "var(--accent)" : heat(val);
              const isHot = hovered === p.file;
              return (
                <g
                  key={p.file}
                  className={`simmap-pt ${isHot ? "hot" : ""}`}
                  onMouseEnter={() => setHovered(p.file)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => onOpenPlaylist(p.file)}
                >
                  <title>{`${p.name} — ${p.analyzed}/${p.total} analyzed`}</title>
                  {p.leader && (
                    <line
                      className="simmap-leader"
                      x1={p.cx}
                      y1={p.cy}
                      x2={p.leader.x2}
                      y2={p.leader.y2}
                    />
                  )}
                  <circle cx={p.cx} cy={p.cy} r={isHot ? 7 : 5} fill={fill} />
                  <text
                    className="simmap-label"
                    x={p.lx}
                    y={p.ly}
                    textAnchor={p.anchorEnd ? "end" : "start"}
                  >
                    {p.name}
                  </text>
                </g>
              );
            })}
          </svg>

          <div className="simmap-axes-key">
            <span>
              <strong>Horizontal:</strong> {axisLabel(basis.axes.pc1)}
            </span>
            <span>
              <strong>Vertical:</strong> {axisLabel(basis.axes.pc2)}
            </span>
          </div>

          {excluded.length > 0 && (
            <p className="hint pad">
              Not enough analyzed tracks to place:{" "}
              {excluded.map((e) => e.name).join(", ")}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
