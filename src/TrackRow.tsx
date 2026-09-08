import { type Features, type TrackEntry } from "./api";
import { fmtDuration } from "./format";
import {
  FEATURE_LABEL,
  fmtFeature,
  isLocalTrack,
  type FeatureKey,
  type GoalDeviation,
  type Outlier,
} from "./metricsCalc";
import { type DiffStatus } from "./playlistDiff";

/// The drag payload a row writes when it is picked up, and the sidebar reads when a track is
/// dropped onto another playlist. Declared here because this is the only thing that writes it;
/// `Library` imports it for the drop target so the two can't disagree about the type.
export const TRACK_MIME = "application/x-setlist-track";

/// "normal" is the editable row. Anything else is a read-only diff row, styled by how the
/// track differs from the Spotify mirror.
export type RowStatus = DiffStatus | "normal";

export interface TrackRowProps {
  track: TrackEntry;
  status: RowStatus;
  /// Official position in the list, or null for a diff row that has none (a removed track).
  position: number | null;
  /// Index into the draft, for reorder and remove. -1 when the row isn't editable, which is
  /// safe because every path that uses it is behind `canReorder` or `editable`.
  index: number;

  /// Dragging is only offered in the official order — reordering a sorted view would move a
  /// track to a position the user isn't looking at.
  canReorder: boolean;
  /// This row is what a drag is currently hovering over.
  isDropTarget: boolean;

  isPlaying: boolean;
  /// Playing *and* not paused, which is what animates the equaliser rather than freezing it.
  playingActive: boolean;
  /// Briefly highlighted — the row was just jumped to from a song search.
  isFlashing: boolean;

  /// Audio features for this track, or undefined if none were found.
  feature: Features | undefined;
  /// Set when the track stands out from the playlist average. Suppressed while a goal is set,
  /// since the goal chips answer the same question against a target the user chose.
  outlier: Outlier | undefined;
  /// Dimensions this track misses the playlist's mood goal on, worst first.
  goalOff: GoalDeviation[] | undefined;
  /// A feature fetch for this track is still in flight, so an empty cell means "waiting"
  /// rather than "nothing to show".
  stillAnalyzing: boolean;

  metricsOpen: boolean;
  cols: FeatureKey[];

  /// Reorder. The row writes its own drag payload; the host only needs the index.
  onDragStart: (index: number) => void;
  onDragEnter: (index: number) => void;
  onDragLeave: (index: number) => void;
  onDropAt: (index: number) => void;
  onDragEnd: () => void;

  onPlay: (track: TrackEntry) => void;
  onRemove: (index: number) => void;
}

/// One row of the track list, in both modes. Editable (`status === "normal"`) it has the drag
/// grip and the remove button; in diff mode it is read-only with add/remove/move styling.
/// Every branch keeps the same grid cells, so the columns stay aligned between the two.
///
/// Deliberately presentational: every value it shows is computed by the host and handed over,
/// so the row itself holds no state and reads top to bottom. Not wrapped in `memo` — the
/// handlers below close over the draft and change on every edit anyway, so memoizing would
/// cost a comparison per row and skip nothing. Worth revisiting only alongside stable
/// callbacks, and only if a long playlist actually feels slow.
export default function TrackRow({
  track,
  status,
  position,
  index,
  canReorder,
  isDropTarget,
  isPlaying,
  playingActive,
  isFlashing,
  feature,
  outlier,
  goalOff,
  stillAnalyzing,
  metricsOpen,
  cols,
  onDragStart,
  onDragEnter,
  onDragLeave,
  onDropAt,
  onDragEnd,
  onPlay,
  onRemove,
}: TrackRowProps) {
  const editable = status === "normal";
  const removed = status === "removed";
  const local = isLocalTrack(track.id);
  const unavailable = track.is_playable === false; // greyed out on Spotify
  const diffClass = status !== "normal" && status !== "unchanged" ? `diff-${status}` : "";

  return (
    <li
      data-tid={track.id}
      className={`track ${metricsOpen ? "with-feats" : ""} ${outlier ? "has-outlier" : ""} ${
        isPlaying ? "playing" : ""
      } ${isPlaying && playingActive ? "playing-active" : ""} ${
        canReorder && isDropTarget ? "over" : ""
      } ${isFlashing ? "flash" : ""} ${unavailable ? "unavailable" : ""} ${diffClass}`}
      draggable={canReorder}
      onDragStart={
        canReorder
          ? (e) => {
              onDragStart(index);
              e.dataTransfer.effectAllowed = "copyMove";
              e.dataTransfer.setData("text/plain", String(index));
              e.dataTransfer.setData(TRACK_MIME, JSON.stringify(track));
            }
          : undefined
      }
      onDragOver={
        canReorder
          ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              onDragEnter(index);
            }
          : undefined
      }
      onDragLeave={canReorder ? () => onDragLeave(index) : undefined}
      onDrop={
        canReorder
          ? (e) => {
              e.preventDefault();
              onDropAt(index);
            }
          : undefined
      }
      onDragEnd={canReorder ? onDragEnd : undefined}
      onDoubleClick={() => (local || removed ? undefined : onPlay(track))}
    >
      {editable ? (
        canReorder ? (
          <span className="grip" title="Drag to reorder">
            ⋮⋮
          </span>
        ) : (
          <span />
        )
      ) : (
        <span className="diff-mark" aria-hidden>
          {status === "added" ? "+" : status === "removed" ? "−" : status === "moved" ? "↕" : ""}
        </span>
      )}
      <span className="t-num">
        {isPlaying ? (
          <span className="eq" aria-label="Now playing">
            <i />
            <i />
            <i />
          </span>
        ) : (
          position ?? ""
        )}
      </span>
      <span className="t-title">
        <span className="t-title-text">{track.title}</span>
        {local && (
          <span
            className="local-tag"
            title="Local file added on Spotify — playable only in the Spotify desktop app"
          >
            local
          </span>
        )}
        {unavailable && (
          <span
            className="unavail-tag"
            title="Greyed out on Spotify — unavailable in your region or removed. Can't be played by any Spotify client."
          >
            unavailable
          </span>
        )}
        {status === "added" && <span className="diff-badge add">added</span>}
        {status === "removed" && <span className="diff-badge rem">removing</span>}
        {status === "moved" && <span className="diff-badge move">moved</span>}
        {outlier && (
          <span
            className="outlier-chip"
            title={
              outlier.method === "multivariate"
                ? `Unusual combination of metrics for this playlist (distance ${outlier.z.toFixed(
                    1
                  )}, beyond the 95% envelope). Driven by: ${(outlier.contributors ?? [])
                    .map(
                      (c) =>
                        `${FEATURE_LABEL[c.feature]} ${c.dir === "up" ? "↑" : "↓"} (${Math.round(
                          c.share * 100
                        )}%)`
                    )
                    .join(", ")}`
                : `This song's ${FEATURE_LABEL[outlier.feature]} is well ${
                    outlier.dir === "up" ? "above" : "below"
                  } the playlist average (${Math.abs(outlier.z).toFixed(1)}σ)`
            }
          >
            {outlier.dir === "up" ? "▲" : "▼"} {FEATURE_LABEL[outlier.feature]}
            {outlier.method === "multivariate" && (outlier.contributors?.length ?? 0) > 1
              ? " +"
              : ""}
          </span>
        )}
        {goalOff?.slice(0, 3).map((d) => (
          <span
            key={d.feature}
            className="goal-chip"
            title={`${FEATURE_LABEL[d.feature]} is ${Math.round(
              Math.abs(d.diff) * 100
            )}% ${d.dir === "up" ? "above" : "below"} your goal`}
          >
            {d.dir === "up" ? "▲" : "▼"} {FEATURE_LABEL[d.feature]}
          </span>
        ))}
      </span>
      <span className="t-artists">{track.artists.join(", ")}</span>
      {metricsOpen && (
        <span className="t-feats">
          {cols.map((k, ci) => (
            <span key={k} className="t-feat">
              {feature ? fmtFeature(feature, k) : ci === 0 ? (stillAnalyzing ? "…" : "–") : ""}
            </span>
          ))}
        </span>
      )}
      <span className="t-dur">{fmtDuration(track.duration_ms)}</span>
      {removed ? (
        <span />
      ) : (
        <button
          className="t-play"
          title={
            local
              ? "Local file — playable only in the Spotify desktop app"
              : unavailable
              ? "Unavailable on Spotify — plays from the next available track"
              : "Play in Setlist"
          }
          disabled={local}
          onClick={() => onPlay(track)}
        >
          ▶
        </button>
      )}
      {editable ? (
        <button className="t-remove" title="Remove" onClick={() => onRemove(index)}>
          ×
        </button>
      ) : (
        <span />
      )}
    </li>
  );
}
