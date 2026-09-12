# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Setlist is a Tauri 2 desktop app (Rust backend, React 19 + TypeScript frontend) that mirrors
Spotify playlists into version-controlled JSON in a git repo the user owns. See `README.md` for
what it does and `CONTRIBUTING.md` for the full contributor rules.

## Windows only, and the build enforces it

`src-tauri/src/spotify/auth.rs` carries a `compile_error!` for every non-Windows target: without
keyring's `windows-native` backend the refresh token lands in an in-memory mock that forgets it,
so login would look like it worked and be gone by the next restart.

The frontend half type-checks and builds anywhere. On macOS or Linux, `npm run build`,
`npm run test:web` and `npm run lint:web` work; anything touching `cargo` does not.

## Commands

```bash
npm run tauri dev     # run the app (builds Rust, serves the frontend on :1420)
npm run build         # tsc (strict, noUnusedLocals/Parameters) + vite build
npm test              # test:web then test:rust
npm run lint          # lint:web then lint:rust
```

Individually: `test:web` (vitest), `test:rust` (cargo test), `lint:web` (eslint),
`lint:rust` (`cargo fmt --check` then `clippy -D warnings`). These are exactly what
`.github/workflows/ci.yml` runs, so green locally means green there.

One test at a time:

```bash
npx vitest run src/lint.test.ts                      # one file
npx vitest run -t "marks only the song that moved"   # one test by name
cargo test --manifest-path src-tauri/Cargo.toml safe_name   # substring match
```

Toolchain floors are enforced, not advisory: Node `^22.13 || ^24 || >=26` via `engines` plus
`engine-strict` in `.npmrc` (20, 23 and 25 are each rejected by something), and Rust 1.88 via
`rust-version`.

## Two traps that cost real time

**A unit test that constructs `AppState` kills the whole test binary.** `AppState::new()` builds
a `reqwest::Client`, and referencing that path from a test makes the binary fail to start with
`STATUS_ENTRYPOINT_NOT_FOUND` (`0xc0000139`) before any test runs — a DLL load failure, not a
logic failure. Every Rust test in this repo is a pure free function for this reason. Extract the
logic and test that.

**`lint:web` runs `--max-warnings 9`.** There are nine `react-hooks/exhaustive-deps` warnings and
they are deliberate (each is a behavioural question about a stale memo — see the reasoning in
`eslint.config.js`). The count is a ratchet: answer one and lower the number in the same commit;
a tenth fails the build.

## Architecture

**The data folder is the source of truth, not the app.** The app repo holds only code. Playlists
live as pretty-printed JSON in a separate git repo the user picks in Setup, alongside
`archived.json` / `pinned.json` / `goals.json` (committed), `staged/` and `cache/` (gitignored),
and `history/plays.jsonl`. `src-tauri/src/config.rs` resolves that folder; there is deliberately
no fallback, and `validate_data_dir_choice` refuses a folder inside anything an uninstall deletes.

**The edit lifecycle is the core abstraction.** A playlist file is the last-synced mirror. Edits
go to an in-memory draft, are *saved* to `staged/<file>.json`, and only reach Spotify on *push* —
which refuses if Spotify's snapshot id moved since the last sync (drift). `src/playlistDiff.ts`
computes what the user reviews; `src-tauri/src/spotify/sync.rs` plans the actual API calls.
Nothing writes to Spotify without going through that path.

**Two Spotify token families, and the separation is the app's main security claim.** The *main*
token carries every scope the backend needs and never crosses IPC. The *streaming* token carries
only what the Web Playback SDK needs and is the only token the webview ever sees, via the single
`get_streaming_token` command. There is no fallback from one to the other. This is enforced
rather than documented: `const` assertions in `spotify/auth.rs`, plus tests that fail if a
playlist scope appears in the streaming list or if that command is wired to the main accessor.
Treat any change under `src-tauri/src/spotify/` as security-relevant and read `SECURITY.md` first.

**Untrusted input.** A data repo can be cloned from anywhere, so its contents are not trusted:
`safe_name` (`spotify/store.rs`) rejects any playlist filename that isn't a single `.json`
component, `playlist_url` (`spotify.rs`) rejects any non-base-62 id before it reaches a request
path, and `git.rs` resolves `git` to an absolute path from `PATH` (skipping relative entries)
rather than letting `CreateProcess` search the working directory first.

### Rust (`src-tauri/src/`)

`lib.rs` is the whole IPC surface — every `#[tauri::command]`, each a thin wrapper that resolves
config and delegates. `spotify.rs` holds shared state, the rate-limiter (pacing, `Retry-After`,
cooldowns the UI counts down) and the HTTP client; `spotify/` splits into `auth` (PKCE, keychain,
loopback), `store` (reading/writing playlist files), `sync` (push planning), `player`.
`git.rs` shells out to the real `git` binary; `metrics.rs` fetches and caches ReccoBeats audio
features; `history.rs` reads the play log.

### Frontend (`src/`)

`api.ts` is the only module that calls `invoke` — the typed mirror of `lib.rs`. (The one other
route in is `rateLimit.tsx`, which `listen`s for the cooldown event the backend emits rather
than polling.) `Library.tsx` is the editor and still the largest file; four hooks carry its
concerns: `usePlaylistDraft` (the edit lifecycle above), `usePlaylistLibrary` (the collection),
`usePlaylistMetrics` (features, aggregates, outliers, goals) and `usePlaylistDoctor` (the
cleanup checks). `prefs.ts` keeps
curation and view state in the data folder rather than localStorage, cached in memory so reads
can stay synchronous during render.

Pure logic lives in `.ts` modules with `.test.ts` beside them (`playlistDiff`, `lint`,
`metricsCalc`, `format`) — node environment, no jsdom. Rendering is untested.

## Conventions

- Comments explain **why**, not what. If a line looks odd, the odd part is what the comment is
  for. The codebase is heavily commented in this style; match it.
- Add a test with a behaviour change. Tests read as sentences in both languages
  (`fn a_renamed_playlist_takes_its_file_and_its_saved_state_with_it`).
- Commit subjects are a sentence in the imperative with no `feat:`/`fix:` prefix, describing the
  change from the user's side. Reasoning goes in the body. One concern per commit.
- Rust is `cargo fmt` default. TypeScript has no formatter — match the file you are editing.
- Doc comments in TypeScript use `/** */` (not `///`, which TypeScript only reads as a
  triple-slash directive and will not show on hover).
- A UI change is not verified by a type-check. Run the app and say what you clicked.
