// "The teacher's computer searches" (src/host-relay.js): the room asks this page for an iTunes call
// ({ t: 'lookup', id, url }), because iTunes refuses most calls from Cloudflare's shared addresses
// but answers the school's own. This page fetches only RoomDJ's two iTunes addresses, at most
// PER_MINUTE a minute (one school address: be polite to Apple), and sends back the raw fields the
// server maps and checks itself ({ t: 'lookupResult', id, status, results }).

import { ITUNES_RESULTS_MAX, ITUNES_URL, parseItunes, trimResult } from '../../shared/itunes.js';

export const PER_MINUTE = 20;
const TIMEOUT_MS = 5000;
let asked = [];

/** Answer one lookup job; `send(msg)` goes to the room. */
export async function answerLookup(msg, send) {
  const id = String(msg?.id ?? '');
  const reply = (status, results) => send(results ? { t: 'lookupResult', id, status, results } : { t: 'lookupResult', id, status });
  const url = String(msg?.url ?? '');
  if (!id || !ITUNES_URL.test(url)) return reply(400);
  const now = Date.now();
  asked = asked.filter((t) => now - t < 60_000);
  if (asked.length >= PER_MINUTE) return reply(429);
  asked.push(now);
  let r;
  try {
    r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return reply(e?.name === 'TimeoutError' ? 504 : 0);
  }
  if (!r.ok) return reply(r.status);
  const results = parseItunes(await r.text().catch(() => ''));
  if (!results) return reply(502);
  return reply(200, results.slice(0, ITUNES_RESULTS_MAX).map(trimResult).filter(Boolean));
}
