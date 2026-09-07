import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type PlaylistSummary, type ProbeStep, type Profile } from "./api";
import Library from "./Library";
import { PlaybackBar, usePlayer } from "./player";
import { useRateLimit } from "./rateLimit";
import { GitChip, GitPanel, useGit } from "./git";
import { ThemeToggle } from "./theme";
import * as prefs from "./prefs";
import "./App.css";

type Tab = "library" | "setup";

// Human-readable cooldown: hours+minutes for long waits, minutes+seconds for medium,
// plain seconds under a minute.
function fmtCooldown(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function Nav({
  tab,
  setTab,
  connected,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  connected: boolean;
}) {
  const { blocked, secondsLeft } = useRateLimit();
  // Shown in the topbar rather than a tab's status line because it outlives any one action and
  // applies wherever you are: the goals you set in Library fail to save just as silently as the
  // hub repo you typed in Setup.
  const saveError = useSyncExternalStore(prefs.subscribeSaveError, prefs.getSaveError);
  return (
    <nav className="topbar">
      <span className="brand">Setlist</span>
      <div className="tabs">
        <button
          className={`tab ${tab === "setup" ? "active" : ""}`}
          onClick={() => setTab("setup")}
        >
          Setup
        </button>
        <button
          className={`tab ${tab === "library" ? "active" : ""}`}
          onClick={() => setTab("library")}
        >
          Library
        </button>
      </div>
      <div className="nav-right">
        {blocked && (
          <span
            className="ratelimit-chip"
            title="Spotify's rate limit was hit. Actions that call Spotify are paused until this clears (retrying now would only extend the wait)."
          >
            ⏳ Rate-limited · {fmtCooldown(secondsLeft)}
          </span>
        )}
        {saveError && (
          <span className="saveerror-chip" title={saveError}>
            Settings not saving
          </span>
        )}
        <GitChip />
        <ThemeToggle />
        <span className={`conn ${connected ? "on" : "off"}`} title={connected ? "Connected to Spotify" : "Not connected"}>
          ● {connected ? "Connected" : "Not connected"}
        </span>
      </div>
    </nav>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("library");
  const [clientId, setClientId] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [redirect, setRedirect] = useState("");
  const [connected, setConnected] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [probe, setProbe] = useState<ProbeStep[]>([]);
  const [busy, setBusy] = useState<
    null | "login" | "pull" | "list" | "save" | "probe" | "mint" | "scaffold"
  >(null);
  // GitHub repo slug for the history-logger deep links (purely a UI convenience).
  const [hubRepo, setHubRepo] = useState(() => prefs.getHubRepo());
  // Minted history token — held in memory only, shown once, never persisted.
  const [historyToken, setHistoryToken] = useState("");
  // Goals and view state come from the data folder, so the library can't render until they
  // have arrived — reading them early would show defaults and then never correct itself.
  const [prefsReady, setPrefsReady] = useState(false);
  // Client secret for minting the (non-rotating) history token. Never written to disk.
  //
  // The whole point of this app's token handling is that the webview doesn't hold credentials
  // — it gets a streaming-scoped token and nothing else. The secret is the one exception it
  // can't avoid, because a keyboard is the only place it can come from and the keyboard is in
  // here. So it transits rather than resides: kept in a ref (no copy in the fiber tree, no
  // re-render carrying it), handed to Rust, and zeroed the moment that call returns. State
  // holds only whether there is one, which is all the button needs to know.
  const secretRef = useRef<HTMLInputElement>(null);
  const [hasSecret, setHasSecret] = useState(false);
  const [pullingId, setPullingId] = useState<string | null>(null); // single-playlist pull in flight
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const { blocked } = useRateLimit();
  const git = useGit();
  const player = usePlayer();

  // Success/status popups are transient: auto-dismiss after a few seconds. Errors stay
  // until the user dismisses them so they aren't missed.
  useEffect(() => {
    if (status?.kind !== "ok") return;
    const t = setTimeout(() => setStatus(null), 4000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.getConfig();
        setClientId(cfg.client_id);
        setDataDir(cfg.data_dir);
        setRedirect(await api.redirectUri());
        setConnected(await api.authStatus());
      } catch (e) {
        setStatus({ kind: "err", msg: String(e) });
      }
      // Never fails loudly: with no data folder configured yet there is nothing to load, and
      // the defaults are the right answer.
      await prefs.loadPrefs();
      setHubRepo(prefs.getHubRepo());
      setPrefsReady(true);
    })();
  }, []);

  // Refresh the connection indicator whenever the user switches tabs.
  useEffect(() => {
    api.authStatus().then(setConnected).catch(() => {});
  }, [tab]);

  // Pick the data folder via the native folder picker (no path-typing needed).
  async function browseDataDir() {
    try {
      const dir = await api.pickFolder();
      if (dir) {
        setDataDir(dir);
        await api.setConfig(clientId, dir); // persist so git status reads the new folder
        await prefs.loadPrefs(); // a different folder is a different library's goals/columns
        setHubRepo(prefs.getHubRepo());
        git?.refresh();
      }
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  function openDataDir() {
    api.openFolder(dataDir).catch((e) => setStatus({ kind: "err", msg: String(e) }));
  }

  async function saveConfig() {
    setBusy("save");
    setStatus(null);
    try {
      await api.setConfig(clientId, dataDir);
      // Typing a path straight into the field changes libraries just as Browse… does.
      await prefs.loadPrefs();
      setHubRepo(prefs.getHubRepo());
      setStatus({ kind: "ok", msg: "Settings saved" });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function connect() {
    setBusy("login");
    setStatus(null);
    try {
      await api.setConfig(clientId, dataDir); // persist before the browser handoff
      const p = await api.login();
      setProfile(p);
      setConnected(true);
      // The SDK may still be blocked on a token request from startup, when there was no
      // streaming grant to answer with. There is one now, so answer it.
      player?.retryToken();
      const who = p.display_name ?? p.id;
      // The second, playback-only authorization can fail on its own. Everything else is
      // connected, so this isn't a failed login — but it has to be said out loud, because the
      // player will refuse rather than quietly fall back to the full-scope token. Reported as
      // an error so it stays on screen until dismissed.
      setStatus(
        p.streaming_error
          ? {
              kind: "err",
              msg: `Connected as ${who}, but in-app playback wasn't authorized — click Connect Spotify again to retry it. (${p.streaming_error})`,
            }
          : { kind: "ok", msg: `Connected as ${who}` }
      );
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    try {
      await api.logout();
      setConnected(false);
      setProfile(null);
      setStatus({ kind: "ok", msg: "Disconnected" });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  }

  async function pull() {
    setBusy("pull");
    setStatus(null);
    try {
      const result = await api.pullPlaylists();
      setPlaylists(result);
      git?.refresh(); // pulled files change the data repo
      // A playlist renamed on Spotify renames its file, and the goal/column stores are keyed
      // by that name; the backend moves the entries, so re-read them over the cached copy.
      await prefs.loadPrefs();
      const skipped = result.filter((p) => p.error).length;
      const pulled = result.length - skipped;
      const firstError = result.find((p) => p.error)?.error;
      if (pulled === 0 && firstError) {
        setStatus({
          kind: "err",
          msg: `All ${skipped} skipped. Spotify says → ${firstError}`,
        });
      } else {
        setStatus({
          kind: "ok",
          msg: `Pulled ${pulled} playlist(s)${
            skipped ? `, skipped ${skipped}` : ""
          }`,
        });
      }
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function listRemote() {
    setBusy("list");
    setStatus(null);
    try {
      const remote = await api.listRemotePlaylists();
      setPlaylists(remote);
      setStatus({
        kind: "ok",
        msg: `Found ${remote.length} playlist(s) — pull them individually or all at once`,
      });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function pullOne(p: PlaylistSummary) {
    setPullingId(p.spotify_id);
    setStatus(null);
    try {
      const summary = await api.pullPlaylist(p.spotify_id);
      setPlaylists((prev) =>
        prev.map((row) => (row.spotify_id === p.spotify_id ? summary : row))
      );
      git?.refresh(); // pulled file changes the data repo
      await prefs.loadPrefs(); // the pull may have renamed the file its goal/columns are keyed by
      setStatus({ kind: "ok", msg: `Pulled "${summary.name}" (${summary.track_count} tracks)` });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setPullingId(null);
    }
  }

  // --- Listening-history logger (GitHub Actions) helpers ---

  function saveHubRepo(v: string) {
    setHubRepo(v);
    try {
      prefs.setHubRepo(v);
    } catch {
      /* ignore quota/availability errors */
    }
  }

  // Accept either "owner/repo" or a pasted github.com URL.
  const repoSlug = hubRepo
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

  // The logger can only run in GitHub Actions, so a data folder that isn't a git repo with a
  // remote can't use it — warn (and block Install) up front, mirroring the backend guard.
  const loggerNoRemote =
    dataDir.trim() !== "" &&
    (git?.error != null || (git?.status != null && !git.status.has_remote));

  function openExternal(url: string) {
    api.openExternal(url).catch((e) => setStatus({ kind: "err", msg: String(e) }));
  }

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ kind: "ok", msg: `${label} copied to clipboard` });
    } catch (e) {
      setStatus({ kind: "err", msg: `Couldn't copy: ${e}` });
    }
  }

  async function mintHistoryToken() {
    const secret = secretRef.current?.value.trim() ?? "";
    if (secret === "") return; // the button is disabled without one; belt and braces
    setBusy("mint");
    setStatus(null);
    try {
      await api.setConfig(clientId, dataDir); // persist before the browser handoff
      const token = await api.mintHistoryToken(secret);
      setHistoryToken(token);
      setStatus({
        kind: "ok",
        msg: "Token minted — copy it into the SPOTIFY_REFRESH_TOKEN secret on GitHub",
      });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      // Cleared whether or not it worked. A wrong secret is the likeliest failure and needs
      // re-pasting anyway; leaving the right one sitting in the DOM for the rest of the
      // session buys nothing.
      if (secretRef.current) secretRef.current.value = "";
      setHasSecret(false);
      setBusy(null);
    }
  }

  async function scaffoldLogger() {
    setBusy("scaffold");
    setStatus(null);
    try {
      await api.setConfig(clientId, dataDir); // make sure the data folder is persisted first
      const report = await api.scaffoldHistoryLogger();
      git?.refresh(); // scaffolded files change the data repo
      const touched = [...report.created, ...report.updated];
      const verb =
        report.created.length && report.updated.length
          ? "Added/updated"
          : report.updated.length
          ? "Updated"
          : "Added";
      setStatus({
        kind: "ok",
        msg: `${verb} ${touched.join(" and ")} in your data repo — commit & push it, then add the secrets below.`,
      });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function runProbe() {
    setBusy("probe");
    setStatus(null);
    try {
      const steps = await api.probeWrite();
      setProbe(steps);
      const writeOk = steps.some(
        (s) => (s.step.startsWith("Add ") || s.step.startsWith("Create ")) && s.ok
      );
      setStatus(
        writeOk
          ? { kind: "ok", msg: "A write succeeded — editing is possible! See steps below" }
          : { kind: "err", msg: "Every write was refused — see steps below." }
      );
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(null);
    }
  }

  if (tab === "library") {
    return (
      <div className="shell">
        <Nav tab={tab} setTab={setTab} connected={connected} />
        {prefsReady && <Library />}
        <PlaybackBar />
        <GitPanel />
      </div>
    );
  }

  return (
    <div className="shell">
      <Nav tab={tab} setTab={setTab} connected={connected} />
      <main className="app">
      <header className="hero">
        <h1 className="wordmark">Setlist</h1>
        <p className="tagline">Curate, version &amp; analyze your Spotify playlists.</p>
      </header>

      <section className="card">
        <h2>1 · Settings</h2>
        <label className="field">
          <span>Spotify Client ID</span>
          <input
            name="spotify-client-id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="from developer.spotify.com/dashboard"
            spellCheck={false}
          />
        </label>
        <div className="field">
          <span>Data folder (hub repo) — required</span>
          <div className="dir-row">
            <input
              name="data-dir"
              value={dataDir}
              onChange={(e) => setDataDir(e.target.value)}
              placeholder="choose a folder outside the app, e.g. your setlist-data repo"
              spellCheck={false}
            />
            <button className="btn ghost" onClick={browseDataDir}>
              Browse…
            </button>
            <button
              className="btn ghost"
              onClick={openDataDir}
              disabled={dataDir.trim() === ""}
              title="Show this folder in your file explorer"
            >
              Open
            </button>
          </div>
          <p className="hint">
            Playlists and curation state are stored here — keep it outside the app folder
            (a dedicated git repo works well).
          </p>
        </div>
        <p className="hint">
          Add this redirect URI to your Spotify app:&nbsp;
          <code>{redirect || "loading…"}</code>
        </p>
        <button className="btn ghost" onClick={saveConfig} disabled={busy !== null}>
          {busy === "save" ? "Saving…" : "Save settings"}
        </button>
      </section>

      <section className="card">
        <h2>2 · Connect</h2>
        {connected ? (
          <div className="row">
            <span className="pill">
              ● Connected{profile ? ` — ${profile.display_name ?? profile.id}` : ""}
            </span>
            <button className="btn ghost" onClick={disconnect}>
              Disconnect
            </button>
          </div>
        ) : (
          <button
            className="btn"
            onClick={connect}
            disabled={busy !== null || blocked || clientId.trim() === ""}
          >
            {busy === "login" ? "Waiting for Spotify…" : "Connect Spotify"}
          </button>
        )}
      </section>

      <section className="card">
        <h2>3 · Pull playlists</h2>
        <p className="hint">
          List your playlists and pull them one at a time, or pull everything at once.
          (Pulling all sends many requests quickly and can hit Spotify's rate limit on large
          libraries — a single pull is just a few requests.)
        </p>
        <div className="row">
          <button
            className="btn ghost"
            onClick={listRemote}
            disabled={busy !== null || pullingId !== null || blocked || !connected}
          >
            {busy === "list" ? "Listing…" : "List my playlists"}
          </button>
          <button
            className="btn"
            onClick={pull}
            disabled={busy !== null || pullingId !== null || blocked || !connected}
          >
            {busy === "pull" ? "Pulling all…" : "Pull all → JSON"}
          </button>
        </div>

        {playlists.length > 0 && (
          <table className="playlists">
            <thead>
              <tr>
                <th>Playlist</th>
                <th>Tracks</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {playlists.map((p) => (
                <tr key={p.spotify_id}>
                  <td>{p.name}</td>
                  <td className="num">{p.error ? "—" : p.track_count}</td>
                  <td>
                    {p.error ? (
                      <span className="err" title={p.error}>
                        skipped
                      </span>
                    ) : p.file ? (
                      <span className="mono">{p.file}</span>
                    ) : (
                      <button
                        className="btn ghost small"
                        onClick={() => pullOne(p)}
                        disabled={busy !== null || pullingId !== null || blocked}
                      >
                        {pullingId === p.spotify_id ? "Pulling…" : "Pull"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>4 · Write-access check</h2>
        <p className="hint">
          Shows your granted scopes, then add+removes one track on a playlist you own
          (reversible) and tries creating a throwaway playlist. Confirms what writes, if
          any, this app is allowed to do.
        </p>
        <button
          className="btn ghost"
          onClick={runProbe}
          disabled={busy !== null || blocked || !connected}
        >
          {busy === "probe" ? "Testing…" : "Test write access"}
        </button>

        {probe.length > 0 && (
          <ul className="probe">
            {probe.map((s) => (
              <li key={s.step} className={s.ok ? "ok" : "err"}>
                <span className="mark">{s.ok ? "✓" : "✗"}</span>
                <span className="label">{s.step}</span>
                <span className="mono">{s.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>5 · Listening-history logger</h2>
        <p className="hint">
          A GitHub Actions workflow logs your recently played tracks to{" "}
          <code>history/plays.jsonl</code> every 30 minutes, even while this app is closed.
          It lives in your <strong>data repo</strong> (alongside your playlists) — never in
          the app's code — so your history and its secrets stay with your private data.
        </p>

        <div className="secret-step">
          <code className="secret-name">Install into data repo</code>
          <span className="secret-help">
            Writes <code>.github/workflows/poll-plays.yml</code> and{" "}
            <code>scripts/poll-plays.mjs</code> into your data folder. Commit &amp; push them
            to GitHub (the repo needs Actions enabled), then add the three secrets below.
            {loggerNoRemote && (
              <strong className="secret-warn">
                {" "}
                Your data folder isn't a git repo with a remote yet — run{" "}
                <code>git init</code>, add a GitHub remote, and push first (the workflow runs
                in GitHub Actions, so a local-only folder can't run it).
              </strong>
            )}
          </span>
          <button
            className="btn ghost small"
            onClick={scaffoldLogger}
            disabled={busy !== null || dataDir.trim() === "" || loggerNoRemote}
          >
            {busy === "scaffold" ? "Writing…" : "Install logger"}
          </button>
        </div>

        <div className="secret-step">
          <code className="secret-name">SPOTIFY_CLIENT_ID</code>
          <span className="secret-help">Your Client ID from Settings above.</span>
          <button
            className="btn ghost small"
            onClick={() => copyText("Client ID", clientId.trim())}
            disabled={clientId.trim() === ""}
          >
            Copy value
          </button>
        </div>

        <div className="secret-step">
          <code className="secret-name">SPOTIFY_CLIENT_SECRET</code>
          <span className="secret-help">
            From your app's page on the Spotify dashboard (Settings → "View client
            secret"). Required: it's used to mint the token below via Spotify's confidential
            flow, which (unlike the app's own PKCE login) yields a token that doesn't rotate —
            so the poller's GitHub secret stays valid indefinitely.
          </span>
          <button
            className="btn ghost small"
            onClick={() => openExternal("https://developer.spotify.com/dashboard")}
          >
            Open dashboard
          </button>
        </div>

        <div className="field">
          <span>Client secret — never saved to disk, and cleared from here once used</span>
          <input
            className="mono"
            name="client-secret"
            type="password"
            aria-label="Spotify client secret"
            ref={secretRef}
            defaultValue=""
            onChange={(e) => setHasSecret(e.target.value.trim() !== "")}
            placeholder="paste your client secret to enable Generate token"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="secret-step">
          <code className="secret-name">SPOTIFY_REFRESH_TOKEN</code>
          <span className="secret-help">
            A dedicated, non-rotating token carrying only the recently-played scope —
            independent of this app's own login, so the two can't invalidate each other.
            Needs the client secret above.
          </span>
          <button
            className="btn ghost small"
            onClick={mintHistoryToken}
            disabled={busy !== null || clientId.trim() === "" || !hasSecret}
            title={hasSecret ? undefined : "Enter your client secret above first"}
          >
            {busy === "mint" ? "Waiting for Spotify…" : historyToken ? "Regenerate" : "Generate token"}
          </button>
        </div>

        {historyToken && (
          <div className="field">
            <span>Generated token — shown only here, never saved</span>
            <div className="dir-row">
              <input
                className="mono"
                name="history-token"
                aria-label="Generated refresh token"
                readOnly
                value={historyToken}
                spellCheck={false}
              />
              <button
                className="btn ghost"
                onClick={() => copyText("Refresh token", historyToken)}
              >
                Copy
              </button>
              {/* This is a live grant, not a receipt. Once it's in GitHub there's no reason
                  for it to stay on screen and in memory until the app closes. */}
              <button
                className="btn ghost"
                onClick={() => setHistoryToken("")}
                title="Clear it from the screen once it's saved on GitHub"
              >
                Done
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <span>Data repository on GitHub (owner/repo)</span>
          <div className="dir-row">
            <input
              name="hub-repo"
              value={hubRepo}
              onChange={(e) => saveHubRepo(e.target.value)}
              placeholder="e.g. you/my-playlists"
              spellCheck={false}
            />
            <button
              className="btn ghost"
              disabled={!repoSlug.includes("/")}
              onClick={() =>
                openExternal(`https://github.com/${repoSlug}/settings/secrets/actions`)
              }
              title="Repository → Settings → Secrets and variables → Actions"
            >
              Secrets page
            </button>
            <button
              className="btn ghost"
              disabled={!repoSlug.includes("/")}
              onClick={() => openExternal(`https://github.com/${repoSlug}/actions`)}
              title="Trigger or inspect the poll-plays workflow"
            >
              Workflow runs
            </button>
          </div>
          <p className="hint">
            Add all three secrets on the secrets page ("New repository secret"), then run
            the "Poll recently played" workflow from the workflow-runs page to verify.
          </p>
        </div>
      </section>

      {status && (
        <p className={`status ${status.kind} has-close`}>
          <span>{status.msg}</span>
          <button
            className="msg-close"
            onClick={() => setStatus(null)}
            title="Dismiss"
            aria-label="Dismiss"
          >
            ×
          </button>
        </p>
      )}
      </main>
      <PlaybackBar />
      <GitPanel />
    </div>
  );
}

export default App;
