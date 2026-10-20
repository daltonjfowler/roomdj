// iTunes Search + lookup, mapped to the Song typedef in shared/protocol.js ('it:<trackId>' ids,
// shared/itunes.js toSong), with a KV cache. iTunes allows roughly 20 calls a minute per IP and
// answers 403/429 when it has had enough. Cloudflare Workers share their outgoing addresses, so
// from the Worker iTunes is "busy" for almost every uncached call: a room passes `fetchImpl` =
// its host relay (src/room.js), and the teacher's own browser makes the call.
// KV keys keep their form from before catalog ids (search:<q>, song:<trackId>); old entries
// without `id` are read through legacySong.

import { legacySong } from '../shared/catalog.js';
import { itunesLookupUrl, itunesSearchUrl, parseItunes, toSong } from '../shared/itunes.js';
import { CatalogError, cacheGet, cachePut, cleanQuery } from './catalog-base.js';

export { toSong };

const SEARCH_TTL_SECONDS = 24 * 60 * 60;
const SONG_TTL_SECONDS = 7 * 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 8000;

async function itunesJson(url, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    // The host relay (src/room.js) says why itself: "not answering", "busy".
    if (e instanceof CatalogError) throw e;
    console.error(JSON.stringify({ message: 'iTunes fetch failed', error: String(e) }));
    throw new CatalogError('down');
  }
  if (res.status === 403 || res.status === 429) {
    console.error(JSON.stringify({ message: 'iTunes rate limited', status: res.status }));
    throw new CatalogError('busy');
  }
  if (!res.ok) {
    console.error(JSON.stringify({ message: 'iTunes error', status: res.status }));
    throw new CatalogError('down');
  }
  // iTunes sends text/javascript with leading blank lines; parse the text ourselves.
  const results = parseItunes(await res.text().catch(() => ''));
  if (!results) throw new CatalogError('down');
  return { results };
}

/** @returns {Promise<import('../shared/protocol.js').Song[]>} throws CatalogError */
export async function searchSongs(q, env, { fetchImpl } = {}) {
  const query = cleanQuery(q).toLowerCase();
  if (!query) return [];
  const key = `search:${query}`;
  const hit = await cacheGet(env, key);
  if (Array.isArray(hit)) return hit.map(legacySong);
  const data = await itunesJson(itunesSearchUrl(query), fetchImpl);
  const songs = (Array.isArray(data?.results) ? data.results : []).map(toSong).filter(Boolean);
  await cachePut(env, key, songs, SEARCH_TTL_SECONDS);
  return songs;
}

/** @returns {Promise<import('../shared/protocol.js').Song|null>} null when iTunes has no such song */
export async function lookupSong(trackId, env, { fetchImpl } = {}) {
  if (!Number.isSafeInteger(trackId) || trackId <= 0) return null;
  const id = `it:${trackId}`;
  const key = `song:${trackId}`;
  const hit = legacySong(await cacheGet(env, key));
  if (hit && hit.id === id) return hit;
  const data = await itunesJson(itunesLookupUrl(trackId), fetchImpl);
  const song = (Array.isArray(data?.results) ? data.results : []).map(toSong).find((s) => s?.id === id) ?? null;
  if (song) await cachePut(env, key, song, SONG_TTL_SECONDS);
  return song;
}
