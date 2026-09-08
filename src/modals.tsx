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
        <p className="hint">Creates a new empty private playlist on your Spotify account.</p>
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
