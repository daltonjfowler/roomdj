// One line to LRCLIB for every room, the cron and every Worker copy (Dalton, 2026-10-28: "the limit
// we get on pulling lyrics"). LRCLIB answers 503 ServerOverloaded or 429 in busy moments; before this,
// each Worker copy kept its own backoff and gave up at once. Now one Durable Object ('lrclib') hands
// out turns LYRICS_SPACING_MS apart and remembers a Retry-After for everyone, and a caller waits for
// its turn while it fits in its time. It only hands out turns: lyrics never pass through it, and it
// keeps only one small record in storage: LRCLIB's health for the admin page (Dalton, 2026-11-01),
// saved when it flips between working and failing and at most every HEALTH_SAVE_MS otherwise.
// The rule is gateDecision (pure, tested in Node); src/lyrics.js fetchLyrics asks it.

import { DurableObject } from 'cloudflare:workers';
import { gateDecision, nextHealth } from './lyrics.js';

const HEALTH_SAVE_MS = 10 * 60_000;

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

  /** How LRCLIB answered a lookup (fetchLyrics): ok = it answered, else why it did not. */
  async report(ok, why = '') {
    const was = this.health ?? (await this.ctx.storage.get('health')) ?? null;
    const now = Date.now();
    this.health = nextHealth(was, ok, why, now);
    if (Boolean(was?.since) !== Boolean(this.health.since) || now - (this.savedAt ?? 0) > HEALTH_SAVE_MS) {
      this.savedAt = now;
      await this.ctx.storage.put('health', this.health);
    }
  }

  /** → { okAt, failAt, why, since } (since: failing since then, 0 while working) or null (no lookups yet). */
  async status() {
    return this.health ?? (await this.ctx.storage.get('health')) ?? null;
  }

  /** LRCLIB said wait (429/503 Retry-After): nobody calls before then. */
  async backoff(seconds) {
    this.line.backoffUntil = Math.max(this.line.backoffUntil, Date.now() + seconds * 1000);
  }
}
