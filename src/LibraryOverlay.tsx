// The five library-wide panels that take over the editor pane, and the state that describes
// which one is showing.
//
// They used to be five independent `{x}Open` / `{x}Data` / `{x}Busy` triplets in Library, with
// each opener manually closing the other four. Fifteen booleans and states encoding one
// choice: adding a sixth panel meant editing five existing functions, and forgetting one line
// rendered two panels at once — a state the render could not express but the data could.
// One tagged union says which panel is open and carries exactly that panel's data, so the
// impossible states are gone and a new panel is one variant plus one arm.

import { useRef, useState } from "react";
import {
  api,
  type Features,
  type HistoryReport,
  type LocalPlaylist,
  type NamedPlaylist,
} from "./api";
import AllSongsView from "./AllSongsView";
import DoctorView from "./DoctorView";
import StaleView from "./StaleView";
import StatusView, { type DriftState } from "./StatusView";
import SimilarityView from "./SimilarityView";
import type { CrossDupGroup } from "./lint";
import { useRateLimit } from "./rateLimit";

export type OverlayKind = "songs" | "doctor" | "stale" | "status" | "similarity";

/**
 * Which panel is open, and the data it was loaded with. `null` fields mean "not loaded yet"
 * — paired with the `busy` prop, that's the panel's own spinner rather than an empty result.
 */
export type Overlay =
  | { kind: "songs"; data: NamedPlaylist[] | null }
  | { kind: "doctor"; data: NamedPlaylist[] | null }
  | { kind: "stale"; data: NamedPlaylist[] | null; history: HistoryReport | null }
  | { kind: "status"; local: LocalPlaylist[] | null; data: NamedPlaylist[] | null }
  | {
      kind: "similarity";
      data: NamedPlaylist[] | null;
      feat: Record<string, Features> | null;
    };

/**
 * The data-less form of a panel, shown while its loader runs so the panel appears at once
 * instead of after the round trip. Exhaustive by return type: a new `OverlayKind` without a
 * case here won't compile.
 */
export function emptyOverlay(kind: OverlayKind): Overlay {
  switch (kind) {
    case "songs":
      return { kind, data: null };
    case "doctor":
      return { kind, data: null };
    case "stale":
      return { kind, data: null, history: null };
    case "status":
      return { kind, local: null, data: null };
    case "similarity":
      return { kind, data: null, feat: null };
  }
}

export default function LibraryOverlay({
  overlay,
  busy,
  archived,
  onClose,
  onOpenPlaylist,
  onOpenTrack,
  onNormalize,
  onError,
}: {
  overlay: Overlay;
  /** True while the loader for `overlay.kind` is in flight. */
  busy: boolean;
  /** Files of the archived playlists, which the similarity map greys out. */
  archived: Set<string>;
  onClose: () => void;
  onOpenPlaylist: (file: string) => void;
  onOpenTrack: (file: string, trackId: string) => void;
  onNormalize: (group: CrossDupGroup, keepId: string) => void;
  /** Surface a failure in Library's status line — this component has no message area. */
  onError: (message: string) => void;
}) {
  // Drift results live here rather than in Library because the status panel is the only thing
  // that has them, and they're discarded when it closes. Library mounts this with a `key` of
  // the panel kind, so switching panels remounts and clears them — reopening Status always
  // starts from an unchecked list rather than showing last time's answers as if they were
  // current.
  const [driftMap, setDriftMap] = useState<Record<string, DriftState>>({});
  const [driftScan, setDriftScan] = useState<{ done: number; total: number } | null>(null);
  const cancelDrift = useRef(false);
  const { blocked } = useRateLimit();

  /**
   * Drop any in-flight "checking" marker so a stopped run doesn't leave a row spinning.
   * Returns the same object when there's nothing to clear, so React can skip the re-render.
   */
  function clearChecking() {
    setDriftMap((m) => {
      const stale = Object.keys(m).filter((k) => m[k] === "checking");
      if (stale.length === 0) return m;
      const next = { ...m };
      for (const k of stale) delete next[k];
      return next;
    });
  }

  // Check every remote playlist for drift, one cheap snapshot request at a time.
  //
  // This is the most expensive thing the app does on demand: one request per playlist,
  // paced by the backend's rate limiter, and each playlist that HAS drifted then costs a
  // full paginated track download to work out what changed. On a large library that is
  // minutes of work, so it reports progress and can be stopped — and results already in
  // hand are kept, so stopping (or hitting the rate limit) isn't wasted.
  async function checkAllDrift(local: LocalPlaylist[] | null) {
    const targets = (local ?? []).filter((p) => !p.archived && p.spotify_id !== "");
    if (targets.length === 0) return;
    cancelDrift.current = false;
    setDriftScan({ done: 0, total: targets.length });
    let done = 0;
    try {
      for (const p of targets) {
        if (cancelDrift.current) break;
        setDriftMap((m) => ({ ...m, [p.file]: "checking" }));
        const s = await api.syncStatus(p.file);
        setDriftMap((m) => ({ ...m, [p.file]: s.remote_changed ? "drifted" : "clean" }));
        setDriftScan({ done: ++done, total: targets.length });
      }
    } catch (e) {
      // Say how far it got: the checked playlists keep their results, and the rest are
      // simply unchecked rather than silently assumed clean.
      onError(`Drift check stopped after ${done} of ${targets.length} — ${e}`);
    } finally {
      clearChecking();
      setDriftScan(null);
    }
  }

  switch (overlay.kind) {
    case "songs":
      return (
        <AllSongsView
          data={overlay.data}
          busy={busy}
          onClose={onClose}
          onOpenTrack={onOpenTrack}
        />
      );
    case "doctor":
      return (
        <DoctorView
          data={overlay.data}
          busy={busy}
          onClose={onClose}
          onOpenPlaylist={onOpenPlaylist}
          onNormalize={onNormalize}
        />
      );
    case "stale":
      return (
        <StaleView
          data={overlay.data}
          history={overlay.history}
          busy={busy}
          onClose={onClose}
          onOpenTrack={onOpenTrack}
        />
      );
    case "status": {
      const { local } = overlay;
      return (
        <StatusView
          local={local}
          data={overlay.data}
          busy={busy}
          driftMap={driftMap}
          driftScan={driftScan}
          blocked={blocked}
          onCheckDrift={() => void checkAllDrift(local)}
          onCancelDrift={() => {
            cancelDrift.current = true;
          }}
          onClose={onClose}
          onOpenPlaylist={onOpenPlaylist}
        />
      );
    }
    case "similarity":
      return (
        <SimilarityView
          data={overlay.data}
          feat={overlay.feat}
          archived={archived}
          busy={busy}
          onClose={onClose}
          onOpenPlaylist={onOpenPlaylist}
        />
      );
  }
}
