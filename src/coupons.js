// Coupons (shared/coupon.js COUPONS): checking one and using it up, once, everywhere.
//
// Built dark (Dalton, 2026-10-20: "build this on backend without implementing till done"): nothing
// takes a coupon unless the COUPONS var is 'on' AND COUPON_PUBLIC_KEYS holds a key. The teacher can
// still turn coupons off per teacher (settings.coupons). No student page or host page shows them yet.
//
// "Good once" has to hold across rooms and across Cloudflare's data centers, which KV (eventually
// consistent) cannot promise. So each coupon id gets its own tiny Durable Object (CouponLedger,
// named "<issuer>:<id>"): one storage read and write, done atomically, and it forgets itself once
// the coupon has expired (an expired coupon is refused before it gets here anyway).

import { DurableObject } from 'cloudflare:workers';
import { publicKeysFrom, verifyCoupon } from '../shared/coupon.js';

/** True when this server takes coupons at all (the teacher's switch is checked by the room). */
export function couponsOn(env) {
  return env.COUPONS === 'on' && Boolean(env.COUPON_LEDGER) && publicKeysFrom(env.COUPON_PUBLIC_KEYS).length > 0;
}

/**
 * Check a coupon and use it up.
 * @returns {Promise<{ ok: true, id: string, credits: number, exp: number, issuer: string }
 *   | { ok: false, reason: 'bad'|'expired'|'used'|'error' }>}
 */
export async function redeemCoupon(env, code, { now = Date.now() } = {}) {
  const v = await verifyCoupon(code, publicKeysFrom(env.COUPON_PUBLIC_KEYS), { now });
  if (!v.ok) return v;
  try {
    const stub = env.COUPON_LEDGER.get(env.COUPON_LEDGER.idFromName(`${v.issuer}:${v.id}`));
    if (!(await stub.redeem(v.exp))) return { ok: false, reason: 'used' };
  } catch (e) {
    console.error(JSON.stringify({ message: 'coupon ledger failed', error: String(e) }));
    return { ok: false, reason: 'error' };
  }
  return v;
}

export class CouponLedger extends DurableObject {
  /** Use this coupon up. → true the first time, false ever after (until it has expired). */
  async redeem(exp) {
    if (await this.ctx.storage.get('used')) return false;
    await this.ctx.storage.put('used', Date.now());
    if (Number.isInteger(exp)) await this.ctx.storage.setAlarm(exp * 1000 + 60_000);
    return true;
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
