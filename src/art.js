// The album art check on the Worker (protocol.js ALBUM ART, shared/art.js, CLAUDE.md invariant 22).
// The cover is fetched from mzstatic by the Worker itself (never from a page: invariant 2), at
// ART_FETCH_SIZE, sent to ART_MODEL once, and only the verdict is cached (KV art:v1:<key>). The
// image is dropped after the call: never stored, logged or sent anywhere else.

import {
  ART_MAX_BYTES, ART_MODEL, ART_TIMEOUT_MS, artFetchUrl, artKvKey, artOkName, artTtl, buildArtPrompt, parseArtVerdict,
  readArtVerdict, storedArtVerdict,
} from '../shared/art.js';
import { answerText } from '../shared/filter.js';
import { teacherKvKey } from './teacher-kv.js';

const FETCH_TIMEOUT_MS = 5000;

/** The cached verdict for a cover key, or null (none yet, or KV trouble). Never throws. */
export async function cachedArtVerdict(env, key) {
  try {
    return readArtVerdict(await env.CLASS_KV?.get(artKvKey(key), 'json'));
  } catch (e) {
    console.error(JSON.stringify({ message: 'art verdict read failed', error: String(e) }));
    return null;
  }
}

/** Did this teacher profile press "Show anyway" for the cover? Never throws. */
export async function teacherArtOk(env, key, profile) {
  try {
    return Boolean(await env.CLASS_KV?.get(teacherKvKey(artOkName(key), profile)));
  } catch (e) {
    console.error(JSON.stringify({ message: 'art show-anyway read failed', error: String(e) }));
    return false;
  }
}

/** "Show anyway": this teacher profile sees the cover from now on (no expiry, like approvals). */
export async function putTeacherArtOk(env, key, profile) {
  await env.CLASS_KV?.put(teacherKvKey(artOkName(key), profile), JSON.stringify({ at: Date.now() }));
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The cover as a data: URI (JPEG from mzstatic, at most ART_MAX_BYTES). Throws on any trouble. */
export async function fetchCover(url, fetchImpl = fetch) {
  const src = artFetchUrl(url);
  if (!src) throw new Error('not an mzstatic cover');
  // No redirects followed (Workers have no redirect: 'error'; a 3xx is simply not ok).
  const res = await fetchImpl(src, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
  if (!res.ok) throw new Error(`cover HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/^image\/(jpeg|png|webp)\b/.test(type)) throw new Error('cover is not an image');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length || bytes.length > ART_MAX_BYTES) throw new Error('cover size');
  return `data:${type.split(';')[0]};base64,${base64(bytes)}`;
}

/** One ART_MODEL call on a cover. Its { verdict, reason }; throws on any trouble. */
export async function runArtModel(env, dataUri) {
  if (!env?.AI) throw new Error('AI binding missing');
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('art check timed out')), ART_TIMEOUT_MS);
  });
  const run = env.AI.run(ART_MODEL, { messages: buildArtPrompt(dataUri), max_tokens: 60, temperature: 0 });
  const out = await Promise.race([run, timeout]).finally(() => clearTimeout(timer));
  const text = answerText(out);
  if (text === null) throw new Error('art answer had no text');
  return parseArtVerdict(text);
}

/**
 * Check one cover now and cache the verdict (ok / inappropriate: 180 days; unsure: 30 days).
 * Returns { verdict, reason }; throws on trouble (nothing cached: it is asked again next time).
 */
export async function checkCover(env, key, url, fetchImpl = fetch) {
  const uri = await fetchCover(url, fetchImpl);
  const v = await runArtModel(env, uri);
  try {
    await env.CLASS_KV?.put(artKvKey(key), storedArtVerdict(v), { expirationTtl: artTtl(v.verdict) });
  } catch (e) {
    console.error(JSON.stringify({ message: 'art verdict write failed', error: String(e) }));
  }
  return v;
}
