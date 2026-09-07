# Security policy

## Reporting a vulnerability

Don't open a public issue. Use GitHub's private vulnerability reporting — the **Security**
tab, then **Report a vulnerability** — which opens a thread only the maintainer can see.

One person maintains this in their spare time. Expect a reply in days, and no bounty.

## Supported versions

The tip of `main`, and nothing else. Fixes aren't backported to older builds, so update
before reporting.

## What the app already does

Setlist holds a Spotify OAuth token and writes to a git repo on your disk, so that's where
the interesting surface is. If any of this turns out not to be true, it's worth a report.

The refresh token never touches disk — it goes to the Windows Credential Manager through the
`keyring` crate, and the access token stays in memory in the Rust process. The webview never
sees either one. It gets a separate streaming-scoped token instead, so a compromised renderer
can control playback but can't read or modify a playlist (`src-tauri/src/spotify/auth.rs`).
That holds even when the streaming grant is missing: there is no fallback to the main token,
so a failed grant means the player reports it and stays dead until you reconnect.

The production CSP has no `unsafe-inline`; the dev CSP relaxes `style-src` for Vite's HMR
(`src-tauri/tauri.conf.json`). The OAuth loopback listener binds `127.0.0.1:8888` only while
a login is in flight, matches the exact callback path, and rejects anything else that hits
the port. Only one instance runs at a time, because two would rotate each other's refresh
token and trip Spotify's reuse detection.

The contents of your data folder are treated as untrusted input, because a data repo can be
cloned from anywhere. A playlist's `spotify_id` is checked against Spotify's base-62 id format
before it is put in a request path (`playlist_url` in `src-tauri/src/spotify.rs`); the URL
parser resolves dot segments before sending, so an unchecked id of `../me/player/pause` could
otherwise point a write made with the full-scope token at a different endpoint. The filename a
playlist is stored under must likewise be a single path component with no `:` in it
(`safe_name` in `src-tauri/src/spotify/store.rs`), so nothing in the folder can name a path
outside it.

Every workflow pins its actions to commit SHAs and installs with `npm ci --ignore-scripts`, so
neither a hijacked action tag nor an npm install hook gets to run in CI. `ci.yml` builds the
frontend and runs the Rust tests and clippy on every push to `main` and every pull request.
`audit.yml` runs `npm audit` and `cargo audit` when either lockfile changes, and again every
Monday — a source-only push doesn't re-run them, because neither auditor reads source; the
schedule is what catches an advisory published against pins that never moved. Two quick-xml
advisories (RUSTSEC-2026-0194/0195) are ignored there by name: they sit in Tauri's build-time
config parser rather than in shipped code, and clearing them needs a new Tauri release.

## What it doesn't do

Your data repo is yours to protect. Setlist writes playlists and play history as plain files
and encrypts nothing, so keep that repo private.

The history logger runs in that repo and holds your client secret and a refresh token as
Actions secrets. Anyone with write access can read them. That's how Actions secrets work and
there's nothing Setlist can do about it.

Anything already running code as you can read the Credential Manager entry. A compromised
user account isn't a threat this defends against.

Bugs in Spotify's API or ReccoBeats belong to Spotify and ReccoBeats.
