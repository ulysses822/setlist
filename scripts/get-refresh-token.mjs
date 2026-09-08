/**
 * One-time helper: mint a Spotify refresh token for the GitHub Actions history poller
 * (the scripts/poll-plays.mjs that Setlist scaffolds into your data repo from
 * templates/poll-plays.mjs), scoped to ONLY user-read-recently-played.
 *
 * Setlist's Setup tab does the same thing with one click. This exists for the terminal, and
 * for macOS and Linux, where the desktop app doesn't build at all (see "Platform support" in
 * the README) but the data repo's workflow still runs perfectly well.
 *
 * Don't reuse the desktop app's token — it carries full playlist/playback scopes, and two
 * clients refreshing the same grant would rotate each other's token out from under them.
 * This script performs its own authorization, so it gets an independent token.
 *
 * Plain Node ESM using only built-ins (node:http, node:crypto, global fetch on Node 18+),
 * run directly with `node` — no npx, no tsx, nothing fetched from npm. That is deliberate:
 * this script handles your client secret, and the sibling templates/poll-plays.mjs is
 * dependency-free for exactly the same reason.
 *
 * Usage:
 *   node scripts/get-refresh-token.mjs <client_id>
 *
 * The client id is public for a PKCE app, so passing it as an argument is fine. The client
 * secret is NOT: anything on argv is visible to other processes (`ps`, Task Manager) and is
 * written to your shell history. So it is never read from an argument — the script prompts
 * for it with the input hidden, or takes SPOTIFY_CLIENT_SECRET from the environment when
 * there's no terminal to prompt on.
 *
 * Supplying the secret is recommended: tokens refreshed with it (confidential mode) are NOT
 * rotated, so the GitHub secret stays valid indefinitely. Without it, Spotify rotates the
 * refresh token on every PKCE refresh and the stored value goes stale after the first run.
 *
 * Uses the same loopback redirect the desktop app registers (http://127.0.0.1:8888/callback),
 * so no Spotify dashboard changes are needed — but close any in-progress Setlist login
 * first, since both bind port 8888.
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// Matches the desktop app's loopback catcher (src-tauri/src/spotify/auth.rs). The port is not
// negotiable: Spotify matches the redirect URI exactly against the one registered on the
// dashboard, so it has to be the same 8888 the README tells you to register.
const REDIRECT = "http://127.0.0.1:8888/callback";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SCOPE = "user-read-recently-played";
const EXCHANGE_TIMEOUT_MS = 20_000;
const LISTEN_TIMEOUT_MS = 5 * 60_000;
const TIMEOUT_MINS = Math.round(LISTEN_TIMEOUT_MS / 60_000);

const clientId = process.argv[2] ?? process.env.SPOTIFY_CLIENT_ID ?? "";
if (!clientId) {
  console.error("Usage: node scripts/get-refresh-token.mjs <client_id>");
  process.exit(1);
}
// The old form took the secret as a third argument. Fail loudly rather than ignoring it:
// someone following stale instructions has already leaked it into their shell history, and
// silently prompting instead would leave them wondering why.
if (process.argv[3]) {
  console.error(
    "Refusing to take the client secret as an argument — command lines are visible to other\n" +
      "processes and saved in your shell history. Re-run without it and the script will\n" +
      "prompt (hidden), or set SPOTIFY_CLIENT_SECRET in the environment.\n\n" +
      "That secret has now been written to your shell history. Consider rotating it on the\n" +
      "Spotify dashboard, and clearing the entry."
  );
  process.exit(1);
}

/** Read a line from the terminal without echoing it. Resolves "" if the user just hits Enter. */
function promptHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true); // also turns off echo
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const done = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
    };
    // A paste arrives as one chunk, so walk it character by character.
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          done();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          done();
          process.exit(130); // Ctrl-C
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readClientSecret() {
  const fromEnv = process.env.SPOTIFY_CLIENT_SECRET;
  if (fromEnv) return fromEnv.trim();
  if (!process.stdin.isTTY) {
    // Piped or running under CI: nowhere to prompt, and we won't take it from argv.
    console.error(
      "No terminal to prompt on. Set SPOTIFY_CLIENT_SECRET in the environment, or run this\n" +
        "interactively so it can be entered with the input hidden."
    );
    process.exit(1);
  }
  return (
    await promptHidden(
      "Spotify client secret (hidden; press Enter to skip and use PKCE instead): "
    )
  ).trim();
}

const clientSecret = await readClientSecret();
if (!clientSecret) {
  console.log(
    "\nNo client secret — using PKCE. Spotify will rotate this refresh token on its first\n" +
      "use, so the value you store as a GitHub secret goes stale unless the workflow also\n" +
      "has SPOTIFY_CLIENT_SECRET set. Supplying the secret is recommended.\n"
  );
}

const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(12).toString("base64url");

const authUrl =
  "https://accounts.spotify.com/authorize" +
  `?response_type=code&client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&code_challenge_method=S256&code_challenge=${challenge}` +
  `&state=${state}&scope=${encodeURIComponent(SCOPE)}`;

/**
 * Trade the authorization code for a refresh token. Rejects on a transport failure — the
 * caller turns that into a readable message. A refusal Spotify actually answered with is
 * reported and exits here, since there is nothing further to try.
 */
async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  // Confidential apps authenticate with Basic auth; PKCE apps send client_id in the body.
  if (clientSecret) {
    headers.Authorization =
      "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  }
  // Node's fetch has no default timeout, and this one runs after the browser has been sent
  // away, so a stalled socket would leave the terminal sitting at "Waiting..." with nothing
  // left to time it out — `giveUp` below is unref'd and only covers the wait for the redirect.
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  if (!resp.ok) {
    console.error(`Token exchange failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const json = await resp.json();
  if (!json.refresh_token) {
    console.error("Spotify did not return a refresh token.");
    process.exit(1);
  }
  return json;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:8888");
  if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
    res.end("Waiting for Spotify...");
    return;
  }
  const err = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  // Fixed strings only. Reflecting `err` into the page would put an attacker-influenced query
  // parameter straight into HTML; the detail goes to the terminal below instead, which is
  // where the user is looking anyway.
  //
  // "Authorized" rather than "Done": at this point Spotify has approved the grant, but the
  // exchange that turns it into a token hasn't run yet and can still fail. The tab is answered
  // now regardless, so closing the browser never leaves it spinning on a request we're holding.
  res.setHeader("Content-Type", "text/html");
  res.end(
    err
      ? "<h2>Authorization failed — return to the terminal for details.</h2>"
      : "<h2>Authorized — return to the terminal for your refresh token.</h2>"
  );
  server.close();
  if (err || !code) {
    console.error(`Spotify denied authorization: ${err ?? "no code returned"}`);
    process.exit(1);
  }

  let json;
  try {
    json = await exchangeCode(code);
  } catch (e) {
    // A transport failure -- DNS, a reset connection, our own deadline. Without this catch the
    // rejection escapes the handler and Node ends the process on a stack trace, printed over
    // the top of a browser tab that has just said the authorization worked. It did; what
    // failed is the exchange. The code is single-use and now spent, so the only advice is to
    // start again.
    console.error(
      `\nCouldn't exchange the authorization code: ${e.message}\n` +
        "Nothing was saved, and that code has been spent. Re-run to try again."
    );
    process.exit(1);
  }
  console.log("\nGranted scope:", json.scope ?? "(unknown)");
  console.log("\nSPOTIFY_REFRESH_TOKEN:\n");
  console.log(json.refresh_token);
  console.log(
    "\nAdd this as a repository secret (Settings -> Secrets and variables -> Actions)."
  );
  process.exit(0);
});

// Abandoning the browser tab used to leave this process listening forever, holding port 8888
// so the next attempt -- here or in the app -- could not bind. Give up the way the app does.
const giveUp = setTimeout(() => {
  console.error(
    `\nTimed out after ${TIMEOUT_MINS} minutes with no answer from Spotify. Nothing was` +
      "\nchanged; re-run to try again."
  );
  server.close();
  process.exit(1);
}, LISTEN_TIMEOUT_MS);
// The timer must not be the only thing holding the process open.
giveUp.unref();

server.on("error", (e) => {
  // Almost always EADDRINUSE: an in-progress Setlist login, or an earlier run of this script
  // still waiting. Both bind 8888, and the message should say so rather than print a stack.
  console.error(
    `\nCannot listen on 127.0.0.1:8888: ${e.message}\n` +
      "Is a Setlist login, or another run of this script, already in progress? Close it and\n" +
      "re-run."
  );
  process.exit(1);
});

server.listen(8888, "127.0.0.1", () => {
  console.log("Open this URL in your browser and approve access:\n");
  console.log(authUrl + "\n");
  console.log(`Waiting up to ${TIMEOUT_MINS} minutes for you to approve...\n`);
});
