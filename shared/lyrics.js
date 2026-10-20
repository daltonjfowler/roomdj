// Lyrics for songs the AI theme check does not know (CLAUDE.md invariant 17). Pure functions: the
// LRCLIB search URL, picking the right record (base title + main artist + length), and tidying and
// cutting the lyrics for the prompt. The network part and the AI call are src/lyrics.js; the
// prompt is shared/filter.js buildLyricsPrompt. Lyrics are fetched, used once and dropped: never
// stored (KV, DO storage), logged or sent to a page.

import { LYRICS_MAX_CHARS, baseTitle, mainArtist, mainArtistName, normalizeWords, promptTitle } from './filter.js';

/** LRCLIB (lrclib.net/docs): free, no key; it asks clients to name themselves in User-Agent. */
export const LRCLIB_BASE = 'https://lrclib.net';
export const LYRICS_USER_AGENT = 'RoomDJ (https://roomdj.com)';
/** A record whose length is further than this from the song's is another recording. */
export const LYRICS_DURATION_SLACK_S = 5;
/** LRCLIB answers in about 150 ms; past this the song stays unknown (Needs a look). */
export const LYRICS_TIMEOUT_MS = 4000;
/** A bigger answer than this is not read (20 records of a few KB each is normal). */
export const LYRICS_MAX_BYTES = 1_500_000;

/** GET /api/search for the song: title without version labels, main artist. */
export function lyricsSearchUrl(song, base = LRCLIB_BASE) {
  const url = new URL('/api/search', base);
  url.searchParams.set('track_name', promptTitle(song?.title));
  url.searchParams.set('artist_name', mainArtistName(song?.artist) || String(song?.artist ?? ''));
  return url.href;
}

/** True when an LRCLIB record is this song: same base title, the main artist among its artists, length within 5 s. */
export function lyricsRecordMatches(record, song) {
  if (!record || typeof record !== 'object') return false;
  const want = baseTitle(song?.title) || normalizeWords(song?.title);
  const got = baseTitle(record.trackName ?? record.name) || normalizeWords(record.trackName ?? record.name);
  if (!want || want !== got) return false;
  const artist = mainArtist(song?.artist);
  if (!artist || !` ${normalizeWords(record.artistName)} `.includes(` ${artist} `)) return false;
  const seconds = Number(song?.durationMs) > 0 ? Number(song.durationMs) / 1000 : null;
  if (seconds === null) return true;
  const d = Number(record.duration);
  return record.duration !== null && Number.isFinite(d) && Math.abs(d - seconds) <= LYRICS_DURATION_SLACK_S;
}

/** Synced lyrics without their [mm:ss.xx] stamps. */
export function stripTimestamps(text) {
  return String(text ?? '').replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '').replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, '');
}

/**
 * Lyrics tidied for the prompt: control characters and stamps gone, spaces squeezed, at most one
 * empty line in a row, cut at a line end before `max` letters (the beginning is kept; a chorus
 * that repeats is fine).
 */
export function truncateLyrics(text, max = LYRICS_MAX_CHARS) {
  const lines = stripTimestamps(String(text ?? '').normalize('NFKC'))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim());
  const kept = [];
  for (const line of lines) {
    if (!line && (!kept.length || !kept[kept.length - 1])) continue;
    kept.push(line);
  }
  let s = kept.join('\n').trim();
  if (s.length > max) {
    const cut = s.lastIndexOf('\n', max);
    s = (cut > max / 2 ? s.slice(0, cut) : s.slice(0, max)).trim();
  }
  return s;
}

/**
 * The search answer → { kind: 'lyrics', text } (the first matching record with words; plain
 * lyrics first, else synced ones without stamps), { kind: 'instrumental' } (every matching record
 * is marked instrumental), or null (no match).
 */
export function pickLyrics(records, song) {
  if (!Array.isArray(records)) return null;
  const matches = records.filter((r) => lyricsRecordMatches(r, song));
  const words = (r) => (r.instrumental === true ? '' : String(r.plainLyrics ?? '').trim() || stripTimestamps(r.syncedLyrics ?? '').trim());
  const plain = matches.find((r) => r.instrumental !== true && String(r.plainLyrics ?? '').trim());
  const any = plain ?? matches.find((r) => words(r));
  if (any) {
    const text = truncateLyrics(words(any));
    if (text) return { kind: 'lyrics', text };
  }
  if (matches.length && matches.every((r) => r.instrumental === true)) return { kind: 'instrumental' };
  return null;
}
