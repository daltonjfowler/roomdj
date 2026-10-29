// The song search students see: catalog results (src/catalog.js: iTunes, or Spotify's catalog in a
// room that plays through Spotify; KV cache) minus what the filter blocks before any AI call
// (explicit, blocklist, ban list), with an explicit song swapped for its clean version when there
// is one. Used by a room's search and by browsing before joining (GET /api/search, iTunes, with
// every teacher profile's saved default blocklist and bans). Never an AI call.

import { ITUNES, songId } from '../shared/catalog.js';
import { banKey, quickCheck } from '../shared/filter.js';
import { CATALOG_NAMES, CatalogError, findCleanVersion, searchCatalog } from './catalog.js';
import { teacherKvKey } from './teacher-kv.js';

const CLEAN_SEARCHES_PER_SEARCH = 3;

/**
 * The ban list (KV "banned" of the teacher profile: src/teacher-kv.js) as one Set: each banned song id (entries from before catalog ids
 * have an iTunes `trackId`: 'it:<n>'), and its banKey (the same song in any other version, from
 * either catalog). Empty when KV fails: the room's suggest check runs again.
 */
export async function readBanned(env, profile = null) {
  try {
    const list = await env.CLASS_KV?.get(teacherKvKey('banned', profile), 'json');
    const out = new Set();
    for (const b of Array.isArray(list) ? list : []) {
      const id = songId(b?.id ?? b?.trackId);
      if (id) out.add(id);
      const key = banKey(b ?? {});
      if (key) out.add(key);
    }
    return out;
  } catch (e) {
    console.error(JSON.stringify({ message: 'ban list read failed', error: String(e) }));
    return new Set();
  }
}

/**
 * Songs for query `q` a student may suggest, and which catalog they came from ('itunes' or
 * 'spotify': the page shows Spotify's attribution). Throws CatalogError when the catalog is busy or down.
 * @returns {Promise<{ results: object[], catalog: 'itunes'|'spotify' }>}
 */
export async function searchAllowed(q, env, { blocklist = [], banned = new Set(), notMusic = true, kidzBop = 'check', catalog = ITUNES, fetchImpl } = {}) {
  const found = await searchCatalog(q, env, { catalog, fetchImpl });
  const songs = found.songs;
  const ctx = { blocklist, banned, notMusic, kidzBop };
  const results = [];
  const seen = new Set();
  let cleanSearches = CLEAN_SEARCHES_PER_SEARCH;
  for (const song of songs) {
    let pick = song;
    const reason = quickCheck(song, ctx);
    if (reason === 'explicit') {
      try {
        pick = await findCleanVersion(song, env, { alsoIn: songs, allowSearch: false, fetchImpl });
        if (!pick && cleanSearches > 0) {
          cleanSearches--;
          pick = await findCleanVersion(song, env, { alsoIn: songs, allowSearch: true, fetchImpl });
        }
      } catch (e) {
        // The catalog is busy: just leave the explicit song out.
        if (!(e instanceof CatalogError)) throw e;
        pick = null;
      }
      if (pick && quickCheck(pick, ctx)) pick = null;
    } else if (reason) {
      pick = null;
    }
    if (pick && !seen.has(pick.id)) {
      seen.add(pick.id);
      results.push(pick);
    }
  }
  return { results, catalog: CATALOG_NAMES[found.catalog] };
}
