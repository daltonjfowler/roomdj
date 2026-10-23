// The class code lock (Dalton, 2026-10-23: "mitigation if two people pick the same room code").
// KV (src/codes.js) is eventually consistent: in another data centre it can be up to a minute
// behind, so two teachers typing the same code at nearly the same moment could both pass
// codeInUse. Each code hash gets one tiny Durable Object that holds { room, until, at }: a single
// object runs one claim at a time, so exactly one room can hold a code. The rule is
// src/codes.js lockDecision (pure, tested in Node); this class only stores and asks.
// It forgets itself after `until` (alarm). The KV route stays the signpost for joins.

import { DurableObject } from 'cloudflare:workers';
import { LOCK_ALARM_SLACK_MS, lockDecision } from './codes.js';

export class CodeLock extends DurableObject {
  /** Take (or keep, for the same room) this code until `until`. → true: `room` holds it now. */
  async claim(room, until) {
    // blockConcurrencyWhile: no other claim or release runs until this one is done, even while it
    // asks the holder's room whether it is still open.
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const held = await this.ctx.storage.get('held');
      let decision = lockDecision(held, room, now);
      if (decision === 'ask') decision = (await this.roomOpen(held.room)) ? 'taken' : 'free';
      if (decision === 'taken') return false;
      await this.ctx.storage.put('held', { room, until, at: decision === 'mine' ? held.at : now });
      await this.ctx.storage.setAlarm(until + LOCK_ALARM_SLACK_MS);
      return true;
    });
  }

  /** Let the code go, only if `room` holds it (another room may have it by now). */
  async release(room) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const held = await this.ctx.storage.get('held');
      if (held?.room === room) await this.ctx.storage.deleteAll();
    });
  }

  /** True while that room is open. Cannot tell: true (never hand out a code that may be taken). */
  async roomOpen(id) {
    try {
      return (await this.env.ROOMS.get(this.env.ROOMS.idFromName(id)).fetch('https://room/info')).ok;
    } catch {
      return true;
    }
  }

  async alarm() {
    const held = await this.ctx.storage.get('held');
    if (held && held.until > Date.now()) return this.ctx.storage.setAlarm(held.until + LOCK_ALARM_SLACK_MS);
    await this.ctx.storage.deleteAll();
  }
}
