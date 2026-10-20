// iTunes Search pieces with no I/O, shared by the Worker, the host page (which runs the room's
// iTunes calls: "the teacher's computer searches", see src/room.js) and the student page (browsing
// before joining). From Cloudflare's shared addresses iTunes answers 429 to most calls; from a
// school's own address it answers, and it sends Access-Control-Allow-Origin: *.
// The SERVER always maps raw iTunes results to Songs itself (toSong): a page only carries them.

import { QUERY_MAX } from './protocol.js';
import { baseTitle, normalizeWords } from './filter.js';
import { ITUNES, catalogOf } from './catalog.js';

/** The only iTunes addresses RoomDJ asks for (the host page refuses any other). */
export const ITUNES_URL = /^https:\/\/itunes\.apple\.com\/(search|lookup)\?[A-Za-z0-9%=&._~+!'()*-]{1,400}$/;
/** Most results one answer may carry. */
export const ITUNES_RESULTS_MAX = 50;
const TEXT_MAX = 300;
const ART = /^https:\/\/[a-z0-9-]+\.mzstatic\.com\/[A-Za-z0-9/._%-]{1,400}$/;
const PREVIEW = /^https:\/\/[a-z0-9.-]+\.(apple|mzstatic)\.com\/[A-Za-z0-9/._%~+-]{1,400}$/;

/** Trimmed, inner spaces collapsed, at most QUERY_MAX characters (whole ones: never half an emoji). */
export function cleanQuery(q) {
  return [...String(q ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ')].slice(0, QUERY_MAX).join('').trim();
}

export const itunesSearchUrl = (query) => `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=25&country=US`;
export const itunesLookupUrl = (trackId) => `https://itunes.apple.com/lookup?id=${trackId}&entity=song&country=US`;

const text = (v) => [...String(v ?? '')].slice(0, TEXT_MAX).join('');

/** The release year from iTunes releaseDate ('2013-11-21T08:00:00Z'), 1900 to next year; else 0 (not known). */
export function releaseYear(date, now = new Date()) {
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(typeof date === 'string' ? date : '');
  const y = m ? Number(m[1]) : 0;
  return y >= 1900 && y <= now.getUTCFullYear() + 1 ? y : 0;
}

/** iTunes result → Song ('it:<trackId>'), or null if it is not a playable song (shape checked). */
export function toSong(r) {
  if (!r || typeof r !== 'object' || r.kind !== 'song' || !Number.isSafeInteger(r.trackId) || r.trackId <= 0) return null;
  if (typeof r.previewUrl !== 'string' || !PREVIEW.test(r.previewUrl)) return null;
  const explicit = ['explicit', 'cleaned', 'notExplicit'].includes(r.trackExplicitness) ? r.trackExplicitness : 'notExplicit';
  const art = typeof r.artworkUrl100 === 'string' && ART.test(r.artworkUrl100) ? r.artworkUrl100 : '';
  const title = text(r.trackName).trim();
  if (!title) return null;
  return {
    id: `it:${r.trackId}`,
    title,
    artist: text(r.artistName),
    album: text(r.collectionName),
    artwork: art.replace(/\/\d+x\d+(bb)?\.(jpg|png|webp)$/, '/300x300bb.$2'),
    durationMs: Number.isFinite(r.trackTimeMillis) && r.trackTimeMillis > 0 ? Math.min(r.trackTimeMillis, 24 * 3600_000) : 0,
    explicit,
    previewUrl: r.previewUrl,
    genre: text(r.primaryGenreName).slice(0, 40),
    year: releaseYear(r.releaseDate), // 0 = not known (the recap's oldest / newest, decades)
  };
}

/** The fields toSong reads, nothing else (what the host page hands back to the server). */
export function trimResult(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  for (const k of ['kind', 'trackId', 'trackName', 'artistName', 'collectionName', 'artworkUrl100', 'trackTimeMillis', 'trackExplicitness', 'previewUrl', 'primaryGenreName', 'releaseDate']) {
    const v = r[k];
    if (typeof v === 'string') out[k] = v.slice(0, 500);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Parse an iTunes answer (text/javascript with leading blank lines) → its results array, or null. */
export function parseItunes(body) {
  try {
    const data = typeof body === 'string' ? JSON.parse(body) : body;
    return Array.isArray(data?.results) ? data.results : null;
  } catch {
    return null;
  }
}

/** True when `candidate` is the clean version of the iTunes song `song` (marked 'cleaned', same base title and artist). */
export function isCleanItunesVersion(candidate, song) {
  return catalogOf(candidate?.id) === ITUNES && catalogOf(song?.id) === ITUNES && candidate.id !== song.id
    && candidate.explicit === 'cleaned'
    && baseTitle(candidate.title) === baseTitle(song.title)
    && normalizeWords(candidate.artist) === normalizeWords(song.artist);
}
