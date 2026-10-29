// Songs the AI does not know, judged from their lyrics (CLAUDE.md invariant 17). The room calls
// judgeFromLyrics through shared/filter.js aiThemeCheck (opts.lyrics) only while its AI check is on
// and only for a song the theme check answered UNKNOWN (or, under Instrumentals only, could not
// say whether it has singing). Never for Spotify songs (filter.js stops those first).
//   1. LRCLIB (lrclib.net, free, no key) is searched from the Worker: GET /api/search, 4 s at most
//      while a student waits (20 s for a song waiting in Needs a look or the night shift), our
//      User-Agent as their docs ask. Every call takes a turn in one shared line (src/lyrics-gate.js);
//      a 429/503 is honoured for everyone (no calls until Retry-After) and tried again while time allows.
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

/** LRCLIB said 429/503: no calls before this (ms; in memory, per Worker instance, when there is no LYRICS_GATE). */
let backoffUntil = 0;
const BACKOFF_DEFAULT_S = 60;
const BACKOFF_MAX_S = 15 * 60;
/** The shared line (src/lyrics-gate.js): turns at least this far apart, for everyone together. */
export const LYRICS_SPACING_MS = 1000;
/** A Retry-After longer than this is not waited out inside one lookup. */
const RETRY_WAIT_MAX_MS = 5000;
/** At most this many calls in one lookup (the first and its retries). */
const LYRICS_TRIES = 4;
/** What one call to LRCLIB needs of a lookup's time (about 150 ms normally). */
const CALL_MS = 1500;
/** The patient lookup (a song waiting in Needs a look, the night shift): no student is waiting on it. */
export const LYRICS_PATIENT_MS = 20_000;

/** Forget the backoff (tests). */
export function resetLyricsMemory() {
  backoffUntil = 0;
}

/**
 * The shared line's rule (src/lyrics-gate.js): the next turn starts after the last turn's spacing
 * and after any backoff. A turn that would start later than `maxWaitMs` from now is refused, and
 * the line is left as it was.
 * @returns {{ ok: boolean, waitMs: number, line: { nextAt: number, backoffUntil: number } }}
 */
export function gateDecision(line, now, maxWaitMs, spacingMs = LYRICS_SPACING_MS) {
  const start = Math.max(now, line.nextAt, line.backoffUntil);
  const waitMs = start - now;
  if (waitMs > Math.max(0, maxWaitMs)) return { ok: false, waitMs, line };
  return { ok: true, waitMs, line: { ...line, nextAt: start + spacingMs } };
}

/** The shared line's object, or null (no binding: tests; each Worker copy then keeps its own backoff). */
function gateOf(env) {
  try {
    return env?.LYRICS_GATE ? env.LYRICS_GATE.get(env.LYRICS_GATE.idFromName('lrclib')) : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * Find the song's lyrics on LRCLIB. With LYRICS_GATE, every call waits for its turn in the shared
 * line (src/lyrics-gate.js). A busy answer (429/503) is tried again while `timeoutMs` allows (a
 * short Retry-After only; the patient lookup, LYRICS_PATIENT_MS, has room for several).
 * @returns {Promise<{ status: 'lyrics', text: string } | { status: 'instrumental' } | { status: 'none' }
 *   | { status: 'error', why: string }>}  'none': LRCLIB has no record of this recording
 */
export async function fetchLyrics(song, env, { fetchImpl = fetch, now = Date.now(), timeoutMs = LYRICS_TIMEOUT_MS } = {}) {
  const gate = gateOf(env);
  if (!gate && now < backoffUntil) return { status: 'error', why: 'LRCLIB asked us to wait' };
  const controller = new AbortController();
  let timer;
  const started = Date.now();
  const left = () => started + timeoutMs - Date.now();
  const ask = () => fetchImpl(lyricsSearchUrl(song, lyricsBase(env)), {
    headers: { 'user-agent': LYRICS_USER_AGENT, 'lrclib-client': LYRICS_USER_AGENT, accept: 'application/json' },
    signal: controller.signal,
  });
  const work = (async () => {
    let res;
    for (let tries = 1; ; tries++) {
      if (gate) {
        // The line itself failing must not stop the lookup: then it just goes now.
        const turn = await gate.turn(left() - CALL_MS).catch(() => ({ ok: true, waitMs: 0 }));
        if (!turn.ok) return { status: 'error', why: 'LRCLIB line is full' };
        if (turn.waitMs > 0) await sleep(turn.waitMs);
      }
      res = await ask();
      if (res.status !== 429 && res.status !== 503) break;
      // "ServerOverloaded" (503) usually says Retry-After: 1. Try again while that fits in the time.
      const wait = retryAfterSeconds(res) * 1000;
      if (gate) await gate.backoff(wait / 1000).catch(() => {});
      if (tries >= LYRICS_TRIES || wait > RETRY_WAIT_MAX_MS || wait + CALL_MS > left()) {
        if (!gate) backoffUntil = Date.now() + wait;
        return { status: 'error', why: `LRCLIB ${res.status}` };
      }
      if (!gate) await sleep(wait); // with the gate, the next turn waits out the backoff
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
 *   fetchImpl?: typeof fetch, timeoutMs?: number }} opts  allow: the room's and the global rate limits (false: not now);
 *   timeoutMs: the whole LRCLIB lookup (LYRICS_TIMEOUT_MS by default; LYRICS_PATIENT_MS when no student waits)
 * @returns {Promise<{ status: 'judged', verdict?: string, category?: string|null, evidence?: string }
 *   | { status: 'instrumental' } | { status: 'none' } | { status: 'error', why: string, aiFailed?: boolean }>}
 *   'judged' without a verdict: lyrics found but the theme was not wanted (no AI call)
 */
export async function judgeFromLyrics(song, env, { needTheme, allow, fetchImpl, timeoutMs } = {}) {
  if (allow && !(await allow())) return { status: 'error', why: 'lyrics rate limit' };
  const found = await fetchLyrics(song, env, { fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
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
