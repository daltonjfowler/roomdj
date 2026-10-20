// Spotify's catalog on the server: song search and one-track lookup with the Client Credentials
// flow (an app token for this server, no user login), for rooms that play through Spotify.
// Client id: the public SPOTIFY_CLIENT_ID var. Secret: SPOTIFY_CLIENT_SECRET (a Worker secret,
// never logged and never sent to a page). The app token is cached in memory and in KV
// (spotify:token) until 5 minutes before it runs out.
//
// Spotify's rules this follows (developer.spotify.com/policy and /terms, effective 15 May 2025):
//   - Spotify content is only used with Spotify playback ("Do not create any product or service
//     which is integrated with streams or content from another service"): src/catalog.js uses
//     this catalog only in a room whose host plays through Spotify.
//   - It never goes to an AI model (shared/filter.js).
//   - Pages show the Spotify icon with a link back to the track on Spotify.
//   - Metadata is cached only for a while (KV: searches 1 day, tracks 7 days).
// Development-mode limits (February 2026): search returns at most 10 tracks a call (so two pages
// for 20), there is no batch GET /tracks, and popularity, available_markets and linked_from are
// gone (none are used). Quota is per developer account; a 429 with reason QUOTA_EXCEEDED or a
// long Retry-After stops calls for a while (spotify:backoff), and src/catalog.js falls back to
// iTunes for searches.

import { CLIENT_ID_PATTERN } from '../shared/spotify.js';
import { SPOTIFY_TRACK_ID } from '../shared/catalog.js';
import { CatalogError, cacheGet, cachePut, cleanQuery } from './catalog-base.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const MARKET = 'US';
export const PAGE_SIZE = 10; // the development-mode maximum
const SEARCH_TTL_SECONDS = 24 * 60 * 60;
const SONG_TTL_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_KEY = 'spotify:token';
const BACKOFF_KEY = 'spotify:backoff';
const TOKEN_EARLY_MS = 5 * 60 * 1000;
const RETRY_MAX_SECONDS = 3;
const FETCH_TIMEOUT_MS = 8000;
const ARTWORK = /^https:\/\/i\.scdn\.co\/image\/[0-9A-Za-z]+$/;

/** True when the server can use Spotify's catalog: a Client ID and its secret are both set. */
export function spotifyCatalogConfigured(env) {
  return CLIENT_ID_PATTERN.test(String(env?.SPOTIFY_CLIENT_ID ?? '').trim()) && String(env?.SPOTIFY_CLIENT_SECRET ?? '').trim().length > 0;
}

// Local tests only: SPOTIFY_TEST_BASE=http://127.0.0.1:<port> (a `wrangler dev --var`) sends the
// token and API calls to a fake Spotify the browser test runs. Only a loopback http address is
// taken, so it cannot point the deployed site anywhere else.
function endpoints(env) {
  const test = String(env?.SPOTIFY_TEST_BASE ?? '');
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(test)) return { token: `${test}/api/token`, api: `${test}/v1` };
  return { token: TOKEN_URL, api: API };
}

/** In-memory app tokens, per client id and endpoint. */
const tokens = new Map();
let backoffUntil = 0;

/** Forget the in-memory token and backoff (tests). */
export function resetSpotifyMemory() {
  tokens.clear();
  backoffUntil = 0;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function appToken(env, { fetchImpl, now, fresh }) {
  const clientId = String(env.SPOTIFY_CLIENT_ID).trim();
  const { token: url } = endpoints(env);
  const mem = `${clientId}|${url}`;
  if (!fresh) {
    const m = tokens.get(mem);
    if (m && m.exp - now > TOKEN_EARLY_MS) return m.token;
    const hit = await cacheGet(env, TOKEN_KEY);
    if (hit?.token && hit.cid === clientId && hit.url === url && hit.exp - now > TOKEN_EARLY_MS) {
      tokens.set(mem, hit);
      return hit.token;
    }
  }
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${clientId}:${String(env.SPOTIFY_CLIENT_SECRET).trim()}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error(JSON.stringify({ message: 'Spotify token fetch failed', error: String(e) }));
    throw new CatalogError('down');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || typeof body?.access_token !== 'string' || !body.access_token) {
    // Status and Spotify's error code only: never the request (it carries the secret).
    console.error(JSON.stringify({ message: 'Spotify token refused', status: res.status, error: typeof body?.error === 'string' ? body.error : undefined }));
    throw new CatalogError(res.status === 429 ? 'busy' : 'down');
  }
  const seconds = Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600;
  const entry = { token: body.access_token, exp: now + seconds * 1000, cid: clientId, url };
  tokens.set(mem, entry);
  await cachePut(env, TOKEN_KEY, entry, seconds - TOKEN_EARLY_MS / 1000);
  return entry.token;
}

async function forgetToken(env) {
  tokens.clear();
  try {
    await env.CLASS_KV?.delete(TOKEN_KEY);
  } catch {
    // it runs out by itself
  }
}

async function backedOff(env, now) {
  if (backoffUntil > now) return true;
  const hit = await cacheGet(env, BACKOFF_KEY);
  if (hit?.until > now) {
    backoffUntil = hit.until;
    return true;
  }
  return false;
}

/** A Web API GET. null for 404 (and 400: not a valid id). Throws CatalogError. */
async function api(env, path, { fetchImpl = fetch, now = Date.now(), retried = false, fresh = false } = {}) {
  if (await backedOff(env, now)) throw new CatalogError('busy');
  const token = await appToken(env, { fetchImpl, now, fresh });
  let res;
  try {
    res = await fetchImpl(`${endpoints(env).api}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error(JSON.stringify({ message: 'Spotify fetch failed', error: String(e) }));
    throw new CatalogError('down');
  }
  if (res.status === 401 && !fresh) {
    await forgetToken(env);
    return api(env, path, { fetchImpl, now, retried, fresh: true });
  }
  if (res.status === 429) {
    const body = await res.json().catch(() => null);
    const quota = body?.reason === 'QUOTA_EXCEEDED' || body?.error?.reason === 'QUOTA_EXCEEDED';
    const header = Number(res.headers.get('retry-after'));
    const after = Number.isFinite(header) && header >= 0 ? header : 1;
    if (!quota && !retried && after <= RETRY_MAX_SECONDS) {
      await wait(Math.max(0.2, after) * 1000);
      return api(env, path, { fetchImpl, now: Date.now(), retried: true, fresh });
    }
    const seconds = Math.min(3600, Math.max(30, quota ? Math.max(after, 600) : after));
    backoffUntil = now + seconds * 1000;
    await cachePut(env, BACKOFF_KEY, { until: backoffUntil, quota }, seconds);
    console.error(JSON.stringify({ message: 'Spotify rate limited', quota, retryAfter: after }));
    throw new CatalogError('busy');
  }
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) {
    console.error(JSON.stringify({ message: 'Spotify API error', status: res.status }));
    throw new CatalogError('down');
  }
  const body = await res.json().catch(() => null);
  if (!body) throw new CatalogError('down');
  return body;
}

/** The album picture closest to 300 px (Spotify lists 640, 300 and 64), or ''. */
export function pickArtwork(images) {
  const ok = (Array.isArray(images) ? images : []).filter((i) => typeof i?.url === 'string' && ARTWORK.test(i.url));
  if (!ok.length) return '';
  const size = (i) => Number(i.width) || Number(i.height) || 0;
  const big = ok.filter((i) => size(i) >= 300).sort((a, b) => size(a) - size(b));
  return (big[0] ?? ok.sort((a, b) => size(b) - size(a))[0]).url;
}

/**
 * Spotify track object → Song ('sp:<id>'), or null when it is not a playable catalog track.
 * Spotify has no "cleaned" flag: explicit false is 'notExplicit', anything else 'explicit' (a
 * missing flag counts as explicit, like the host's Spotify player). No previewUrl: Spotify's
 * previews are not available to new apps.
 */
export function trackToSong(t) {
  if (!t || t.type !== 'track' || !SPOTIFY_TRACK_ID.test(t.id ?? '') || t.is_local || t.is_playable === false) return null;
  const title = String(t.name ?? '').trim();
  const artists = (Array.isArray(t.artists) ? t.artists : []).map((a) => String(a?.name ?? '').trim()).filter(Boolean);
  if (!title || !artists.length) return null;
  return {
    id: `sp:${t.id}`,
    title,
    artist: artists.join(', '),
    album: String(t.album?.name ?? ''),
    artwork: pickArtwork(t.album?.images),
    durationMs: Number.isFinite(t.duration_ms) && t.duration_ms > 0 ? t.duration_ms : 0,
    explicit: t.explicit === false ? 'notExplicit' : 'explicit',
    previewUrl: '',
  };
}

const searchPath = (q, offset) => `/search?${new URLSearchParams({ type: 'track', q, limit: String(PAGE_SIZE), offset: String(offset), market: MARKET })}`;

/**
 * Up to `pages` x 10 songs for a query (KV cache: search:sp:<pages>:<query>, 1 day).
 * The first page must work; a failed second page just leaves its songs out.
 * @returns {Promise<import('../shared/protocol.js').Song[]>} throws CatalogError
 */
export async function searchSpotify(q, env, { pages = 2, fetchImpl, now } = {}) {
  const query = cleanQuery(q).toLowerCase();
  if (!query) return [];
  const key = `search:sp:${pages}:${query}`;
  const hit = await cacheGet(env, key);
  if (Array.isArray(hit)) return hit;
  const first = await api(env, searchPath(query, 0), { fetchImpl, now });
  const bodies = [first];
  if (pages > 1 && (first?.tracks?.items?.length ?? 0) >= PAGE_SIZE && first?.tracks?.next) {
    const rest = await Promise.allSettled(Array.from({ length: pages - 1 }, (_, i) => api(env, searchPath(query, (i + 1) * PAGE_SIZE), { fetchImpl, now })));
    for (const r of rest) if (r.status === 'fulfilled') bodies.push(r.value);
  }
  const seen = new Set();
  const songs = [];
  for (const body of bodies) {
    for (const t of Array.isArray(body?.tracks?.items) ? body.tracks.items : []) {
      const song = trackToSong(t);
      if (song && !seen.has(song.id)) {
        seen.add(song.id);
        songs.push(song);
      }
    }
  }
  await cachePut(env, key, songs, SEARCH_TTL_SECONDS);
  return songs;
}

/**
 * One track by its Spotify id (GET /v1/tracks/{id}; KV song:sp:<id>, 7 days). null when Spotify
 * has no such track. Throws CatalogError.
 */
export async function lookupSpotify(trackId, env, { fetchImpl, now } = {}) {
  if (!SPOTIFY_TRACK_ID.test(trackId ?? '')) return null;
  const id = `sp:${trackId}`;
  const key = `song:${id}`;
  const hit = await cacheGet(env, key);
  if (hit?.id === id) return hit;
  const body = await api(env, `/tracks/${trackId}?market=${MARKET}`, { fetchImpl, now });
  const found = trackToSong(body);
  // Spotify may answer with a relinked copy for this market: it is the same song under the id asked for.
  const song = found ? { ...found, id } : null;
  if (song) await cachePut(env, key, song, SONG_TTL_SECONDS);
  return song;
}

/** Spotify search text for the clean version of a song: its base title and main artist. */
export function cleanSearchQuery(baseTitleText, artist) {
  const main = String(artist ?? '').split(',')[0].trim().replace(/"/g, '');
  return `track:"${String(baseTitleText).replace(/"/g, '')}" artist:"${main}"`;
}
