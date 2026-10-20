// Songs the AI does not know, judged from their lyrics (CLAUDE.md invariant 17). The room calls
// judgeFromLyrics through shared/filter.js aiThemeCheck (opts.lyrics) only while its AI check is on
// and only for a song the theme check answered UNKNOWN (or, under Instrumentals only, could not
// say whether it has singing). Never for Spotify songs (filter.js stops those first).
//   1. LRCLIB (lrclib.net, free, no key) is searched from the Worker: one GET /api/search, 4 s at
//      most, our User-Agent as their docs ask. A 429/503 is honoured: no calls until Retry-After.
//      Workers egress was checked on 2026-10-07 (a throwaway `wrangler dev --remote`): 200s in
//      about 140 ms, so no host-page relay is needed (iTunes is the one that refuses Cloudflare).
//   2. The record must be the song: base title + main artist + length within 5 s (shared/lyrics.js).
//   3. ONE THEME_MODEL call with shared/filter.js buildLyricsPrompt (lyrics as JSON data, never
//      instructions). Evidence that repeats 4+ words of the lyrics is replaced by the category's
//      plain sentence (shared/reasons.js categoryEvidence).
// The lyrics live only in this call: never cached, stored, logged or sent to a page. Only the
// verdict is cached (filter.js, `source: 'lyrics'`).
// Local tests only: LYRICS_TEST_BASE=http://127.0.0.1:<port> (a `wrangler dev --var`) sends the
// search to a fake LRCLIB. Only a loopback http address is taken, so the deployed site cannot be
// pointed anywhere else.

import { buildLyricsPrompt, parseThemeVerdict, quotesLyrics, runThemeModel } from '../shared/filter.js';
import { LRCLIB_BASE, LYRICS_MAX_BYTES, LYRICS_TIMEOUT_MS, LYRICS_USER_AGENT, lyricsSearchUrl, pickLyrics } from '../shared/lyrics.js';
import { categoryEvidence } from '../shared/reasons.js';

/** LRCLIB said 429/503: no calls before this (ms; in memory, per Worker instance). */
let backoffUntil = 0;
const BACKOFF_DEFAULT_S = 60;
const BACKOFF_MAX_S = 15 * 60;

/** Forget the backoff (tests). */
export function resetLyricsMemory() {
  backoffUntil = 0;
}

export function lyricsBase(env) {
  const test = String(env?.LYRICS_TEST_BASE ?? '');
  return /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(test) ? test : LRCLIB_BASE;
}

function retryAfterSeconds(res) {
  const raw = res.headers.get('retry-after');
  const n = Number(raw);
  if (raw && Number.isFinite(n)) return Math.min(Math.max(n, 1), BACKOFF_MAX_S);
  const at = raw ? Date.parse(raw) : NaN;
  if (Number.isFinite(at)) return Math.min(Math.max((at - Date.now()) / 1000, 1), BACKOFF_MAX_S);
  return BACKOFF_DEFAULT_S;
}

/**
 * Find the song's lyrics on LRCLIB.
 * @returns {Promise<{ status: 'lyrics', text: string } | { status: 'instrumental' } | { status: 'none' }
 *   | { status: 'error', why: string }>}  'none': LRCLIB has no record of this recording
 */
export async function fetchLyrics(song, env, { fetchImpl = fetch, now = Date.now(), timeoutMs = LYRICS_TIMEOUT_MS } = {}) {
  if (now < backoffUntil) return { status: 'error', why: 'LRCLIB asked us to wait' };
  const controller = new AbortController();
  let timer;
  const started = Date.now();
  const ask = () => fetchImpl(lyricsSearchUrl(song, lyricsBase(env)), {
    headers: { 'user-agent': LYRICS_USER_AGENT, 'lrclib-client': LYRICS_USER_AGENT, accept: 'application/json' },
    signal: controller.signal,
  });
  const work = (async () => {
    let res = await ask();
    // "ServerOverloaded" (503) usually says Retry-After: 1. One more try when that fits in the time.
    if (res.status === 503) {
      const wait = retryAfterSeconds(res) * 1000;
      if (wait <= 2000 && Date.now() - started + wait < timeoutMs - 500) {
        await new Promise((r) => setTimeout(r, wait));
        res = await ask();
      }
    }
    if (res.status === 429 || res.status === 503) {
      backoffUntil = Date.now() + retryAfterSeconds(res) * 1000;
      return { status: 'error', why: `LRCLIB ${res.status}` };
    }
    if (res.status === 404) return { status: 'none' };
    if (!res.ok) return { status: 'error', why: `LRCLIB ${res.status}` };
    if (!/json/i.test(res.headers.get('content-type') ?? '')) return { status: 'error', why: 'LRCLIB answer was not JSON' };
    const body = await res.text();
    if (body.length > LYRICS_MAX_BYTES) return { status: 'error', why: 'LRCLIB answer too big' };
    let records;
    try {
      records = JSON.parse(body);
    } catch {
      return { status: 'error', why: 'LRCLIB answer was not JSON' };
    }
    if (!Array.isArray(records)) return { status: 'error', why: 'LRCLIB answer was not a list' };
    const picked = pickLyrics(records, song);
    if (!picked) return { status: 'none' };
    return picked.kind === 'lyrics' ? { status: 'lyrics', text: picked.text } : { status: 'instrumental' };
  })();
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: 'error', why: 'LRCLIB timed out' });
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (e) {
    return { status: 'error', why: `LRCLIB unreachable: ${String(e?.message ?? e).slice(0, 80)}` };
  } finally {
    clearTimeout(timer);
    work.catch(() => {}); // a late failure after the timeout
  }
}

/**
 * Judge a song from its lyrics (aiThemeCheck opts.lyrics).
 * @param {object} song
 * @param {object} env  AI binding, LYRICS_TEST_BASE
 * @param {{ needTheme: boolean, needInstrumental?: boolean, allow?: () => (boolean|Promise<boolean>),
 *   fetchImpl?: typeof fetch }} opts  allow: the room's and the global rate limits (false: not now)
 * @returns {Promise<{ status: 'judged', verdict?: string, category?: string|null, evidence?: string }
 *   | { status: 'instrumental' } | { status: 'none' } | { status: 'error', why: string, aiFailed?: boolean }>}
 *   'judged' without a verdict: lyrics found but the theme was not wanted (no AI call)
 */
export async function judgeFromLyrics(song, env, { needTheme, allow, fetchImpl } = {}) {
  if (allow && !(await allow())) return { status: 'error', why: 'lyrics rate limit' };
  const found = await fetchLyrics(song, env, { fetchImpl });
  if (found.status === 'error') {
    console.error(JSON.stringify({ message: 'lyrics lookup failed', song: song.id, why: found.why }));
    return found;
  }
  if (found.status !== 'lyrics') return found;
  if (!needTheme) return { status: 'judged' };
  let text;
  try {
    text = await runThemeModel(env, buildLyricsPrompt(song, found.text));
  } catch (e) {
    console.error(JSON.stringify({ message: 'AI lyrics check failed', song: song.id, error: String(e) }));
    return { status: 'error', why: 'AI failed', aiFailed: true };
  }
  const r = parseThemeVerdict(text);
  let evidence = r.evidence;
  // Never a lyric: 4+ words in a row from the lyrics means the model quoted them.
  if (evidence && quotesLyrics(evidence, found.text)) evidence = '';
  if (r.verdict === 'inappropriate' && !evidence) evidence = categoryEvidence(r.category);
  return { status: 'judged', verdict: r.verdict, category: r.category, evidence };
}
