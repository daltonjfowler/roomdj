// One line to LRCLIB for every room, the cron and every Worker copy (Dalton, 2026-10-28: "the limit
// we get on pulling lyrics"). LRCLIB answers 503 ServerOverloaded or 429 in busy moments; before this,
// each Worker copy kept its own backoff and gave up at once. Now one Durable Object ('lrclib') hands
// out turns LYRICS_SPACING_MS apart and remembers a Retry-After for everyone, and a caller waits for
// its turn while it fits in its time. It only hands out turns: lyrics never pass through it, and it
// keeps nothing in storage (memory only; a fresh object simply starts with an empty line).
// The rule is gateDecision (pure, tested in Node); src/lyrics.js fetchLyrics asks it.

import { DurableObject } from 'cloudflare:workers';
import { gateDecision } from './lyrics.js';

export class LyricsGate extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.line = { nextAt: 0, backoffUntil: 0 };
  }

  /** A turn to call LRCLIB within `maxWaitMs`. → { ok: true, waitMs } or { ok: false, waitMs }. */
  async turn(maxWaitMs) {
    const d = gateDecision(this.line, Date.now(), maxWaitMs);
    this.line = d.line;
    return { ok: d.ok, waitMs: d.waitMs };
  }

  /** LRCLIB said wait (429/503 Retry-After): nobody calls before then. */
  async backoff(seconds) {
    this.line.backoffUntil = Math.max(this.line.backoffUntil, Date.now() + seconds * 1000);
  }
}
