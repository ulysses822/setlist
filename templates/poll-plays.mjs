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
 *   SPOTIFY_CLIENT_SECRET   - required: the app mints a confidential (non-rotating) token,
 *                             which can only be refreshed by presenting the secret
 *
 * This file is a template: Setlist writes it into your data repo as scripts/poll-plays.mjs,
 * which is where the workflow above runs it from.
 *
 * Run locally:  node scripts/poll-plays.mjs   (from your data repo, with the env vars set)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
  return json.items.map((it) => ({
    track_id: it.track.uri,
    played_at: it.played_at,
    title: it.track.name,
    artists: it.track.artists.map((a) => a.name),
  }));
}

function loadExistingKeys() {
  if (!existsSync(HISTORY_FILE)) return new Set();
  const keys = new Set();
  for (const line of readFileSync(HISTORY_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      keys.add(`${p.track_id}|${p.played_at}`);
    } catch {
      // skip malformed line
    }
  }
  return keys;
}

async function main() {
  const token = await getAccessToken();
  const recent = await fetchRecent(token);
  const seen = loadExistingKeys();

  const fresh = recent
    .filter((p) => !seen.has(`${p.track_id}|${p.played_at}`))
    .sort((a, b) => a.played_at.localeCompare(b.played_at)); // chronological append

  if (fresh.length === 0) {
    console.log("No new plays.");
    return;
  }

  mkdirSync(dirname(HISTORY_FILE), { recursive: true });
  const existing = existsSync(HISTORY_FILE) ? readFileSync(HISTORY_FILE, "utf8") : "";
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  const appended = fresh.map((p) => JSON.stringify(p)).join("\n") + "\n";
  writeFileSync(HISTORY_FILE, existing + prefix + appended);

  console.log(`Appended ${fresh.length} new play(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
