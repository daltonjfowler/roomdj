// Picking the YouTube video for an iTunes song (phase 4). Pure functions, no network: the Worker
// (src/youtube.js) does the two API calls and hands the answers here; Node tests check the scoring.
// There is no YouTube Music API, so this finds a regular YouTube video that is the same recording:
// "Artist - Topic" auto uploads and official audio first, never live, cover, remix or sped-up ones.

import { normalizeWords, promptTitle } from './filter.js';

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
/** Search results asked for (search.list costs 100 units however many come back). */
export const SEARCH_MAX_RESULTS = 5;
/** Scores below this are not the song: better a 30-second preview than the wrong video. */
export const MIN_SCORE = 20;

/** "Artist - Title official audio", the title without version labels. */
export function searchQuery(song) {
  return `${song.artist} - ${promptTitle(song.title)} official audio`;
}

/** search.list parameters, without the key. */
export function searchParams(song) {
  return new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    safeSearch: 'strict',
    videoCategoryId: '10', // Music
    maxResults: String(SEARCH_MAX_RESULTS),
    q: searchQuery(song),
  });
}

/** ISO 8601 duration ("PT3M25S", "P0D") → milliseconds; 0 when it cannot be read. */
export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso ?? ''));
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((x) => Number(x ?? 0));
  return (((d * 24 + h) * 60 + min) * 60 + s) * 1000;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
/** The API sends titles with HTML entities ("Don&#39;t Stop"). */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(amp|lt|gt|quot|apos|#39|#\d+);/g, (whole, name) =>
    ENTITIES[name] ?? (name.startsWith('#') ? String.fromCodePoint(Number(name.slice(1))) : whole));
}

/**
 * Search result ids, in the order YouTube ranked them (a search.list answer → videoIds).
 * @returns {string[]}
 */
export function searchIds(searchJson) {
  const items = Array.isArray(searchJson?.items) ? searchJson.items : [];
  return [...new Set(items.map((i) => i?.id?.videoId).filter((id) => VIDEO_ID_PATTERN.test(id ?? '')))];
}

/**
 * One videos.list item (part=snippet,contentDetails,status) → what the scoring needs.
 * @typedef {{ videoId: string, title: string, channel: string, durationMs: number,
 *   embeddable: boolean, public: boolean, ageRestricted: boolean, live: boolean }} Candidate
 * @returns {Candidate|null}
 */
export function toCandidate(item) {
  if (!item || !VIDEO_ID_PATTERN.test(item.id ?? '')) return null;
  const sn = item.snippet ?? {};
  const st = item.status ?? {};
  const cd = item.contentDetails ?? {};
  return {
    videoId: item.id,
    title: decodeEntities(sn.title),
    channel: decodeEntities(sn.channelTitle),
    durationMs: parseDuration(cd.duration),
    embeddable: st.embeddable === true,
    public: st.privacyStatus === 'public' || st.privacyStatus === 'unlisted',
    ageRestricted: cd.contentRating?.ytRating === 'ytAgeRestricted',
    live: (sn.liveBroadcastContent ?? 'none') !== 'none',
  };
}

// Words that mean "not the plain studio recording". Each counts only when the iTunes title does
// not have it too ("Live Forever", "Remix" singles). Whole words, so "Alive" is fine.
const SWEAR_WORDS = ['explicit', 'uncensored', 'dirty', 'nsfw'];
const OTHER_VERSION_WORDS = [
  'live', 'cover', 'remix', 'nightcore', 'sped up', 'speed up', 'slowed', 'reverb', '8d',
  'karaoke', 'instrumental', 'reaction', 'bass boosted', 'tutorial', 'lesson', 'mashup', 'parody',
  '1 hour', '10 hours', 'loop',
];

const has = (text, phrase) => ` ${text} `.includes(` ${phrase} `);
const squash = (text) => text.replace(/ /g, '');

/**
 * How well a video matches the song (higher is better); -Infinity when it must never play.
 * @param {import('./protocol.js').Song} song
 * @param {Candidate} c
 * @param {number} rank its place in YouTube's search order (0 = first)
 */
export function scoreCandidate(song, c, rank = 0) {
  if (!c || !c.embeddable || !c.public || c.ageRestricted || c.live) return -Infinity;
  const title = normalizeWords(c.title);
  const channel = normalizeWords(c.channel);
  const songTitle = normalizeWords(song.title);
  const plainTitle = normalizeWords(promptTitle(song.title));
  const artist = normalizeWords(song.artist);
  const mainArtist = normalizeWords(String(song.artist ?? '').split(/,|&| feat\.? | ft\.? | x /i)[0]);
  let score = 0;

  // The song title must be in the video title.
  if (plainTitle && has(title, plainTitle)) score += 30;
  else {
    const words = plainTitle.split(' ').filter((w) => w.length > 1);
    const found = words.filter((w) => has(title, w)).length;
    score += words.length && found / words.length >= 0.75 ? 10 : -80;
  }

  // Who uploaded it: "Artist - Topic" (YouTube's own audio uploads) > ArtistVEVO / the artist's
  // channel > a channel that names the artist > someone else.
  const topic = channel.endsWith(' topic') ? channel.slice(0, -' topic'.length) : null;
  if (topic !== null && (topic === artist || topic === mainArtist)) score += 40;
  else if (channel === artist || channel === mainArtist || squash(channel) === `${squash(mainArtist)}vevo`) score += 30;
  else if (mainArtist && (has(channel, mainArtist) || squash(channel).includes(squash(mainArtist)))) score += 15;
  else if (mainArtist && has(title, mainArtist)) score += 5;
  else score -= 20;

  if (has(title, 'official audio')) score += 10;
  else if (has(title, 'lyric') || has(title, 'lyrics') || has(title, 'lyric video')) score += 6;
  else if (has(title, 'official video') || has(title, 'official music video')) score += 4;

  for (const w of SWEAR_WORDS) if (has(title, w) && !has(songTitle, w)) score -= 150;
  for (const w of OTHER_VERSION_WORDS) if (has(title, w) && !has(songTitle, w)) score -= 100;

  // A clean (radio) version on iTunes: a "clean" upload is the safer pick.
  if (song.explicit === 'cleaned' && (has(title, 'clean') || has(title, 'radio edit'))) score += 20;

  // Same length as the iTunes recording? Music videos with intros run long.
  if (song.durationMs > 0 && c.durationMs > 0) {
    const off = Math.abs(c.durationMs - song.durationMs);
    if (off <= 15_000) score += 25;
    else if (off <= 30_000) score += 5;
    else if (off <= 60_000) score -= 15;
    else score -= 60;
  }

  return score + Math.max(0, SEARCH_MAX_RESULTS - rank);
}

/**
 * Video ids worth playing for the song, best first (scores of MIN_SCORE or more only).
 * `candidates` in YouTube's search order; `bad` holds ids that failed in the player before.
 * @returns {string[]}
 */
export function rankCandidates(song, candidates, bad = []) {
  const skip = new Set(bad);
  return candidates
    .map((c, rank) => ({ c, score: scoreCandidate(song, c, rank) }))
    .filter(({ c, score }) => c && !skip.has(c.videoId) && score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .map(({ c }) => c.videoId);
}
