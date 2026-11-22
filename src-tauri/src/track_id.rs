//! The one rule for deciding whether two playlist entries are the same track.
//!
//! Playlist files store full `spotify:track:<id>` uris, while most of what has to match them
//! keys on the bare id: duplicate detection, the "this song is also in…" marks, the
//! audio-feature cache. The rule was written out three times — twice here and once in the
//! frontend (`bareId` in `src/metricsCalc.ts`) — and the two Rust copies had already drifted:
//! one rejected an empty id, the other happily used it as a map key. Since this rule decides
//! which track gets *removed* as a duplicate, drift in it loses data rather than looking
//! untidy, so it lives in one place per language with the same cases pinned on both sides.

/// The bare Spotify id in `uri`, or the uri itself when it doesn't carry one.
///
/// Two cases have no id to take. A `spotify:local:` uri belongs to a local file, which has no
/// catalog id at all and whose last segment is a duration — shared by plenty of unrelated
/// songs — so the whole uri is its identity. And a uri whose id is empty is malformed; giving
/// it the uri keeps it distinct, where returning `""` would make every malformed entry in the
/// library read as the same track.
///
/// A bare id passed in comes back unchanged, so callers can hand over either form.
pub fn bare_track_id(uri: &str) -> &str {
    if uri.starts_with("spotify:local:") {
        return uri;
    }
    match uri.rsplit(':').next() {
        Some(id) if !id.is_empty() => id,
        _ => uri,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same table as `bareId`'s in src/metricsCalc.test.ts. The two implementations can't
    /// share a test, so they share the cases instead.
    #[test]
    fn the_identity_of_a_track_is_its_bare_id() {
        assert_eq!(
            bare_track_id("spotify:track:4cOdK2wGLETKBW3PvgPWqT"),
            "4cOdK2wGLETKBW3PvgPWqT"
        );
        // Either form in, the same identity out, so a caller never has to normalize first.
        assert_eq!(
            bare_track_id("4cOdK2wGLETKBW3PvgPWqT"),
            "4cOdK2wGLETKBW3PvgPWqT"
        );
        assert_eq!(bare_track_id("spotify:track:x"), bare_track_id("x"));
    }

    #[test]
    fn a_local_file_keeps_its_whole_uri() {
        // Its last segment is the track's duration in seconds, which two unrelated local
        // files can easily share — taking it would merge them into one song.
        let local = "spotify:local:::Some+Song:210";
        assert_eq!(bare_track_id(local), local);

        let other = "spotify:local:::Another+Song:210";
        assert_ne!(bare_track_id(local), bare_track_id(other));
    }

    #[test]
    fn a_uri_with_no_id_stays_distinct_rather_than_becoming_a_shared_key() {
        assert_eq!(bare_track_id("spotify:track:"), "spotify:track:");
        assert_eq!(bare_track_id("spotify:episode:"), "spotify:episode:");
        // Which is the point: two malformed entries must not read as the same track.
        assert_ne!(
            bare_track_id("spotify:track:"),
            bare_track_id("spotify:episode:")
        );
    }

    #[test]
    fn an_empty_uri_is_its_own_identity() {
        assert_eq!(bare_track_id(""), "");
    }
}
