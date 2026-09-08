# Roadmap

**Nothing is planned.** No dates, no commitments, no next release — and that's the honest
state of things rather than a placeholder.

This file exists anyway, because "what is this project going to do?" is a fair question and
"nothing scheduled, here's what I'd reach for if I do" is a more useful answer than silence.

## What this is

Setlist is a personal project. I built it because Spotify is a good way to listen to music
and a poor way to *maintain* a library, and I wanted my own playlists to be files I own with
a review step before anything gets rewritten. It does that, I use it, and it's finished in
the sense that it does the job I built it for.

It's public in case someone else has the same problem. That's the whole reason — no plans to
grow it, no ambition for it to become a product.

## What that means if you're looking at it

- **Features get built when and if I feel like it.** There's no backlog being worked through.
- **Issues get read.** Bug reports on things that are broken are genuinely useful and likely
  to get attention. Feature requests are welcome too, but "welcome" is not "planned".
- **If it turns out people actually use this, I'd take it more seriously.** Interest would
  change the calculus. Right now there isn't any to respond to, and I'd rather say so than
  imply a roadmap that doesn't exist.
- **It's [GPL-3.0](LICENSE), so you can fork it.** If you want something here that I'm not
  going to build, that's a real option and not a consolation prize.
- **It isn't abandoned.** It works, the checks are green, and I keep it building because I
  use it. Quiet stretches mean nothing needed doing.

## Ideas I'd most likely reach for first

Not commitments — just the ones I've thought about enough to know what they'd involve, in
case that's useful to someone deciding whether to fork or file something.

### Importing your Spotify listening history

The stale-track view is one of the more useful things here and it's nearly empty on your
first day: the history logger only knows what it has recorded since you installed it, and the
view is deliberately honest about that window.

Spotify will give you your **extended streaming history** on request — every play back to the
day you made the account, as JSON. Importing those files would fill the view with years of
data straight away. It reads files you already own into the same log the poller appends to,
so it needs no extra permissions and asks nothing of the Spotify API. It's the change with
the best ratio of usefulness to effort, which is why it's first here.

### Playlists built from a rule

A **mood goal** currently describes what a playlist should sound like, and Setlist flags the
tracks that miss it. Pointing that the other way — letting a goal *choose* tracks, by feature
range, availability, or how long since you last played something — is the obvious next move.

If I built it, the result would arrive as a **staged draft you review and push**, not a
playlist that rewrites itself. Self-updating playlists are a real feature and other tools do
them well (see [the comparison](README.md#how-it-compares)), but a playlist that changes
without being reviewed is the opposite of the point here.

### Recovering a deleted playlist

Deleting a playlist removes its file. If your data folder is a git repo and the playlist had
been committed, it's recoverable — but one created and deleted before its first commit is
gone for good. That's a poor edge in an app whose argument is that you don't lose things, and
it's the kind of thing I'd fix on principle rather than because anyone asked.

Smaller things I've considered and not started: re-checking track availability without a full
re-pull, merging two playlists, showing last-played in the editor rather than only in the
stale-track view, and a set-aside for in-progress edits.

## Things I'm not going to build

These aren't maybes. They're either someone else's problem or in tension with what this app
is for, and each links to a project that does it properly — several of them very well.

| Not happening here | Go here instead | Why |
|---|---|---|
| Listening statistics, dashboards, top artists | [your_spotify](https://github.com/Yooooomi/your_spotify) | Setlist reads play history to answer "what am I *not* listening to?" — a curation question. A stats product is a different app, and that's a good one |
| Matching Spotify's own audio-feature data | — | Spotify's full feature data now lives on an endpoint only its own client can reach. Getting at it means impersonating that client, which is fragile and against the rules. Setlist uses [ReccoBeats](https://reccobeats.com), which doesn't cover everything, and says so |
| Theming or modifying the Spotify client | [spicetify](https://github.com/spicetify/cli) | Setlist is a separate app and never touches your Spotify install — which is also why a Spotify update can't break it |
| Your own tags and ratings on tracks | [tagify](https://github.com/alexk218/tagify) | Setlist measures tracks rather than letting you annotate them. Both are reasonable; they're just different tools |
| Managing local audio files | [Playlist-Manager-SMP](https://github.com/regorxxx/Playlist-Manager-SMP) | Setlist has no concept of a file on disk being a song |
| Playlists that update themselves on a schedule | [sort-play](https://github.com/hoeci/sort-play) | Every change here is reviewed before it reaches Spotify. Automatic rewrites are the thing this was built to avoid |
| Auto-committing every edit to git | — | Deliberate: you get a review panel and curated commits, not one commit per keystroke |
| macOS and Linux builds | — | Not refused, but real work rather than a build flag. See [Platform support](README.md#platform-support) — a PR from someone who can actually run the result would be welcome |

Recommendation and discovery features are a no as well: Spotify already does that, and doing
it worse isn't interesting.

## Known rough edges

Stated because you'd rather know now than find out:

- **Nine `react-hooks/exhaustive-deps` warnings.** Each is a real question about whether a
  cached calculation can go stale. They're warnings rather than errors because answering one
  means running the app and watching it, not satisfying a linter.
- **No component tests.** The logic is well covered on both sides — 96 tests — but rendering
  isn't covered at all.
- **`Library.tsx` is long.** Three concerns have been pulled out into hooks; the track row and
  the main render are what's left.

None of these affect using the app. They're where I'd start if I were tidying, and where a
contributor would find something worth doing.

## Getting in touch

Open an issue. "I tried to do X and it was awkward" is more useful than a feature name — the
problem usually suggests a better answer than the one either of us started with.
[CONTRIBUTING.md](CONTRIBUTING.md) has the rest if you want to send a PR.
