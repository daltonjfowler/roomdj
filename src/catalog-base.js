// What the song catalogs (src/itunes.js, src/spotify-catalog.js) share: the error a page sees, the
// KV cache helpers and the query clean-up. src/catalog.js picks the catalog.

import { cleanQuery } from '../shared/itunes.js';

export { cleanQuery };

export const BUSY = 'The song search is busy right now. Wait a minute and try again.';
export const DOWN = 'The song search is not working right now. Try again in a little while.';

export class CatalogError extends Error {
  /**
   * @param {'busy'|'down'} code busy: rate limited (try again soon); down: anything else
   * @param {string} [message] the plain sentence a student sees
   */
  constructor(code, message = code === 'busy' ? BUSY : DOWN) {
    super(message);
    this.code = code;
  }
}

export async function cacheGet(env, key) {
  try {
    return (await env.CLASS_KV?.get(key, 'json')) ?? null;
  } catch (e) {
    console.error(JSON.stringify({ message: 'cache read failed', key, error: String(e) }));
    return null;
  }
}

export async function cachePut(env, key, value, ttl) {
  try {
    await env.CLASS_KV?.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.floor(ttl)) });
  } catch (e) {
    console.error(JSON.stringify({ message: 'cache write failed', key, error: String(e) }));
  }
}
