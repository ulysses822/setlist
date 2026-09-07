# Contributing

Thanks for looking. Issues and pull requests are both welcome — including "this is confusing"
and "the README is wrong", which are as useful as code.

## Before you start

**Setlist only builds on Windows.** `src-tauri/src/lib.rs` has a `compile_error!` that says so,
and it's deliberate rather than an accident waiting to be fixed: the app leans on the Windows
Credential Manager for token storage and WebView2 for the renderer, and there is no tested
equivalent on the other platforms. If you want to change that, open an issue first — it's a
real piece of design work, not a build-flag change.

The frontend half (`src/`, `npm run build`) type-checks and builds anywhere, so documentation,
UI and TypeScript fixes are approachable from macOS and Linux. You just can't run the Rust
tests there.

## Setup

```bash
npm install
npm run tauri dev
```

You need your own Spotify app for a client ID — [Getting started](README.md#getting-started)
in the README walks through it. Tauri's own prerequisites (Rust, MSVC build tools) are at
<https://tauri.app/start/prerequisites/>.

## Before you open a PR

Run what CI runs:

```bash
npm run build   # tsc (strict) + vite build
npm test        # the Rust suite
npm run lint    # clippy, warnings denied
```

All three are green on `main` and CI blocks a merge if any of them isn't.

**Add a test with a behaviour change.** The Rust suite is where the sync engine's invariants
are written down — what a push does when the remote has moved, how a renamed playlist is
recognised, what happens to a staged edit that turns out to match the mirror. It's the only
thing between a refactor and someone's real playlists. There is no frontend test runner yet;
if you add one, that's a PR in its own right.

## Style

Rust is `cargo fmt` with the default settings, checked in CI. TypeScript has no formatter
configured — match the file you're editing.

Comments here explain **why**, not what. If a line looks odd, the odd part is what the comment
is for. If it doesn't look odd, it probably doesn't need one.

Commit subjects are a sentence in the imperative, no `feat:`/`fix:` prefix, describing the
change from the user's side rather than the code's:

```
Rename a playlist's file when the playlist is renamed
Stop the history logger losing a run to a race or a null track
```

Put the reasoning in the body. One concern per commit — a PR of four small commits is easier
to review, and much easier to revert, than one large one.

## Security

Don't report a vulnerability in a public issue. [SECURITY.md](SECURITY.md) explains what to do
instead, and describes the boundaries the app is trying to hold — worth reading before touching
anything under `src-tauri/src/spotify/`.

## Licence

Setlist is [GPL-3.0-only](LICENSE). Contributions are accepted under the same licence, and you
keep the copyright in what you write. There is no CLA.
