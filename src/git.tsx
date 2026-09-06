import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, type RepoStatus } from "./api";

// Data-repo version control: the app commits and pushes the data repo (playlists, curation,
// history) so the user never has to drop to a terminal. State lives in one provider so the
// nav chip and the panel stay in sync; the panel authors commit messages from the git diff.
interface GitApi {
  status: RepoStatus | null;
  /** Set when status couldn't be read (no data folder, or not a git repo). */
  error: string | null;
  refresh: () => void;
  open: boolean;
  setOpen: (o: boolean) => void;
}

const Ctx = createContext<GitApi | null>(null);
export const useGit = () => useContext(Ctx);

export function GitProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    api
      .gitRepoStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => {
        setStatus(null);
        setError(String(e));
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  // Re-read whenever the panel opens so it reflects edits made since last time.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  return (
    <Ctx.Provider value={{ status, error, refresh, open, setOpen }}>{children}</Ctx.Provider>
  );
}

// Nav indicator: hidden until a git data repo is readable, then reflects the pending state.
export function GitChip() {
  const git = useGit();
  if (!git || !git.status) return null;
  const { status, setOpen } = git;

  const changeCount = status.changes.length;
  let cls = "synced";
  let label = "✓ Synced";
  if (changeCount > 0) {
    cls = "dirty";
    label = `● ${changeCount} change${changeCount === 1 ? "" : "s"}`;
  } else if (status.ahead > 0) {
    cls = "ahead";
    label = `↑ ${status.ahead} to push`;
  }

  return (
    <button
      className={`git-chip ${cls}`}
      onClick={() => setOpen(true)}
      title="Review, commit & push your data repo"
    >
      {label}
    </button>
  );
}

type Busy = null | "commit" | "push";

export function GitPanel() {
  const git = useGit();
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [result, setResult] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const open = git?.open ?? false;
  const status = git?.status ?? null;

  // Pull a fresh suggested message each time the panel opens (or after a commit clears the
  // working tree and new changes remain). Overwrites the textarea — edits are per-session.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    api
      .gitSuggestMessage()
      .then(setMsg)
      .catch(() => setMsg(""));
  }, [open, status?.changes.length]);

  if (!git || !open) return null;

  const close = () => git.setOpen(false);

  async function doCommit() {
    if (!git) return;
    setBusy("commit");
    setResult(null);
    try {
      await api.gitCommit(msg);
      setResult({ kind: "ok", text: "Committed." });
      git.refresh();
    } catch (e) {
      setResult({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function doPush() {
    if (!git) return;
    setBusy("push");
    setResult(null);
    try {
      const out = await api.gitPush();
      setResult({ kind: "ok", text: out.message });
      git.refresh();
    } catch (e) {
      setResult({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  }

  const clean = status?.clean ?? true;
  const identityOk = status?.identity_ok ?? true;
  const ahead = status?.ahead ?? 0;
  const hasRemote = status?.has_remote ?? false;
  const canCommit = !clean && identityOk && msg.trim() !== "" && busy === null;
  const canPush = ahead > 0 && hasRemote && busy === null;

  return (
    <>
      <div className="git-backdrop" onClick={close} />
      <div className="git-panel" role="dialog" aria-label="Data repo version control">
        <div className="git-head">
          <div>
            <h2>Data repo</h2>
            {status && <span className="git-branch">{status.branch}</span>}
          </div>
          <button className="msg-close" onClick={close} title="Close" aria-label="Close">
            ×
          </button>
        </div>

        {git.error ? (
          <p className="hint pad">{git.error}</p>
        ) : (
          <>
            <div className="git-changes">
              {clean ? (
                <p className="hint pad">No uncommitted changes.</p>
              ) : (
                status?.changes.map((c) => (
                  <div key={c.path} className="git-change">
                    <span className={`git-badge ${c.kind}`}>{c.kind[0].toUpperCase()}</span>
                    <span className="git-change-summary">{c.summary}</span>
                  </div>
                ))
              )}
            </div>

            {!clean && (
              <div className="git-commit">
                <textarea
                  className="git-msg mono"
                  name="commit-message"
                  aria-label="Commit message"
                  value={msg}
                  onChange={(e) => setMsg(e.target.value)}
                  rows={Math.min(12, Math.max(4, msg.split("\n").length + 1))}
                  spellCheck={false}
                  placeholder="Commit message…"
                />
                {!identityOk && (
                  <p className="hint">
                    Git needs an identity before it can commit. In your data repo run{" "}
                    <code>git config user.name "Your Name"</code> and{" "}
                    <code>git config user.email "you@example.com"</code>.
                  </p>
                )}
                <button className="btn" onClick={doCommit} disabled={!canCommit}>
                  {busy === "commit" ? "Committing…" : "Commit"}
                </button>
              </div>
            )}

            <div className="git-push">
              <span className="hint">
                {!hasRemote
                  ? "No remote — add one (git remote add origin …) to push."
                  : ahead > 0
                  ? `${ahead} commit${ahead === 1 ? "" : "s"} to push`
                  : "Up to date with the remote."}
              </span>
              <button className="btn ghost" onClick={doPush} disabled={!canPush}>
                {busy === "push" ? "Pushing…" : "Push"}
              </button>
            </div>
          </>
        )}

        {result && (
          <p className={`status ${result.kind} git-result`}>{result.text}</p>
        )}
      </div>
    </>
  );
}
