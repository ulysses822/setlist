// The mood-fingerprint radar + average bars. Also hosts the optional per-playlist "goal":
// drag the bars to set target values, shown as a marker on each bar and a dashed overlay on
// the radar. Off-goal tracks are flagged in the track list (see Library).

import { useRef } from "react";
import type { Aggregates } from "./api";
import { MIN_FOR_MULTI, type Goal, type GoalDim, type OutlierMode } from "./metricsCalc";

export function pct(v: number | null): string {
  return v == null ? "–" : `${Math.round(v * 100)}%`;
}

// Outlier-method toggle. `effective` is the method that actually ran — multivariate
// silently falls back to per-metric when too few tracks are analyzed.
export interface OutlierControl {
  mode: OutlierMode;
  effective: OutlierMode;
  setMode: (mode: OutlierMode) => void;
}

// Everything the panel needs to read and edit the goal. Supplied by Library, which owns the
// state and persistence.
export interface GoalControl {
  goal: Goal | null;
  editing: boolean;
  start: () => void; // create a goal (seeded from current averages) and enter edit mode
  edit: () => void; // re-enter edit mode
  done: () => void; // leave edit mode
  clear: () => void; // remove the goal
  setDim: (dim: GoalDim, value: number) => void;
}

// One source of truth for the seven mood dimensions: radar label, bar label, the goal key,
// a plain-English tooltip, and where the average comes from. Order matches GOAL_DIMS.
const ROWS: {
  key: GoalDim;
  radar: string;
  bar: string;
  desc: string;
  value: (a: Aggregates) => number | null;
}[] = [
  { key: "valence", radar: "Valence", bar: "Valence", desc: "How positive or upbeat the music sounds", value: (a) => a.avg_valence },
  { key: "energy", radar: "Energy", bar: "Energy", desc: "How loud, fast and intense the track feels", value: (a) => a.avg_energy },
  { key: "danceability", radar: "Dance", bar: "Danceability", desc: "How easy the track is to dance to", value: (a) => a.avg_danceability },
  { key: "acousticness", radar: "Acoustic", bar: "Acousticness", desc: "How acoustic rather than electronic it sounds", value: (a) => a.avg_acousticness },
  { key: "instrumentalness", radar: "Instrum", bar: "Instrumentalness", desc: "How likely the track has no vocals", value: (a) => a.avg_instrumentalness },
  { key: "liveness", radar: "Live", bar: "Liveness", desc: "How likely it was recorded with a live audience", value: (a) => a.avg_liveness },
  { key: "speechiness", radar: "Speech", bar: "Speechiness", desc: "How much spoken word the track contains", value: (a) => a.avg_speechiness },
];

function Bar({
  label,
  value,
  title,
  goal,
  editing,
  onGoal,
}: {
  label: string;
  value: number | null;
  title: string;
  goal: number | null;
  editing: boolean;
  onGoal?: (v: number) => void;
}) {
  const trackRef = useRef<HTMLSpanElement>(null);
  const setFrom = (clientX: number) => {
    const el = trackRef.current;
    if (!el || !onGoal) return;
    const rect = el.getBoundingClientRect();
    onGoal(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
  };
  return (
    <div className="metric-bar">
      <span className="mb-label" title={title}>
        {label}
      </span>
      <span
        ref={trackRef}
        className={`mb-track ${editing ? "editable" : ""}`}
        onPointerDown={
          editing
            ? (e) => {
                e.currentTarget.setPointerCapture?.(e.pointerId);
                setFrom(e.clientX);
              }
            : undefined
        }
        onPointerMove={editing ? (e) => e.buttons & 1 && setFrom(e.clientX) : undefined}
      >
        <span className="mb-fill" style={{ width: `${(value ?? 0) * 100}%` }} />
        {goal != null && (
          <span className="mb-goal" style={{ left: `${goal * 100}%` }} title={`Goal: ${pct(goal)}`} />
        )}
      </span>
      <span className="mb-val">{editing && goal != null ? pct(goal) : pct(value)}</span>
    </div>
  );
}

function Radar({
  data,
  goalData,
}: {
  data: { label: string; value: number; title: string }[];
  goalData?: number[];
}) {
  const size = 300; // canvas with margin so labels never clip
  const c = size / 2;
  const r = 92; // chart radius
  const n = data.length;
  const round = (x: number) => Math.round(x * 10) / 10;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const ang = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pt = (i: number, v: number): [number, number] => [
    round(c + r * v * Math.cos(ang(i))),
    round(c + r * v * Math.sin(ang(i))),
  ];
  const poly = data.map((d, i) => pt(i, clamp01(d.value)).join(",")).join(" ");
  const goalPoly = goalData
    ? goalData.map((v, i) => pt(i, clamp01(v)).join(",")).join(" ")
    : null;
  const rings = [0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="radar">
      {rings.map((ring) => (
        <polygon
          key={ring}
          className="radar-grid"
          points={data.map((_, i) => pt(i, ring).join(",")).join(" ")}
        />
      ))}
      {data.map((_, i) => {
        const [x, y] = pt(i, 1);
        return <line key={i} className="radar-axis" x1={c} y1={c} x2={x} y2={y} />;
      })}
      <polygon className="radar-area" points={poly} />
      {goalPoly && <polygon className="radar-goal" points={goalPoly} />}
      {data.map((d, i) => {
        const lr = r + 18;
        const x = round(c + lr * Math.cos(ang(i)));
        const y = round(c + lr * Math.sin(ang(i)));
        const anchor = x < c - 2 ? "end" : x > c + 2 ? "start" : "middle";
        return (
          <text
            key={i}
            className="radar-label"
            x={x}
            y={y}
            textAnchor={anchor}
            dominantBaseline="middle"
          >
            <title>{d.title}</title>
            {d.label}
          </text>
        );
      })}
    </svg>
  );
}

export default function MetricsPanel({
  agg,
  loading = false,
  slowLoad = false,
  goal,
  outlierCtl,
}: {
  agg: Aggregates;
  loading?: boolean;
  slowLoad?: boolean;
  goal?: GoalControl;
  outlierCtl?: OutlierControl;
}) {
  if (agg.analyzed === 0) {
    // While loading, suppress the "no features" message (it would flash before the radar).
    // The "Analyzing…" note only shows once the load is genuinely slow (slowLoad, >0.5s).
    if (loading) {
      return slowLoad ? <p className="hint pad">Analyzing audio features…</p> : null;
    }
    return (
      <p className="hint pad">
        No audio features for these tracks yet. Setlist pulls them from ReccoBeats, which
        doesn't cover everything — newly released, obscure, and classical or instrumental
        tracks are often missing. Setlist will check again automatically in about a week, in
        case they've since been added.
      </p>
    );
  }
  const radar = ROWS.map((r) => ({
    label: r.radar,
    value: r.value(agg) ?? 0,
    title: r.desc,
  }));
  const target = goal?.goal ?? null;
  const goalData = target ? ROWS.map((r) => target[r.key]) : undefined;
  return (
    <div className="metrics-grid">
      <div className="radar-wrap">
        <Radar data={radar} goalData={goalData} />
        <p className="hint" style={{ textAlign: "center" }}>
          Playlist mood fingerprint{target ? " vs goal" : ""}
        </p>
      </div>
      <div className="bars">
        {goal && (
          <div className="goal-tools">
            {target ? (
              <>
                <span className="hint">
                  {goal.editing ? "Drag the bars to set your goal" : "Goal set"}
                </span>
                <span className="goal-actions">
                  {goal.editing ? (
                    <button className="btn ghost small" onClick={goal.done}>
                      Done
                    </button>
                  ) : (
                    <button className="btn ghost small" onClick={goal.edit}>
                      Edit goal
                    </button>
                  )}
                  <button className="btn ghost small" onClick={goal.clear}>
                    Clear
                  </button>
                </span>
              </>
            ) : (
              <button className="btn ghost small" onClick={goal.start}>
                Set a mood goal
              </button>
            )}
          </div>
        )}
        {ROWS.map((r) => (
          <Bar
            key={r.bar}
            label={r.bar}
            value={r.value(agg)}
            title={r.desc}
            goal={target ? target[r.key] : null}
            editing={!!(target && goal?.editing)}
            onGoal={target && goal?.editing ? (v) => goal.setDim(r.key, v) : undefined}
          />
        ))}
        {/* Outlier-method toggle. Hidden while a goal is set: goal deviations replace
            norm-based outlier flags entirely, so the method choice has no effect then. */}
        {outlierCtl && !target && (
          <div className="outlier-tools">
            <span className="hint">Outliers:</span>
            <span className="method-seg" role="group" aria-label="Outlier detection method">
              <button
                className={outlierCtl.mode === "independent" ? "on" : ""}
                onClick={() => outlierCtl.setMode("independent")}
                title="Each metric on its own: flag songs more than 2σ from the playlist average on any single metric"
              >
                Per-metric
              </button>
              <button
                className={outlierCtl.mode === "multivariate" ? "on" : ""}
                onClick={() => outlierCtl.setMode("multivariate")}
                title="All metrics jointly: flag songs whose combination of metrics is unusual for this playlist (Mahalanobis distance), even if no single metric stands out"
              >
                Combined
              </button>
            </span>
            {outlierCtl.mode === "multivariate" &&
              outlierCtl.effective === "independent" && (
                <span className="hint">
                  needs ≥{MIN_FOR_MULTI} analyzed tracks — using per-metric
                </span>
              )}
          </div>
        )}
      </div>
    </div>
  );
}
