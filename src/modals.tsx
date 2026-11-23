// Library's dialogs, extracted as plain presentational components. Create/Delete own
// their input state; the actions (and their async/busy state) stay in Library.

import { useEffect, useState } from "react";
import type { LocalPlaylist, SyncStatus } from "./api";

/**
 * Generic confirm dialog (in-app replacement for window.confirm). Enter confirms,
 * Escape cancels; clicking the backdrop cancels.
 */
export function ConfirmModal({
  message,
  confirmLabel,
  onResolve,
}: {
  message: string;
  confirmLabel: string;
  onResolve: (ok: boolean) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onResolve(false);
      else if (e.key === "Enter") onResolve(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onResolve]);
  return (
    <div className="modal-overlay" onClick={() => onResolve(false)}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-msg">{message}</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => onResolve(true)} autoFocus>
            {confirmLabel}
          </button>
          <button className="btn ghost" onClick={() => onResolve(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function CreatePlaylistModal({
  creating,
  onCreate,
  onClose,
}: {
  creating: boolean;
  onCreate: (name: string, description: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const canCreate = !creating && name.trim() !== "";
  return (
    <div className="modal-overlay" onClick={() => !creating && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New playlist</h3>
        <label className="field">
          <span>Name</span>
          <input
            name="new-playlist-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate) onCreate(name, desc);
            }}
            placeholder="Playlist name"
            autoFocus
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>Description (optional)</span>
          <input
            name="new-playlist-description"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder=""
          />
        </label>
        <p className="hint">
          Creates an empty playlist here. It reaches Spotify, as a private playlist, the first
          time you push it.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={() => onCreate(name, desc)} disabled={!canCreate}>
            {creating ? "Creating…" : "Create"}
          </button>
          <button className="btn ghost" onClick={onClose} disabled={creating}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Pick a playlist to merge into the open one. Read-only on what it lists: the merge appends
 * to the *open* playlist's draft, and the playlist picked here is left exactly as it was.
 */
export function MergePlaylistModal({
  playlists,
  busy,
  onMerge,
  onClose,
}: {
  /** Candidates, with the open playlist already excluded by the caller. */
  playlists: LocalPlaylist[];
  busy: boolean;
  onMerge: (source: LocalPlaylist) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const shown = q ? playlists.filter((p) => p.name.toLowerCase().includes(q)) : playlists;
  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Merge a playlist in</h3>
        <p className="hint">
          Its songs are appended here, skipping any already in this playlist. Nothing is
          removed from the playlist you pick, and nothing reaches Spotify until you push.
        </p>
        <input
          className="filter"
          name="merge-filter"
          aria-label="Filter playlists"
          placeholder="Filter playlists…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
          spellCheck={false}
        />
        {shown.length === 0 ? (
          <p className="hint pad">
            {playlists.length === 0
              ? "There's no other playlist to merge in yet."
              : "No playlist matches that."}
          </p>
        ) : (
          <ul className="merge-list">
            {shown.map((p) => (
              <li key={p.file}>
                <button className="merge-item" onClick={() => onMerge(p)} disabled={busy}>
                  <span className="mi-name">{p.name}</span>
                  {p.archived && <span className="mi-tag">archived</span>}
                  <span className="mi-count">
                    {p.track_count} song{p.track_count === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// Normalize a name for the delete confirmation: strip accents/diacritics and case so
// "Cafe" matches "Café". (NFD splits accented letters into base + combining mark; we drop
// the marks.)
function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

export function DeletePlaylistModal({
  target,
  deleting,
  onDelete,
  onClose,
}: {
  target: LocalPlaylist;
  deleting: boolean;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  return (
    <div className="modal-overlay" onClick={() => !deleting && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Delete playlist</h3>
        <p className="confirm-msg">
          This unfollows <b>{target.name}</b> on Spotify (removing it from your library) and
          deletes it from Setlist, including any unpushed edits. You can only get it back by
          pulling it again.
        </p>
        <p className="hint">
          Type the playlist name to confirm: <b>{target.name}</b>
        </p>
        <input
          className="filter"
          name="delete-confirm-name"
          aria-label="Type the playlist name to confirm deletion"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={target.name}
          autoFocus
          spellCheck={false}
        />
        <div className="modal-actions">
          <button
            className="btn danger"
            onClick={onDelete}
            disabled={deleting || normalizeName(input) !== normalizeName(target.name)}
          >
            {deleting ? "Deleting…" : "Delete playlist"}
          </button>
          <button className="btn ghost" onClick={onClose} disabled={deleting}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConflictModal({
  conflict,
  onMerge,
  onOverwrite,
  onClose,
}: {
  conflict: SyncStatus;
  onMerge: () => void;
  onOverwrite: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Spotify changed since your last sync</h3>
        <p className="hint">
          Pushing your version as-is would drop changes made on Spotify. Choose how to
          resolve:
        </p>
        {conflict.remote_added.length > 0 && (
          <div className="conflict-group">
            <div className="cg-title">
              Added on Spotify ({conflict.remote_added.length}) — lost if you overwrite:
            </div>
            <ul>
              {conflict.remote_added.slice(0, 8).map((t) => (
                <li key={t.id}>
                  {t.title} — <span className="muted">{t.artists.join(", ")}</span>
                </li>
              ))}
            </ul>
            {conflict.remote_added.length > 8 && (
              <div className="hint">…and {conflict.remote_added.length - 8} more</div>
            )}
          </div>
        )}
        {conflict.remote_removed.length > 0 && (
          <div className="conflict-group">
            <div className="cg-title">Removed on Spotify ({conflict.remote_removed.length}):</div>
            <ul>
              {conflict.remote_removed.slice(0, 6).map((t) => (
                <li key={t.id}>
                  {t.title} — <span className="muted">{t.artists.join(", ")}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onMerge}>
            Merge — keep Spotify's additions
          </button>
          <button className="btn ghost" onClick={onOverwrite}>
            Overwrite Spotify with mine
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
