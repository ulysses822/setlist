// The playlist collection: the sidebar's list, and every operation that changes which
// playlists exist or how they're marked — reload, pin, archive, unfollow, create, delete.
//
// Pulled out of Library for the same reason usePlaylistDraft and usePlaylistMetrics were:
// it is one concern held in six pieces of state that only ever change together, and inside
// Library those sat interleaved with the editor's own state, the search box and the drag
// handlers. The three hooks now divide cleanly — this one owns *which playlists there are*,
// usePlaylistDraft owns *the one being edited*, usePlaylistMetrics owns *what it sounds like*.
//
// Deliberately knows nothing about the editor. Library used to call `openPlaylist` from
// inside create and `closeDeleted` from inside delete, which made the two concerns mutually
// dependent: the draft hook needs this hook's reload, and this code needed the draft's
// selection. Instead `create` returns the new playlist and `remove` reports the file it
// deleted, leaving the decision to open or close with the caller — which is what breaks the
// cycle rather than papering over it with a ref.

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { api, type LocalPlaylist } from "./api";
import type { Status } from "./usePlaylistDraft";

export interface PlaylistLibrary {
  playlists: LocalPlaylist[];
  /// The sidebar's own load. Deliberately separate from the draft's `busy`: a list refresh
  /// can overlap a save or a push, and clearing one must not clear the other.
  listBusy: boolean;
  /// Files of every archived playlist, for the overlay's badges.
  archivedFiles: Set<string>;
  /// Re-read the sidebar, reporting a failure rather than leaving a stale list looking
  /// authoritative — after a create or a delete, a silently stale sidebar is one the user is
  /// about to act on.
  ///
  /// `alsoGit` re-reads the data-repo chip too, which costs a `git status` subprocess. Worth it
  /// whenever a playlist file changed; wasted when only a staged draft did, since staging
  /// writes to the gitignored `staged/` directory and leaves the repo untouched.
  reload: (alsoGit?: boolean) => Promise<void>;

  togglePin: (p: LocalPlaylist) => Promise<void>;
  toggleArchive: (file: string, currentlyArchived: boolean) => Promise<void>;
  unfollowArchivedAll: () => Promise<void>;
  refollow: (file: string) => Promise<void>;

  createOpen: boolean;
  setCreateOpen: Dispatch<SetStateAction<boolean>>;
  creating: boolean;
  /// Create, reload, and hand back the new playlist so the caller can open it. Null on failure
  /// (already reported through `onStatus`) or on an empty name.
  create: (name: string, description: string) => Promise<LocalPlaylist | null>;

  deleteTarget: LocalPlaylist | null;
  setDeleteTarget: Dispatch<SetStateAction<LocalPlaylist | null>>;
  deleting: boolean;
  /// Delete whatever `deleteTarget` points at, then reload.
  remove: () => Promise<void>;
}

export interface PlaylistLibraryOptions {
  /// Every operation reports through here — the caller owns the message line.
  onStatus: (s: Status) => void;
  /// In-app confirm (see Library's ConfirmModal). Only `unfollowArchivedAll` asks.
  confirm: (message: string, confirmLabel?: string) => Promise<boolean>;
  /// Re-read the data repo's status. A list reload can follow a change git should see.
  refreshGit: () => void;
  /// Called with the file that was just deleted, so the caller can close it if it was open.
  onDeleted: (file: string) => void;
}

export function usePlaylistLibrary(opts: PlaylistLibraryOptions): PlaylistLibrary {
  const { onStatus, confirm, refreshGit, onDeleted } = opts;

  const [playlists, setPlaylists] = useState<LocalPlaylist[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LocalPlaylist | null>(null);
  const [deleting, setDeleting] = useState(false);

  const archivedFiles = useMemo(
    () => new Set(playlists.filter((p) => p.archived).map((p) => p.file)),
    [playlists]
  );

  const fail = (e: unknown) => onStatus({ kind: "err", msg: String(e) });

  async function reload(alsoGit = true) {
    setListBusy(true);
    try {
      setPlaylists(await api.listLocalPlaylists());
      if (alsoGit) refreshGit();
    } catch (e) {
      fail(e);
    } finally {
      setListBusy(false);
    }
  }

  async function togglePin(p: LocalPlaylist) {
    try {
      await api.setPinned(p.file, !p.pinned);
      void reload();
    } catch (e) {
      fail(e);
    }
  }

  async function create(name: string, description: string): Promise<LocalPlaylist | null> {
    if (!name.trim()) return null;
    setCreating(true);
    try {
      const np = await api.createPlaylist(name.trim(), description.trim());
      setCreateOpen(false);
      await reload();
      onStatus({ kind: "ok", msg: `Created "${np.name}"` });
      return np;
    } catch (e) {
      fail(e);
      return null;
    } finally {
      setCreating(false);
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { file, name } = deleteTarget;
      await api.deletePlaylist(file);
      onDeleted(file);
      setDeleteTarget(null);
      await reload();
      onStatus({ kind: "ok", msg: `Deleted "${name}"` });
    } catch (e) {
      fail(e);
    } finally {
      setDeleting(false);
    }
  }

  async function toggleArchive(file: string, currentlyArchived: boolean) {
    try {
      await api.setArchived(file, !currentlyArchived);
      onStatus({
        kind: "ok",
        msg: currentlyArchived
          ? "Unarchived"
          : "Archived (still on Spotify until you unfollow)",
      });
      void reload();
    } catch (e) {
      fail(e);
    }
  }

  async function unfollowArchivedAll() {
    const n = playlists.filter((p) => p.archived).length;
    if (n === 0) return;
    if (
      !(await confirm(
        `Unfollow ${n} archived playlist(s) from Spotify?\n\nThey'll be removed from your Spotify library but kept in Setlist. You stay the owner, so editing/playback still work, and you can re-add them later.`,
        "Unfollow"
      ))
    )
      return;
    try {
      const r = await api.unfollowArchived();
      if (r.failed.length > 0) {
        onStatus({
          kind: "err",
          msg: `Unfollowed ${r.done}, but ${r.failed.length} failed: ${r.failed[0]}${
            r.failed.length > 1 ? ` (+${r.failed.length - 1} more)` : ""
          }`,
        });
      } else {
        onStatus({ kind: "ok", msg: `Unfollowed ${r.done} playlist(s) from Spotify` });
      }
    } catch (e) {
      fail(e);
    }
  }

  async function refollow(file: string) {
    try {
      await api.followPlaylist(file);
      onStatus({ kind: "ok", msg: "Re-added to your Spotify library" });
    } catch (e) {
      fail(e);
    }
  }

  return {
    playlists,
    listBusy,
    archivedFiles,
    reload,
    togglePin,
    toggleArchive,
    unfollowArchivedAll,
    refollow,
    createOpen,
    setCreateOpen,
    creating,
    create,
    deleteTarget,
    setDeleteTarget,
    deleting,
    remove,
  };
}
