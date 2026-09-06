# Setlist

**Git principles for your Spotify playlists.** Setlist is a desktop app that turns your
playlists into version-controlled files you actually own — then gives you a safe editor,
a cleanup doctor, mood analytics, and a full player on top.

Spotify is a great way to listen to music and a terrible way to *maintain* a music
library. One mis-drag and a playlist you spent years curating is silently reordered.
Duplicates pile up. Songs grey out and vanish without notice. Your play history is
locked away. Setlist fixes this the way developers fixed it for code: **your playlists
become pretty-printed JSON files in a private git repo, and every change is staged,
diffed, and reviewed before it touches Spotify.**

![Setlist editing a playlist: the mood radar and per-track audio metrics, the sidebar
carrying the playlist's staged name and track count, and a bar counting the changes staged
against Spotify.](docs/screenshots/library.png)

## What it does

### Edit with a safety net
- Every playlist is a local file — the source of truth. Edits go to a **draft**, are
  **saved** locally, and only reach Spotify when you **push**.
- **Show changes** before pushing: an inline diff marks added, removed, and moved tracks
  against the Spotify mirror.
- **Drift detection:** if a playlist changed on Spotify since your last sync (another
  device, a collaborator), Setlist tells you on open and refuses to clobber it — you
  choose safe, merge, or overwrite.
- Edits that cancel out clean themselves up: add a song, remove it again, and the
  playlist is simply *unmodified* — no phantom "unsaved changes".
- One-click **revert** to the last synced state, any time.

### Keep the library clean
- The **cleanup doctor** scans everything: exact duplicates, near-duplicates (the same
  recording under different release IDs), including across playlists — with one-click,
  reviewable fixes that never write to Spotify behind your back.
- **Unavailable tracks** (greyed out in your region, removed from the catalog) are
  flagged, and Setlist suggests a playable identical replacement from your own library
  or Spotify search.
- **Archive** playlists out of sight without deleting them; optionally unfollow them on
  Spotify while keeping the file (and ownership) so nothing is ever lost.
- Pin favorites, filter, and search every song across every playlist.

### Understand your music
- Each playlist gets a **mood fingerprint**: a radar of valence, energy, danceability,
  acousticness, instrumentalness, liveness, and speechiness, with per-track values in
  sortable columns.
- **Outlier detection** flags songs that don't fit the playlist — either per metric
  ("this track's energy is way above the rest") or jointly across all eight dimensions,
  which catches *unusual combinations* no single metric reveals. Toggle whichever lens
  you prefer.
- Set a **mood goal** for a playlist (drag the bars) and Setlist flags every track that
  misses the target — curation with a direction.
- Audio features come from ReccoBeats and are cached locally, so the analytics keep
  working no matter what Spotify deprecates next.

### Play it, anywhere
- A built-in player (Spotify Premium) with a persistent playback bar: play any playlist
  from any track, seek, skip, volume.
- A **device picker** moves playback between Setlist, your phone, and your speakers
  mid-song — and when music plays elsewhere, the bar follows the session and stays in
  control.
- The sidebar shows where the music lives: an equalizer on the playlist you're playing
  from, and a subtle chip on every other playlist that also contains the current song.

### Own your history
- A tiny GitHub Actions workflow logs your recently-played tracks to an append-only
  `history/plays.jsonl` every 30 minutes — even with the app closed and the computer
  off. It lives in **your data repo**, not the app's code, so your history and its
  secrets stay with your private data. The Setup screen installs it and mints a
  minimal-scope token with one click each.

## Download

Installers are on the [Releases page](https://github.com/ulysses822/setlist/releases) —
take the `-setup.exe`, or the `.msi` if you deploy that way. Windows only; see
[Platform support](#platform-support) for why.

Two things the installer can't supply:

- **git, on your PATH.** The version-control panel drives the real `git` binary, so without
  it the versioning half of the app does nothing.
- **Your own Spotify app.** Create one at <https://developer.spotify.com/dashboard>, add
  `http://127.0.0.1:8888/callback` as a redirect URI, and keep the Client ID. Setlist ships
  no credentials of its own.

The installer isn't code-signed, so SmartScreen will stop you with "Windows protected your
PC" — **More info → Run anyway**. If that's a dealbreaker, build it yourself below.

Then, on first run, open the **Setup** tab: paste the Client ID, **Browse…** to a data
folder (a dedicated private git repo works best — keep it outside this app's folder, which
Setlist enforces), then **Connect Spotify** and **Pull** your playlists.

![The Setup tab: a field for the Spotify Client ID, a data-folder picker, the redirect URI
to register, and buttons to connect and pull playlists.](docs/screenshots/setup.png)

## Build from source

You need **Node.js**, **Rust** (<https://rustup.rs>), and the MSVC C++ build tools
(WebView2 ships with Windows 11). Details: <https://tauri.app/start/prerequisites/>.

```bash
npm install
npm run tauri dev
```

`npm run tauri build` produces a standalone `setlist.exe` plus the NSIS and MSI installers
under `src-tauri/target/release/`. You still need your own Spotify app and the Setup-tab
steps above.

### The listening-history logger (optional)

The logger runs in **your data repo's** GitHub Actions, keeping personal play history and
its CI secrets out of the app's code repo. Open **Setup → Listening-history logger** and:

1. **Install logger** — writes `.github/workflows/poll-plays.yml` and
   `scripts/poll-plays.mjs` into your data folder. Commit and push them to GitHub (the data
   repo must exist there with Actions enabled).
2. **Generate token** — mints a refresh token scoped to *only*
   `user-read-recently-played`, independent of the app's own login.
3. Add `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REFRESH_TOKEN` as
   secrets **on the data repo** (the Setup screen deep-links there), and the workflow takes
   it from there. (The client secret matters: refreshes authenticated with it don't rotate
   the token, so the secret never goes stale.)

Prefer the terminal? `npx -y tsx scripts/get-refresh-token.ts <client_id> <client_secret>`
mints the token, and `.env.example` shows how to run `templates/poll-plays.mjs` locally.

## Your data, your rules

The app repo holds only code. Everything personal lives in the data folder you choose:

| Path (data repo) | What it is |
|------|------|
| `playlists/*.json` | Source of truth — one pretty-printed, diff-friendly file per playlist (content only) |
| `archived.json`, `pinned.json` | Curation state |
| `history/plays.jsonl` | Append-only listening log |
| `cache/` | Derived/rebuildable, git-ignored — audio features and `sync-meta.json` (per-playlist snapshot id, last-synced time, cover URL) |

Because the data folder is a git repo, Setlist versions it **for you** — no terminal
needed. The top-bar chip shows when there's something to commit; open it to review every
change (it writes the commit message: which songs you added, removed, or reordered in each
playlist), then **Commit** and **Push** to your remote. Pulls, curation, and new playlists
are versioned the same way. (Merging stays a terminal job — if the remote has moved on, the
push tells you to pull first.)

Keep that repo **private**: playlists and play history are personal data. Your Spotify
refresh token never touches disk — it lives in the OS credential manager (Windows
Credential Manager) — and the webview runs under a strict CSP.

## Uninstalling

The uninstaller offers one checkbox — *Delete settings, unpushed edits and the saved Spotify
login*. Ticked, it removes three things:

| | |
|---|---|
| `%APPDATA%\com.setlist.app` | Your Client ID, the data-folder path, and `staged/` — where **Save** puts edits you haven't pushed yet |
| `%LOCALAPPDATA%\com.setlist.app` | The WebView2 profile, which holds per-playlist column layouts, mood goals, the theme choice and the frozen similarity-map axes |
| Windows Credential Manager | The Spotify refresh tokens |

**Your data folder is never touched.** Playlists, history and cache are yours and stay exactly
where they are, uninstall or not.

But push anything you care about first. Staged edits and mood goals live outside that folder,
so they are not in your git repo and they go with the checkbox. Leave it unticked and all of it
survives a reinstall.

## Good to know

- **Spotify Premium** is required for in-app playback and the device picker; everything
  else works without it.
- Your Spotify app runs in **Development Mode**: only users you allowlist in the
  dashboard can authorize it. For a personal tool, that's you — done.
- Spotify rate-limits aggressively. Setlist paces requests, honors cooldowns with a
  visible countdown, and pulls playlists individually by default so big libraries don't
  trip the limit.
- ReccoBeats doesn't cover every release — very new, obscure, or classical tracks may
  show no metrics. Setlist rechecks misses weekly.

## Platform support

Windows only, and the build enforces it.

The refresh token's only home on disk is the OS credential manager, which Setlist reaches
through the `keyring` crate's `windows-native` backend. Compile for macOS or Linux without
enabling the matching backend and `keyring` won't complain — it substitutes an in-memory
mock, login looks like it worked, and the token is gone by the next restart. That failure is
miserable to diagnose from the outside, so `src-tauri/src/spotify/auth.rs` stops the build
instead.

Porting means more than flipping that flag. You'd enable `apple-native` or
`sync-secret-service`, drop the guard, then re-test everything that assumes a particular
desktop: the loopback OAuth listener on `127.0.0.1:8888`, the `open` calls for the browser
and the file manager, and the `git` subprocess behind the version-control panel. PRs welcome
from someone who can actually run the result.

## License

[GPL-3.0-only](LICENSE). You may use, study, modify and redistribute Setlist; derivative
works must stay under the same license.

Setlist is an independent project, **not affiliated with or endorsed by Spotify AB**, and
"Spotify" is their trademark. You bring your own Spotify credentials and your own account —
the project ships neither. The GPL covers this source code; the playlist, track and
audio-feature data it fetches at runtime belongs to Spotify and
[ReccoBeats](https://reccobeats.com) under their terms.

## Project layout (for tinkerers)

| Path | Role |
|------|------|
| `src/` | React + TypeScript UI (library, editor, metrics, player) |
| `src-tauri/src/` | Rust core: Spotify client, OAuth, file I/O, sync engine |
| `templates/poll-plays.{mjs,yml}` | History logger scaffolded into your data repo (script + 30-min cron) |
| `scripts/get-refresh-token.ts` | One-time scoped-token mint (CLI) |
