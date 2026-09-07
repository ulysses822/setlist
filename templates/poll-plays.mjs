/**
 * Setlist — recently-played logger.
 *
 * Runs in GitHub Actions on a ~30 min cron (see .github/workflows/poll-plays.yml).
 * Refreshes a Spotify access token, fetches the last 50 recently-played tracks,
 * and appends any new plays to history/plays.jsonl (deduped by track_id + played_at).
 *
 * Plain Node ESM (.mjs) on purpose: it uses only Node built-ins (node:fs, node:path,
 * and global fetch on Node 18+), so CI runs it with `node` and needs NO npm install.
 * That keeps the job's supply-chain surface at zero — no third-party package is fetched
 * or executed in an environment that holds the Spotify secrets.
 *
 * Required env (set as GitHub Actions secrets):
 *   SPOTIFY_CLIENT_ID       - your Spotify app client id
 *   SPOTIFY_REFRESH_TOKEN   - refresh token (scope: user-read-recently-played)
 *   SPOTIFY_CLIENT_SECRET   - optional, but effectively necessary. With it, the token was
 *                             minted through the confidential flow and doesn't rotate, so a
 *                             fixed GitHub secret keeps working. Without it, Spotify rotates
 *                             the refresh token on every PKCE refresh, and this job has
 *                             nowhere to write the new one — so the next run fails.
 *
 * This file is a template: Setlist writes it into your data repo as scripts/poll-plays.mjs,
 * which is where the workflow above runs it from.
 *
 * Run locally:  node scripts/poll-plays.mjs   (from your data repo, with the env vars set)
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const HISTORY_FILE = "history/plays.jsonl";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const RECENT_URL = "https://api.spotify.com/v1/me/player/recently-played?limit=50";

function env(name, required = true) {
  const v = process.env[name];
  if (!v && required) throw new Error(`Missing required env var: ${name}`);
  return v ?? "";
}

async function getAccessToken() {
  const clientId = env("SPOTIFY_CLIENT_ID");
  const refreshToken = env("SPOTIFY_REFRESH_TOKEN");
  const clientSecret = env("SPOTIFY_CLIENT_SECRET", false);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // Confidential apps authenticate with Basic auth; PKCE apps send client_id in the body.
  if (clientSecret) {
    headers.Authorization =
      "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  }

  const res = await fetch(TOKEN_URL, { method: "POST", headers, body });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.access_token;
}

async function fetchRecent(accessToken) {
  const res = await fetch(RECENT_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`recently-played failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  // Spotify's recently-played can carry items with no `track` — an episode the endpoint
  // won't expand, or something pulled from the catalogue since it was played. Skip those
  // rather than dying on `it.track.uri`: this runs on a cron with nobody watching, and one
  // bad item shouldn't cost the whole poll.
  const items = Array.isArray(json.items) ? json.items : [];
  const plays = items
    .filter((it) => it?.track?.uri && it?.played_at)
    .map((it) => ({
      track_id: it.track.uri,
      played_at: it.played_at,
      title: it.track.name ?? "",
      artists: Array.isArray(it.track.artists) ? it.track.artists.map((a) => a.name) : [],
    }));
  if (plays.length < items.length) {
    console.log(`Skipped ${items.length - plays.length} item(s) with no usable track.`);
  }
  return plays;
}

// Every play already logged, plus whether the file ends cleanly — the append below needs to
// know whether to start with a newline of its own.
function loadExisting() {
  if (!existsSync(HISTORY_FILE)) return { keys: new Set(), complete: true };
  const text = readFileSync(HISTORY_FILE, "utf8");
  const keys = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      keys.add(`${p.track_id}|${p.played_at}`);
    } catch {
      // A half-written last line from an interrupted append. Skipping it costs at most one
      // play, and nothing here rewrites the file, so it can't cascade.
    }
  }
  return { keys, complete: text === "" || text.endsWith("\n") };
}

async function main() {
  if (!process.env.SPOTIFY_CLIENT_SECRET) {
    console.warn(
      "SPOTIFY_CLIENT_SECRET is not set. Spotify rotates PKCE refresh tokens on use and this\n" +
        "job has nowhere to store the new one, so SPOTIFY_REFRESH_TOKEN will be stale by the\n" +
        "next run. Set the secret and re-mint the token to stop that happening."
    );
  }
  const token = await getAccessToken();
  const recent = await fetchRecent(token);
  const { keys: seen, complete } = loadExisting();

  const fresh = recent
    .filter((p) => !seen.has(`${p.track_id}|${p.played_at}`))
    .sort((a, b) => a.played_at.localeCompare(b.played_at)); // chronological append

  if (fresh.length === 0) {
    console.log("No new plays.");
    return;
  }

  // Append, don't rewrite. The log only grows, so rewriting all of it every 30 minutes puts
  // the whole history at risk of a mid-write crash — and the risk gets worse the longer you
  // have been using it. An interrupted append can at worst leave one partial line, which the
  // reader above already steps over.
  mkdirSync(dirname(HISTORY_FILE), { recursive: true });
  const prefix = complete ? "" : "\n";
  appendFileSync(HISTORY_FILE, prefix + fresh.map((p) => JSON.stringify(p)).join("\n") + "\n");

  console.log(`Appended ${fresh.length} new play(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
