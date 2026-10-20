// The MusicKit developer token for the host page's Apple Music player (phase 5). Signed here from
// the secrets APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (shared/apple.js); the private key
// never leaves the Worker. The token is not a user secret (every MusicKit web page shows its own),
// but it is handed only to a host page with a valid host token (src/worker.js), and its `origin`
// claim limits it to this site.
//
// Each token lives 30 hours and is reused from memory until fewer than 25 hours are left, so a
// host page always gets one that outlasts a whole room day (rooms close within 24 hours).

import { appleConfigured, importAppleKey, mintDeveloperToken } from '../shared/apple.js';

export const APPLE_TTL_SECONDS = 30 * 60 * 60;
export const APPLE_MIN_LEFT_SECONDS = 25 * 60 * 60;

const cache = new Map(); // origin → { token, exp, keyId }
let imported = null; // { pem, key }

/** @returns {Promise<{ token: string, exp: number }>} */
export async function appleDeveloperToken(env, origin, now = Date.now()) {
  if (!appleConfigured(env)) throw new Error('Apple Music is not set up on this server.');
  const teamId = env.APPLE_TEAM_ID.trim();
  const keyId = env.APPLE_KEY_ID.trim();
  const hit = cache.get(origin);
  if (hit && hit.keyId === `${teamId}.${keyId}` && hit.exp - now / 1000 > APPLE_MIN_LEFT_SECONDS) return hit;
  if (imported?.pem !== env.APPLE_PRIVATE_KEY) imported = { pem: env.APPLE_PRIVATE_KEY, key: await importAppleKey(env.APPLE_PRIVATE_KEY) };
  const minted = await mintDeveloperToken({
    teamId, keyId, privateKey: imported.key, ttlSeconds: APPLE_TTL_SECONDS, origins: [origin], now,
  });
  const entry = { ...minted, keyId: `${teamId}.${keyId}` };
  if (cache.size > 8) cache.clear();
  cache.set(origin, entry);
  return entry;
}
