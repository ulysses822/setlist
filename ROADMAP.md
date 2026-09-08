# Roadmap

What's likely to be built next, what isn't, and why.

This is a single-maintainer project, so treat everything here as intent rather than a
promise — there are no dates, and the order changes when something turns out to matter more
in practice. It's published because knowing what a project *won't* do is usually more useful
than knowing what it might.

## The thesis

Setlist exists to help you **decide what belongs in a playlist**, and to make sure that
decision survives — as a file you own, changed only after you've reviewed the change.
Everything below is judged against that. A feature that makes curation sharper is likely to
land; one that makes Setlist a more general Spotify client probably isn't, however good the
idea. [How it compares](README.md#how-it-compares) explains where that leaves other tools.

## Next up

Roughly in order. The ranking is value against risk, not how interesting each one is to
build.

### 1. Import your Spotify listening history

The stale-track view is one of the most useful things here, and it's nearly empty on your
first day — the history logger only knows what it has recorded since you installed it, and
the view is deliberately honest about that window.

Spotify will give you your **extended streaming history** on request: every play back to the
day you made the account, as JSON. Importing those files would fill the view with years of
data immediately, instead of asking you to wait a few months to find out which songs you
never actually play.

No extra permissions, nothing asked of the Spotify API — it reads files you already own into
the same log the poller appends to.

### 2. Playlists built from a rule

Today a **mood goal** describes what a playlist should sound like, and Setlist flags the
tracks that miss it. The obvious next step is to point that the other way: let a goal
*choose* tracks — by feature range, by availability, by how long it's been since you played
something, drawing from your other playlists.

The result would arrive the way every other change does: as a **staged draft you review and
push**, not a playlist that rewrites itself behind you. Self-updating playlists are a real
feature and other tools do them well — see [the comparison](README.md#how-it-compares) — but
a playlist that changes without being reviewed is the opposite of the point here.

### 3. Undo for a deleted playlist

Deleting a playlist removes its file. If your data folder is a git repo and the playlist had
been committed, it's recoverable — but one created and deleted before its first commit is
gone for good.

That's a poor edge in an app whose whole argument is that you don't lose things. Deleted
playlists should be recoverable whether or not you've committed lately.

## After that

- **Re-check availability without a full re-pull.** Tracks grey out on Spotify over time,
  but Setlist only learns this when it pulls a playlist, so the cleanup doctor's view of
  what's playable can quietly go stale.
- **Merge two playlists** — combine and de-duplicate, reviewed as a diff like any other
  change.
- **Last played, in the editor.** The data already exists but only appears in the
  stale-track view, which is the wrong place: you decide what to cut while you're looking at
  the playlist.
- Smaller curation ideas — set-aside/stash for in-progress edits, multi-select across
  playlists, labels beyond pin and archive — are all plausible and none are started.

## Not planned

None of these are bad ideas. They're either someone else's problem, solved better elsewhere,
or in tension with the thesis. Each links to a project that does it properly.

| Not planned | Go here instead | Why |
|---|---|---|
| Listening statistics, dashboards, top artists | [your_spotify](https://github.com/Yooooomi/your_spotify) | Setlist reads play history to answer "what am I not listening to?" — a curation question. A stats product is a different app, and that one is a good one |
| Matching Spotify's own audio-feature data | — | Spotify's full feature data now lives on an endpoint only its own client can reach. Getting at it means impersonating that client, which is fragile and against the rules. Setlist uses [ReccoBeats](https://reccobeats.com), which doesn't cover everything, and says so |
| Theming or modifying the Spotify client | [spicetify](https://github.com/spicetify/cli) | Setlist is a separate app and never touches your Spotify install — which is also why a Spotify update can't break it |
| Your own tags and ratings on tracks | [tagify](https://github.com/alexk218/tagify) | Setlist measures tracks rather than letting you annotate them. Both are reasonable; they're just different tools |
| Managing local audio files | [Playlist-Manager-SMP](https://github.com/regorxxx/Playlist-Manager-SMP) | Setlist has no concept of a file on disk being a song |
| Playlists that update themselves on a schedule | [sort-play](https://github.com/hoeci/sort-play) | Every change here is reviewed before it reaches Spotify. Automatic rewrites are the thing this app was built to avoid |
| Auto-committing every edit to git | — | Deliberate: you get a review panel and curated commits, not one commit per keystroke |
| macOS and Linux builds | — | Not refused, but real work rather than a build flag. See [Platform support](README.md#platform-support) — a PR from someone who can actually run the result is welcome |

Recommendation and discovery features are generally a no as well: Spotify already does that,
and doing it worse isn't interesting.

## Maintenance, and where help is welcome

Not features, but honest about the state of things:

- **Nine `react-hooks/exhaustive-deps` warnings.** Each is a real question about whether a
  cached calculation can go stale. They're warnings rather than errors because answering one
  means running the app and watching it, not satisfying a linter.
- **No component tests.** The logic is well covered on both sides; rendering isn't covered at
  all. A component-testing setup would be a worthwhile PR in its own right.
- **`Library.tsx` is long.** Three concerns have been extracted into hooks already; the track
  row and the main render are what's left.

## Influencing this

Open an issue. "I tried to do X and it was awkward" is more useful than a feature name — the
problem usually suggests a better solution than the one either of us started with, and
[CONTRIBUTING.md](CONTRIBUTING.md) has the rest.
