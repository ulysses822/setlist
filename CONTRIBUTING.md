# Contributing

Thanks for looking. Issues and pull requests are both welcome — including "this is confusing"
and "the README is wrong", which are as useful as code.

Before starting anything large, read [ROADMAP.md](ROADMAP.md). Nothing is planned, but it
lists what's out of scope — cheaper than writing something that was never going to be merged.

## Before you start

**Setlist only builds on Windows.** `src-tauri/src/spotify/auth.rs` has a `compile_error!` that
says so, and it's deliberate rather than an accident waiting to be fixed: the app leans on the
Windows Credential Manager for token storage and WebView2 for the renderer, and there is no
tested equivalent on the other platforms. If you want to change that, open an issue first —
it's a real piece of design work, not a build-flag change.

The frontend half (`src/`, `npm run build`) type-checks and builds anywhere, so documentation,
UI and TypeScript fixes are approachable from macOS and Linux. You just can't run the Rust
tests there.

## Setup

```bash
npm install
npm run tauri dev
```

You need your own Spotify app for a client ID — [Download](README.md#download) in the README
walks through it. Tauri's own prerequisites (Rust, MSVC build tools) are at
<https://tauri.app/start/prerequisites/>.

## Before you open a PR

Run what CI runs:

```bash
npm run build   # tsc (strict) + vite build
npm test        # both suites (vitest, then the Rust one)
npm run lint    # eslint, then clippy with warnings denied
```

All three are green on `main` and CI blocks a merge if any of them isn't. On macOS or Linux
the Rust half won't build, so run `npm run build`, `npm run test:web` and `npm run lint:web`
and leave the rest to CI.

**Add a test with a behaviour change.** Both suites are where the invariants are written down,
and they're the only thing between a refactor and someone's real playlists.

The Rust suite (`npm run test:rust`) covers what a push does when the remote has moved, how a
renamed playlist is recognised, what happens to a staged edit that turns out to match the
mirror — plus the token families and the credential names the uninstaller deletes.

The vitest suite (`npm run test:web`) covers the pure logic behind the editor: the diff you
review before pushing, the cleanup linter's duplicate and availability checks, and the feature
maths. It is `src/*.test.ts` next to the module under test, node environment, no jsdom — these
are functions, not components. Rendering is untested, and a component-testing setup would be a
PR in its own right.

## Style

Rust is `cargo fmt` with the default settings, checked in CI. TypeScript has no formatter
configured — match the file you're editing.

TypeScript is linted with `eslint .` (`npm run lint:web`), gated in CI. The rule set is
deliberately narrow, and [eslint.config.js](eslint.config.js) says why for each choice: the
type-aware rules that catch mistakes are on, the `no-unsafe-*` family that would demand
annotations on everything crossing the Tauri boundary is off, and the React Compiler rules
that ship with `eslint-plugin-react-hooks` are off because this app isn't built with the
compiler and holds several of those patterns on purpose.

`react-hooks/exhaustive-deps` is a warning rather than an error. There are nine of them today,
and each is a real question about whether a memo can serve a stale result — but the answer is
behavioural, so closing one means running the app, not just satisfying the linter. If you fix
one, say in the PR what you clicked. The count is pinned (`eslint . --max-warnings 9`), so the
list can shrink but not grow: answer one and lower the number in the same commit; a tenth
fails the build. Tests read as sentences in both languages
(`fn a_renamed_playlist_takes_its_file_and_its_saved_state_with_it`, `it("marks only the song
that moved, not everything after it")`); a name that says what should be true is worth more
than a comment explaining what the assertion means.

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

## Conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — one page, and short enough that one maintainer can
actually enforce it. The summary is: criticise the code, not the person.

## Security

Don't report a vulnerability in a public issue. [SECURITY.md](SECURITY.md) explains what to do
instead, and describes the boundaries the app is trying to hold — worth reading before touching
anything under `src-tauri/src/spotify/`.

## Licence

Setlist is [GPL-3.0-only](LICENSE). Contributions are accepted under the same licence, and you
keep the copyright in what you write. There is no CLA.
