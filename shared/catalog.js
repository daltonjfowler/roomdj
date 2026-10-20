// Song ids. A song comes from one catalog, and its id says which:
//   'it:<iTunes trackId>'      iTunes Search (the default catalog, with 30-second previews)
//   'sp:<Spotify track id>'    Spotify's catalog (only in a room that plays through Spotify:
//                              Spotify's Developer Policy forbids using its content for another
//                              service's playback; see src/spotify-catalog.js)
// Rooms, KV entries and pages from before catalog ids used the bare iTunes number (`trackId`):
// songId() and legacySong() read those as 'it:<n>', and kvId() keeps iTunes KV keys in the old
// bare-number form, so old approvals, verdicts, bans and YouTube matches still count.

export const ITUNES = 'it';
export const SPOTIFY = 'sp';

const ITUNES_ID = /^it:([1-9]\d{0,15})$/;
const SPOTIFY_ID = /^sp:([0-9A-Za-z]{22})$/;
/** A Spotify track id: 22 base-62 characters. */
export const SPOTIFY_TRACK_ID = /^[0-9A-Za-z]{22}$/;

/** 'it' | 'sp' | null for anything that is not a valid song id. */
export function catalogOf(id) {
  if (typeof id !== 'string') return null;
  const it = ITUNES_ID.exec(id);
  if (it) return Number.isSafeInteger(Number(it[1])) ? ITUNES : null;
  return SPOTIFY_ID.test(id) ? SPOTIFY : null;
}

/**
 * A song id from what a page or old stored data sent: a valid id string as it is, a positive
 * whole number (an iTunes trackId from before catalog ids) as 'it:<n>'. Anything else: null.
 */
export function songId(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? `it:${raw}` : null;
  return catalogOf(raw) ? raw : null;
}

/** The iTunes trackId of an 'it:' song id, else null. */
export function itunesTrackId(id) {
  const m = ITUNES_ID.exec(String(id ?? ''));
  return m ? Number(m[1]) : null;
}

/** The Spotify track id of an 'sp:' song id, else null. */
export function spotifyTrackId(id) {
  const m = SPOTIFY_ID.exec(String(id ?? ''));
  return m ? m[1] : null;
}

/** The id part of KV keys: an iTunes song keeps the old bare number, others the whole id. */
export function kvId(id) {
  return itunesTrackId(id) !== null ? String(itunesTrackId(id)) : String(id);
}

/** The Spotify page of an 'sp:' song (Spotify's attribution rule: link back to it), else null. */
export function spotifyLink(id) {
  const t = spotifyTrackId(id);
  return t ? `https://open.spotify.com/track/${t}` : null;
}

/** A song stored before catalog ids ({ trackId: n }) with its id added; others as they are. */
export function legacySong(song) {
  if (!song || typeof song !== 'object' || song.id) return song;
  const id = songId(song.trackId);
  if (!id) return song;
  const { trackId, ...rest } = song;
  return { id, ...rest };
}
