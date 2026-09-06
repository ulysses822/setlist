/**
 * One-time helper: mint a Spotify refresh token for the GitHub Actions history poller
 * (the scripts/poll-plays.mjs that Setlist scaffolds into your data repo from
 * templates/poll-plays.mjs), scoped to ONLY user-read-recently-played.
 *
 * Don't reuse the desktop app's token — it carries full playlist/playback scopes, and two
 * clients refreshing the same grant would rotate each other's token out from under them.
 * This script performs its own authorization, so it gets an independent token.
 *
 * Usage:
 *   npx -y tsx scripts/get-refresh-token.ts <client_id> [client_secret]
 *
 * Pass the client secret (Spotify dashboard -> your app -> Settings) if the Actions
 * workflow has SPOTIFY_CLIENT_SECRET set: tokens refreshed with the secret (confidential
 * mode) are NOT rotated, so the GitHub secret stays valid indefinitely. Without it,
 * Spotify rotates the refresh token on every PKCE refresh and the stored secret goes
 * stale after the first run.
 *
 * Uses the same loopback redirect the desktop app registers (http://127.0.0.1:8888/callback),
 * so no Spotify dashboard changes are needed — but close any in-progress Setlist login
 * first, since both bind port 8888.
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const REDIRECT = "http://127.0.0.1:8888/callback";
const SCOPE = "user-read-recently-played";

const clientId = process.argv[2] ?? process.env.SPOTIFY_CLIENT_ID ?? "";
const clientSecret = process.argv[3] ?? process.env.SPOTIFY_CLIENT_SECRET ?? "";
if (!clientId) {
  console.error("Usage: npx -y tsx scripts/get-refresh-token.ts <client_id> [client_secret]");
  process.exit(1);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:8888");
  if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
    res.end("Waiting for Spotify...");
    return;
  }
  const err = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  res.setHeader("Content-Type", "text/html");
  res.end(
    err
      ? `<h2>Authorization failed: ${err}</h2>`
      : "<h2>Done — return to the terminal for your refresh token.</h2>"
  );
  server.close();
  if (err || !code) {
    console.error(`Spotify denied authorization: ${err ?? "no code returned"}`);
    process.exit(1);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (clientSecret) {
    headers.Authorization =
      "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  }
  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers,
    body,
  });
  if (!resp.ok) {
    console.error(`Token exchange failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const json = (await resp.json()) as { refresh_token?: string; scope?: string };
  if (!json.refresh_token) {
    console.error("Spotify did not return a refresh token.");
    process.exit(1);
  }
  console.log("\nGranted scope:", json.scope ?? "(unknown)");
  console.log("\nSPOTIFY_REFRESH_TOKEN:\n");
  console.log(json.refresh_token);
  console.log(
    "\nAdd this as a repository secret (Settings -> Secrets and variables -> Actions)." +
      (clientSecret
        ? ""
        : "\nNOTE: minted without a client secret — if the workflow also runs without" +
          "\nSPOTIFY_CLIENT_SECRET, Spotify will rotate this token on first use and the" +
          "\nstored secret will go stale. Recommended: set the client secret too.")
  );
  process.exit(0);
});

server.listen(8888, "127.0.0.1", () => {
  console.log("Open this URL in your browser and approve access:\n");
  console.log(authUrl + "\n");
});
