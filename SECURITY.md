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

CI runs `npm audit` and `cargo audit` on every push and again weekly, `npm ci
--ignore-scripts` blocks install hooks, and Actions are pinned to commit SHAs.

## What it doesn't do

Your data repo is yours to protect. Setlist writes playlists and play history as plain files
and encrypts nothing, so keep that repo private.

The history logger runs in that repo and holds your client secret and a refresh token as
Actions secrets. Anyone with write access can read them. That's how Actions secrets work and
there's nothing Setlist can do about it.

Anything already running code as you can read the Credential Manager entry. A compromised
user account isn't a threat this defends against.

Bugs in Spotify's API or ReccoBeats belong to Spotify and ReccoBeats.
