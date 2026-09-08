/**
 * Setlist — recently-played logger.
 *
 * Runs in GitHub Actions on a ~30 min cron (see .github/workflows/poll-plays.yml).
 * Refreshes a Spotify access token, fetches the last 50 recently-played tracks,
 * and appends any new plays to history/plays.jsonl (deduped by track_id + played_at).
 *
 * Plain Node ESM (.mjs) on purpose: it uses only Node built-ins (node:fs, node:path, and
 * global fetch plus AbortSignal.timeout on Node 18+), so CI runs it with `node` and needs NO
 * npm install. That keeps the job's supply-chain surface at zero — no third-party package is
 * fetched or executed in an environment that holds the Spotify secrets.
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

// Node's fetch has no default timeout. This runs unattended on a cron, so a socket that
// connects and then goes quiet would hold the job open until GitHub's six-hour ceiling --
// and the workflow's concurrency group doesn't cancel in progress, so every later run would
// queue behind it rather than replace it.
const REQUEST_TIMEOUT_MS = 20_000;
// Three attempts, ~8s of backoff between them. Worth having because a lost run is more than a
// red X: recently-played only reaches back 50 tracks, so a window nobody retried is a
// permanent hole in the log. (The workflow already retries the *push* for the same reason.)
const ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 6_000];
// Wait out a Retry-After up to this long. Beyond it, give up and let the next run in 30
// minutes cover the same tracks -- sitting in a paid CI job for several minutes buys nothing.
const MAX_RETRY_AFTER_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function env(name, required = true) {
  const v = process.env[name];
  if (!v && required) throw new Error(`Missing required env var: ${name}`);
  return v ?? "";
}

// How long to hold off before asking again, honouring Retry-After when Spotify sends a usable
// one and falling back to the fixed backoff when it doesn't (the header may legally be an
// HTTP-date, which Number() reads as NaN).
function backoffFor(resp, attempt) {
  const advised = Number(resp.headers.get("retry-after"));
  const ms =
    Number.isFinite(advised) && advised > 0 ? advised * 1000 : BACKOFF_MS[attempt - 1];
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * fetch with a deadline, retried only on the failures a later attempt could plausibly fix:
 * a transport error (including our own timeout), a 429, or a 5xx. A 4xx is Spotify answering
 * the question -- a dead refresh token doesn't become live on the third ask -- so it comes
 * straight back for the caller to report.
 */
async function request(url, options, what) {
  for (let attempt = 1; ; attempt++) {
    const last = attempt === ATTEMPTS;
    let resp;
    try {
      resp = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (last) {
        throw new Error(`${what} failed after ${ATTEMPTS} attempts: ${e.message}`, {
          cause: e,
        });
      }
      console.warn(`${what}: ${e.message} — retrying (attempt ${attempt + 1} of ${ATTEMPTS}).`);
      await sleep(BACKOFF_MS[attempt - 1]);
      continue;
    }
    if (!last && (resp.status === 429 || resp.status >= 500)) {
      const wait = backoffFor(resp, attempt);
      console.warn(`${what}: HTTP ${resp.status} — retrying in ${Math.round(wait / 1000)}s.`);
      await sleep(wait);
      continue;
    }
    return resp;
  }
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

  // Safe to retry in the configuration this script asks for: with the client secret set, the
  // grant is confidential and Spotify does not rotate the refresh token, so re-sending is
  // idempotent. Without it the token rotates on use and a retry can land on an already-spent
  // one — but that mode is already broken by the next run for the reason main() warns about,
  // so this makes nothing worse.
  const res = await request(TOKEN_URL, { method: "POST", headers, body }, "Token refresh");
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.access_token;
}

async function fetchRecent(accessToken) {
  const res = await request(
    RECENT_URL,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "recently-played"
  );
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
