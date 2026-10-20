// YouTube Data API v3 on the server: which YouTube video plays an iTunes song (phase 4).
// The key (secret YOUTUBE_API_KEY) never leaves the Worker. Quota is 10,000 units a day and a
// search costs 100, so a song is searched once and its ranked video ids are kept in KV for 30 days
// (yt:<trackId>; YouTube's policies allow storing API data for at most 30 days). Ids that failed in
// the host's player are kept in the same entry and never picked again. When the quota is used up,
// yt:quota is set until midnight Pacific (when Google resets it) and nothing is asked until then.
// The scoring lives in shared/youtube-match.js.

import { SPOTIFY, catalogOf, kvId } from '../shared/catalog.js';
import { VIDEO_ID_PATTERN, rankCandidates, searchIds, searchParams, toCandidate } from '../shared/youtube-match.js';

const API = 'https://www.googleapis.com/youtube/v3';
export const YT_TTL_SECONDS = 30 * 24 * 60 * 60;
const NONE_TTL_SECONDS = 7 * 24 * 60 * 60; // no match: try again in a week
const QUOTA_KEY = 'yt:quota';
const FETCH_TIMEOUT_MS = 8000;
const QUOTA_REASONS = ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'];

/** KV key of a song's YouTube match: yt:<trackId> for iTunes songs (as before catalog ids). */
export const ytKey = (id) => `yt:${kvId(id)}`;

export const YOUTUBE_MESSAGES = {
  off: 'YouTube is not set up on this server.',
  quota: "YouTube's daily search limit is used up; using song previews until tomorrow.",
  none: 'No YouTube video matched this song.',
  down: 'YouTube is not answering right now.',
};

export class YoutubeError extends Error {
  /** @param {'off'|'quota'|'none'|'down'} code */
  constructor(code) {
    super(YOUTUBE_MESSAGES[code]);
    this.code = code;
  }
}

/** Seconds until the next midnight in California (YouTube's daily quota reset), at least 60. */
export function secondsToQuotaReset(now = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Math.max(60, 86_400 - (get('hour') * 3600 + get('minute') * 60 + get('second')));
  } catch {
    return 3600;
  }
}

/** The API's error answer → 'quota' or 'down'. */
export function classifyApiError(status, body) {
  const reasons = (body?.error?.errors ?? []).map((e) => e?.reason);
  if ((status === 403 || status === 429) && reasons.some((r) => QUOTA_REASONS.includes(r))) return 'quota';
  return 'down';
}

async function apiJson(path, params, env, fetchImpl) {
  params.set('key', env.YOUTUBE_API_KEY);
  let res;
  try {
    res = await fetchImpl(`${API}/${path}?${params}`, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error(JSON.stringify({ message: 'YouTube fetch failed', path, error: String(e) }));
    throw new YoutubeError('down');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = classifyApiError(res.status, body);
    // Never log the URL: it has the key in it.
    console.error(JSON.stringify({ message: 'YouTube API error', path, status: res.status, reasons: (body?.error?.errors ?? []).map((e) => e?.reason) }));
    throw new YoutubeError(code);
  }
  if (!body) throw new YoutubeError('down');
  return body;
}

async function kvGet(env, key) {
  try {
    return (await env.CLASS_KV?.get(key, 'json')) ?? null;
  } catch (e) {
    console.error(JSON.stringify({ message: 'cache read failed', key, error: String(e) }));
    return null;
  }
}

async function kvPut(env, key, value, ttl) {
  try {
    await env.CLASS_KV?.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.floor(ttl)) });
  } catch (e) {
    console.error(JSON.stringify({ message: 'cache write failed', key, error: String(e) }));
  }
}

/**
 * The video to play for `song` (from the server's own room state, never from a page).
 * `skip`: a video id that just failed in the player; it is remembered and the next one comes back.
 * @returns {Promise<{ videoId: string, cached: boolean }>} or throws YoutubeError
 */
export async function resolveVideo(song, env, { skip = null, fetchImpl = fetch, now = Date.now() } = {}) {
  // Never from Spotify's details (its Developer Policy: no use with another service's streams).
  if (catalogOf(song.id) === SPOTIFY) throw new YoutubeError('none');
  const key = ytKey(song.id);
  const hit = await kvGet(env, key);
  if (hit && Array.isArray(hit.ranked)) {
    const bad = Array.isArray(hit.bad) ? hit.bad : [];
    if (skip && VIDEO_ID_PATTERN.test(skip) && !bad.includes(skip)) {
      bad.push(skip);
      // Keep the entry's original 30-day end.
      const ttl = (hit.ranked.length ? YT_TTL_SECONDS : NONE_TTL_SECONDS) - (now - (hit.at ?? now)) / 1000;
      if (ttl > 60) await kvPut(env, key, { ...hit, bad }, ttl);
    }
    const pick = hit.ranked.find((id) => !bad.includes(id));
    if (pick) return { videoId: pick, cached: true };
    throw new YoutubeError('none');
  }

  if (!env.YOUTUBE_API_KEY) throw new YoutubeError('off');
  if (await kvGet(env, QUOTA_KEY)) throw new YoutubeError('quota');
  const bad = skip && VIDEO_ID_PATTERN.test(skip) ? [skip] : [];
  try {
    const ids = searchIds(await apiJson('search', searchParams(song), env, fetchImpl)); // 100 units
    let ranked = [];
    if (ids.length) {
      const videos = await apiJson('videos', new URLSearchParams({ part: 'snippet,contentDetails,status', id: ids.join(',') }), env, fetchImpl); // 1 unit
      const byId = new Map((videos.items ?? []).map((item) => [item?.id, toCandidate(item)]));
      // Back in search order: the rank is a small part of the score.
      ranked = rankCandidates(song, ids.map((id) => byId.get(id)).filter(Boolean), bad);
    }
    await kvPut(env, key, { ranked, bad, at: now }, ranked.length ? YT_TTL_SECONDS : NONE_TTL_SECONDS);
    if (!ranked.length) throw new YoutubeError('none');
    return { videoId: ranked[0], cached: false };
  } catch (e) {
    if (e instanceof YoutubeError && e.code === 'quota') await kvPut(env, QUOTA_KEY, { at: now }, secondsToQuotaReset(now));
    throw e;
  }
}
