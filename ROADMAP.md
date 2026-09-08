# Roadmap

Nothing is planned. Setlist is a personal project — I built it for my own library, and it's
public in case someone else has the same problem. Features happen when I feel like it.

Issues get read. Bugs are likely to get looked at; feature requests, no promises. It's
[GPL-3.0](LICENSE), so fork it if you want something I'm not going to build.

## Ideas I'd reach for first

Not commitments — just what's been thought through, in case that helps you decide whether to
fork or file something.

**Importing your Spotify listening history.** The stale-track view only knows what the logger
has recorded since you installed it. Spotify will give you your extended streaming history on
request — every play back to the day you made the account — and reading those files into the
same log would fill the view immediately. No extra permissions, nothing asked of the API.

**Playlists built from a rule.** A mood goal describes what a playlist should sound like and
flags the tracks that miss it; letting it *choose* tracks is the obvious inversion. It would
arrive as a staged draft you review, not a playlist that rewrites itself.

**Recovering a deleted playlist.** Delete one before its first commit and it's gone — a poor
edge in an app whose argument is that you don't lose things.

Considered, not started: re-checking availability without a full re-pull, merging two
playlists, last-played as an editor column, a set-aside for in-progress edits.

## Not happening

Each of these is someone else's problem, or in tension with what the app is for.

| | Instead | |
|---|---|---|
| Listening statistics and dashboards | [your_spotify](https://github.com/Yooooomi/your_spotify) | History here answers "what am I *not* playing?" — curation, not stats |
| Spotify's own audio-feature data | — | It lives on an endpoint only Spotify's client can reach. Setlist uses [ReccoBeats](https://reccobeats.com), which doesn't cover everything |
| Theming or modifying the Spotify client | [spicetify](https://github.com/spicetify/cli) | Setlist never touches your Spotify install — which is why a Spotify update can't break it |
| Your own tags and ratings on tracks | [tagify](https://github.com/alexk218/tagify) | Setlist measures tracks; it doesn't annotate them |
| Managing local audio files | [Playlist-Manager-SMP](https://github.com/regorxxx/Playlist-Manager-SMP) | No concept of a file on disk being a song |
| Playlists that update themselves | [sort-play](https://github.com/hoeci/sort-play) | Everything here is reviewed before it reaches Spotify |
| Auto-committing every edit to git | — | Curated commits, not one per keystroke |
| Recommendations and discovery | — | Spotify already does that |
| macOS and Linux builds | — | Real work rather than a build flag — see [Platform support](README.md#platform-support). A PR from someone who can run the result would be welcome |

## Rough edges

- Nine `react-hooks/exhaustive-deps` warnings. Each is a real question about whether a cached
  calculation can go stale, and answering one means running the app rather than satisfying a
  linter. The count is pinned in CI, so it can only go down.
- No component tests. The logic is covered on both sides; rendering isn't.
- `Library.tsx` is long. Three concerns are out in hooks; the track row and the main render
  aren't.

## Getting in touch

Open an issue — "I tried to do X and it was awkward" beats a feature name.
[CONTRIBUTING.md](CONTRIBUTING.md) if you want to send a PR.
