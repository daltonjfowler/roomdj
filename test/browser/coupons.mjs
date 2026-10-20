// 🎟 Coupons end to end over raw sockets (no Chrome), against a LOCAL wrangler dev only, with
// coupons switched on and the throwaway test key from test/coupon.test.mjs (never a real one):
//   npm run build
//   npx wrangler dev --ip 127.0.0.1 --port 8792 --local-upstream 127.0.0.1:8792 \
//     --var COUPONS:on --var COUPON_PUBLIC_KEYS:ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ
//   node test/browser/coupons.mjs http://127.0.0.1:8792/
// Reads TEACHER_KEY from .dev.vars and never prints it. Covers: credits off → refused and NOT used
// up; credits on → the coupon's credits land; the same coupon again → used (also from a second
// student); a changed or expired coupon → refused; the teacher's Coupons switch off → refused and
// not used up; too many tries → rate. Without the two vars every coupon is refused as 'off'.

import { readFileSync } from 'node:fs';
import { T1, closeOpenRooms } from './teacher-pick.mjs';
import { bytesToB64url } from '../../shared/coupon.js';
import { generateNick } from '../../shared/nickgen.js';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const ROOT = new URL('../../', import.meta.url);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: runs only against a local dev server (not ${BASE})`);
  process.exit(1);
}
const KEY = (() => {
  const line = readFileSync(new URL('.dev.vars', ROOT), 'utf8').split(/\r?\n/).find((l) => l.startsWith('TEACHER_KEY='));
  if (!line) throw new Error('TEACHER_KEY is not in .dev.vars');
  return line.slice('TEACHER_KEY='.length).trim().replace(/^"(.*)"$/, '$1');
})();

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(100);
  }
}
const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

function socket(path) {
  const url = new URL(path, BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  const got = [];
  ws.addEventListener('message', (e) => { try { got.push(JSON.parse(e.data)); } catch { /* not JSON */ } });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return {
    ws, got, opened,
    send: (msg) => ws.send(JSON.stringify(msg)),
    state: () => got.findLast((m) => m.t === 'state')?.state ?? null,
    /** The next couponResult after the ones seen so far. */
    async result(seen) {
      return until(() => got.filter((m) => m.t === 'couponResult')[seen]);
    },
  };
}

// The throwaway test key (seed 1..32), the same as test/coupon.test.mjs.
const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const pkcs8 = new Uint8Array([...Buffer.from('302e020100300506032b657004220420', 'hex'), ...seed]);
const signKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
async function coupon({ credits = 1, exp = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  const id = bytesToB64url(crypto.getRandomValues(new Uint8Array(16)));
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify({ i: id, c: credits, e: exp, s: 'tc' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signKey, new TextEncoder().encode(`RDJ1.${body}`)));
  return `RDJ1.${body}.${bytesToB64url(sig)}`;
}

async function join(code) {
  const device = bytesToB64url(crypto.getRandomValues(new Uint8Array(18)));
  const r = await fetch(new URL('/api/join', BASE), { method: 'POST', headers: { 'content-type': 'application/json', 'x-device': device }, body: JSON.stringify({ code }) });
  const data = await r.json();
  if (!r.ok) throw new Error(`join: HTTP ${r.status} ${JSON.stringify(data)}`);
  const s = socket(`/api/rooms/${data.room ?? data.id}/ws?role=student&device=${device}&nick=${encodeURIComponent(generateNick())}`);
  await s.opened;
  await until(() => s.state());
  return s;
}

const code = `coupons ${Math.floor(Math.random() * 1e6)}`;
await closeOpenRooms(BASE, KEY);
const res = await api('/api/teacher/rooms', { method: 'POST', body: JSON.stringify({ code, until: Date.now() + 60 * 60_000 }) });
if (!check('room opens', res.ok, `HTTP ${res.status}`)) process.exit(1);
const { room, hostToken } = await res.json();
const host = socket(`/api/rooms/${room}/ws?role=host&token=${encodeURIComponent(hostToken)}`);
await host.opened;
await until(() => host.state());
const settings = (over) => {
  host.send({ t: 'settings', settings: { ...host.state().settings, ...over } });
  return until(() => Object.entries(over).every(([k, v]) => host.state()?.settings?.[k] === v));
};
try {
  await settings({ startingCredits: null, coupons: true });
  const a = await join(code);
  const c1 = await coupon({ credits: 2 });

  a.send({ t: 'coupon', code: c1 });
  let r = await a.result(0);
  check('credits off: refused (credits_off)', r?.ok === false && r.reason === 'credits_off', JSON.stringify(r));

  await settings({ startingCredits: 3 });
  a.send({ t: 'coupon', code: c1 });
  r = await a.result(1);
  check('credits on: the same coupon now works (it was not used up)', r?.ok === true && r.amount === 2 && r.credits === 5, JSON.stringify(r));

  a.send({ t: 'coupon', code: c1 });
  r = await a.result(2);
  check('the same coupon again: used', r?.ok === false && r.reason === 'used', JSON.stringify(r));

  const b = await join(code);
  b.send({ t: 'coupon', code: c1 });
  r = await b.result(0);
  check('another student with the same coupon: used', r?.ok === false && r.reason === 'used', JSON.stringify(r));

  const [p, body, sig] = (await coupon()).split('.');
  const forged = `${p}.${bytesToB64url(new TextEncoder().encode(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), c: 10 })))}.${sig}`;
  b.send({ t: 'coupon', code: forged });
  r = await b.result(1);
  check('a changed coupon: bad', r?.ok === false && r.reason === 'bad', JSON.stringify(r));

  b.send({ t: 'coupon', code: await coupon({ exp: Math.floor(Date.now() / 1000) - 5 }) });
  r = await b.result(2);
  check('an expired coupon: expired', r?.ok === false && r.reason === 'expired', JSON.stringify(r));

  await settings({ coupons: false });
  const c2 = await coupon();
  b.send({ t: 'coupon', code: c2 });
  r = await b.result(3);
  check("the teacher's Coupons switch off: refused (off)", r?.ok === false && r.reason === 'off', JSON.stringify(r));
  await settings({ coupons: true });
  b.send({ t: 'coupon', code: c2 });
  r = await b.result(4);
  check('switch back on: the same coupon works (it was not used up)', r?.ok === true && r.amount === 1, JSON.stringify(r));

  for (let i = 0; i < 6; i++) b.send({ t: 'coupon', code: 'junk' });
  const rated = await until(() => b.got.some((m) => m.t === 'couponResult' && m.reason === 'rate'));
  check('too many tries a minute: rate', Boolean(rated));
  check('no names or ids in a result', !JSON.stringify(a.got.filter((m) => m.t === 'couponResult')).match(/nick|device/));
  a.ws.close();
  b.ws.close();
} finally {
  host.send({ t: 'close' });
  await sleep(500);
  host.ws.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
