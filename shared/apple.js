// Apple Music helpers with no DOM, so Node tests can run them (phase 5).
//   - The MusicKit developer token: an ES256 JWT the Worker signs with WebCrypto from the secrets
//     APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (the .p8 file's text). Apple's rules: header
//     { alg: ES256, kid }, claims { iss: team id, iat, exp } with exp at most 6 months away, and an
//     optional `origin` array (Apple refuses the token from any other web origin).
//   - Matching an iTunes song to an Apple Music catalog song. An iTunes trackId is the same id as
//     the Apple Music catalog song in most storefronts, so that is tried first; otherwise a catalog
//     search by title and artist. School rule (like Spotify): an explicit song never plays. If
//     Apple only has the explicit version, the host page is told why and skips it.

import { artistScore, titleScore } from './spotify.js';
import { itunesTrackId } from './catalog.js';

/** Apple's longest allowed developer token life (seconds). */
export const APPLE_MAX_TTL_SECONDS = 15_777_000;
/** Team ID and Key ID are 10 letters and numbers. */
export const APPLE_ID_PATTERN = /^[A-Z0-9]{10}$/;
/** A catalog song this far from the iTunes length is a different recording. */
export const APPLE_MAX_DURATION_DIFF_MS = 10_000;

const encoder = new TextEncoder();

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const jsonPart = (value) => base64url(encoder.encode(JSON.stringify(value)));

/**
 * The DER bytes of a PKCS#8 private key in PEM form. Forgiving about how it was pasted: the
 * BEGIN/END lines are optional, and line breaks may be real or written as "\n".
 */
export function pemToDer(pem) {
  const body = String(pem ?? '')
    .replace(/-----(BEGIN|END)[^-]*-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/]+=*$/.test(body)) throw new Error('APPLE_PRIVATE_KEY is not a PEM private key.');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The .p8 key as a WebCrypto signing key (ECDSA P-256). */
export function importAppleKey(pem) {
  return crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** True when all three Apple secrets are set and look right (the private key is checked when used). */
export function appleConfigured(env) {
  return APPLE_ID_PATTERN.test(String(env?.APPLE_TEAM_ID ?? '').trim())
    && APPLE_ID_PATTERN.test(String(env?.APPLE_KEY_ID ?? '').trim())
    && String(env?.APPLE_PRIVATE_KEY ?? '').trim().length > 0;
}

/**
 * A MusicKit developer token. `privateKey` is the PEM text or an imported CryptoKey.
 * @returns {Promise<{ token: string, exp: number }>} exp in seconds since 1970
 */
export async function mintDeveloperToken({ teamId, keyId, privateKey, ttlSeconds = 12 * 60 * 60, origins = [], now = Date.now() }) {
  if (!APPLE_ID_PATTERN.test(teamId ?? '') || !APPLE_ID_PATTERN.test(keyId ?? '')) throw new Error('APPLE_TEAM_ID and APPLE_KEY_ID must be 10 letters and numbers.');
  const ttl = Math.min(APPLE_MAX_TTL_SECONDS, Math.max(60, Math.floor(ttlSeconds)));
  const iat = Math.floor(now / 1000);
  const claims = { iss: teamId, iat, exp: iat + ttl };
  if (origins.length) claims.origin = origins;
  const input = `${jsonPart({ alg: 'ES256', kid: keyId })}.${jsonPart(claims)}`;
  const key = typeof privateKey === 'string' ? await importAppleKey(privateKey) : privateKey;
  // WebCrypto's ECDSA signature is r || s (64 bytes), which is exactly the JWS ES256 form.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(input));
  return { token: `${input}.${base64url(new Uint8Array(sig))}`, exp: claims.exp };
}

// ---- Matching an iTunes song to an Apple Music catalog song ------------------------------------

/** A catalog item the player can start: a song with play parameters. */
export function applePlayable(item) {
  return item?.type === 'songs' && Boolean(item.id) && Boolean(item.attributes?.playParams);
}

/** Missing rating is not explicit: Apple leaves contentRating out for songs that are not rated. */
export const appleExplicit = (item) => item?.attributes?.contentRating === 'explicit';

/** How well a catalog song matches an iTunes song: a number, or 0 when it is not the same recording. */
export function appleScore(song, item) {
  if (!applePlayable(item)) return 0;
  const a = item.attributes;
  const t = titleScore(song.title, a.name);
  const ar = artistScore(song.artist, [{ name: a.artistName }]);
  if (t < 0.8 || ar < 0.8) return 0;
  let timing = 0.5;
  if (song.durationMs > 0 && a.durationInMillis > 0) {
    const diff = Math.abs(song.durationMs - a.durationInMillis);
    if (diff > APPLE_MAX_DURATION_DIFF_MS) return 0;
    timing = 1 - diff / APPLE_MAX_DURATION_DIFF_MS;
  }
  return t + ar + timing * 0.5;
}

/**
 * The best clean catalog song for an iTunes song out of search results:
 *   { status: 'ok', id, name } | { status: 'explicit' } | { status: 'none' }
 */
export function pickAppleMatch(song, items) {
  let best = null, bestScore = 0, sawExplicit = false;
  for (const item of items ?? []) {
    const score = appleScore(song, item);
    if (!score) continue;
    if (appleExplicit(item)) { sawExplicit = true; continue; }
    if (score > bestScore) { best = item; bestScore = score; }
  }
  if (best) return { status: 'ok', id: String(best.id), name: best.attributes.name };
  return { status: sawExplicit ? 'explicit' : 'none' };
}

/** Catalog search text for a song. */
export function appleSearchTerm(song) {
  return `${song.title} ${song.artist}`.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * Which catalog song plays an iTunes song. `byId(id)` → the catalog item or null; `search(term)`
 * → catalog song items. The iTunes trackId is tried first; an explicit or missing one falls back
 * to a search (which finds the clean version when there is one).
 */
export async function resolveAppleSong(song, { byId, search }) {
  const trackId = itunesTrackId(song.id);
  const direct = trackId ? await byId(String(trackId)).catch(() => null) : null;
  if (applePlayable(direct) && !appleExplicit(direct)) return { status: 'ok', id: String(direct.id), name: direct.attributes.name };
  const found = pickAppleMatch(song, await search(appleSearchTerm(song)));
  if (found.status === 'none' && applePlayable(direct) && appleExplicit(direct)) return { status: 'explicit' };
  return found;
}

/** Why Apple Music cannot play a song here (the host page adds "Skipping it."). */
export function appleSkipMessage(song, status) {
  const what = `"${song.title}" by ${song.artist}`;
  if (status === 'explicit') return `Apple Music only has the explicit version of ${what}.`;
  return `Apple Music does not have ${what}.`;
}
