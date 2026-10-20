// Which song catalog answers. Song ids say where a song came from (shared/catalog.js).
//   Search: a room whose host plays through Spotify (its 'service' message) searches Spotify's
//   catalog when the server has SPOTIFY_CLIENT_SECRET; if Spotify is busy or down, iTunes. Every
//   other room, and browsing before joining, searches iTunes. Spotify content is never used for
//   another service's playback (Spotify's Developer Policy), so it is never searched for them.
//   Lookup (a suggestion): by the id's own catalog. An 'sp:' id cannot fall back to iTunes.
//   Clean versions: searched in the song's own catalog.

import { ITUNES, SPOTIFY, catalogOf, itunesTrackId, kvId, legacySong, spotifyTrackId } from '../shared/catalog.js';
import { baseTitle, normalizeWords } from '../shared/filter.js';
import { MAX_DURATION_DIFF_MS } from '../shared/spotify.js';
import { CatalogError, cacheGet, cachePut } from './catalog-base.js';
import { lookupSong, searchSongs } from './itunes.js';
import { cleanSearchQuery, lookupSpotify, searchSpotify, spotifyCatalogConfigured } from './spotify-catalog.js';

const CLEAN_TTL_SECONDS = 7 * 24 * 60 * 60;

export { CatalogError, spotifyCatalogConfigured };

/** The catalog a room searches: 'sp' for a Spotify room on a server with the secret, else 'it'. */
export function roomCatalog(service, env) {
  return service === 'spotify' && spotifyCatalogConfigured(env) ? SPOTIFY : ITUNES;
}

/** Catalog names in API answers. */
export const CATALOG_NAMES = Object.freeze({ [ITUNES]: 'itunes', [SPOTIFY]: 'spotify' });

/**
 * Songs for a query from `catalog`, falling back from Spotify to iTunes.
 * @returns {Promise<{ songs: object[], catalog: 'it'|'sp' }>} the catalog that answered. Throws CatalogError.
 */
export async function searchCatalog(q, env, { catalog = ITUNES, fetchImpl } = {}) {
  if (catalog === SPOTIFY && spotifyCatalogConfigured(env)) {
    try {
      return { songs: await searchSpotify(q, env, { fetchImpl }), catalog: SPOTIFY };
    } catch (e) {
      if (!(e instanceof CatalogError)) throw e;
      console.error(JSON.stringify({ message: 'Spotify search failed; using iTunes', code: e.code }));
    }
  }
  return { songs: await searchSongs(q, env, { fetchImpl }), catalog: ITUNES };
}

/** The song with this id from its own catalog, or null (no such song, or Spotify not set up). Throws CatalogError. */
export async function lookupCatalog(id, env, { fetchImpl } = {}) {
  const catalog = catalogOf(id);
  if (catalog === ITUNES) return lookupSong(itunesTrackId(id), env, { fetchImpl });
  if (catalog === SPOTIFY && spotifyCatalogConfigured(env)) return lookupSpotify(spotifyTrackId(id), env, { fetchImpl });
  return null;
}

/**
 * True when `candidate` is the clean version of `song`: the same catalog, base title and artist,
 * and marked clean. iTunes marks clean edits 'cleaned'. Spotify has no such flag, so there it is
 * a non-explicit track of about the same length (a remix or live version runs longer or shorter).
 */
export function isCleanVersionOf(candidate, song) {
  const catalog = catalogOf(song?.id);
  if (!candidate || catalogOf(candidate.id) !== catalog || candidate.id === song.id) return false;
  if (baseTitle(candidate.title) !== baseTitle(song.title) || normalizeWords(candidate.artist) !== normalizeWords(song.artist)) return false;
  if (catalog === ITUNES) return candidate.explicit === 'cleaned';
  if (candidate.explicit !== 'notExplicit') return false;
  if (song.durationMs > 0 && candidate.durationMs > 0) return Math.abs(song.durationMs - candidate.durationMs) <= MAX_DURATION_DIFF_MS;
  return true;
}

/**
 * The clean version of an explicit song, or null. Looks in `alsoIn` (e.g. the same search
 * results) first; only searches the song's catalog when `allowSearch` is true. Cached per song
 * (clean:<id>, 7 days). Throws CatalogError.
 */
export async function findCleanVersion(song, env, { alsoIn = [], allowSearch = true, fetchImpl } = {}) {
  const near = alsoIn.find((c) => isCleanVersionOf(c, song));
  if (near) return near;
  const key = `clean:${kvId(song.id)}`;
  const hit = await cacheGet(env, key);
  if (hit && typeof hit === 'object') return hit.song ? legacySong(hit.song) : null;
  if (!allowSearch) return null;
  const spotify = catalogOf(song.id) === SPOTIFY;
  if (spotify && !spotifyCatalogConfigured(env)) return null;
  const results = spotify
    ? await searchSpotify(cleanSearchQuery(baseTitle(song.title), song.artist), env, { pages: 1, fetchImpl })
    : await searchSongs(`${baseTitle(song.title)} ${song.artist}`, env, { fetchImpl });
  const clean = results.find((c) => isCleanVersionOf(c, song)) ?? null;
  await cachePut(env, key, { song: clean }, CLEAN_TTL_SECONDS);
  return clean;
}
