// Browser test of the bell countdown, the bell offset and the server clock (protocol.js BELL OFFSET,
// SERVER CLOCK) in installed Chrome (playwright-core), against a LOCAL wrangler dev only:
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:bell                 (or: node test/browser/bell.mjs http://127.0.0.1:8792/)
// Teacher 1's saved settings get bellOffsetSeconds +3 (AI check, repeat cooldown and back to work
// off) and are put back at the end. Checks: the room keeps the typed times + 3 s and the host shows
// the typed (bell) times; the big-screen chip counts down live in mm:ss; a student whose Chromebook
// clock is 7 minutes slow still sees the server's countdown; changing the offset moves the room's
// times; cleanup starts and the room closes 3 s after the typed times (not before); the student
// page announces only at 1 minute left and at cleanup, once each. No AI call, no song search.
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.

import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timeAhead, timeValue } from '../../shared/classtime.js';
import { T1, pickTeacher } from './teacher-pick.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = fileURLToPath(new URL('./.out/', import.meta.url));
const ROOT = new URL('../../', import.meta.url);
mkdirSync(OUT, { recursive: true });

if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: runs only against a local dev server (not ${BASE})`);
  process.exit(1);
}

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    const path = process.env.PLAYWRIGHT_CORE || fileURLToPath(new URL('../uploadmycut/node_modules/playwright-core/index.mjs', ROOT));
    return import(pathToFileURL(path).href);
  }
}
const { chromium } = await loadPlaywright();

function teacherKey() {
  const vars = readFileSync(new URL('.dev.vars', ROOT), 'utf8');
  const line = vars.split(/\r?\n/).find((l) => l.startsWith('TEACHER_KEY='));
  if (!line) throw new Error('TEACHER_KEY is not in .dev.vars');
  return line.slice('TEACHER_KEY='.length).trim().replace(/^"(.*)"$/, '$1');
}
const KEY = teacherKey();

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
  return ok;
}
async function until(fn, { timeout = 10_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

const OFFSET = 3;
const SKEW_MS = -7 * 60_000; // the student's Chromebook clock is 7 minutes slow

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const pages = [];
async function openPage(name, path, init = null) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  const p = { name, ctx, page, errors: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  await page.goto(new URL(path, BASE).href);
  pages.push(p);
  return p;
}
const text = (p, sel) => p.page.locator(sel).textContent();
const squash = (t) => (t ?? '').replace(/\s+/g, ' ').trim();

/** A raw host socket; every message keeps the time it arrived (the server runs on this machine). */
async function rawSocket(roomId, params) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}api/rooms/${roomId}/ws?${new URLSearchParams(params)}`);
  const s = { ws, msgs: [] };
  ws.addEventListener('message', (e) => { try { s.msgs.push({ at: Date.now(), msg: JSON.parse(e.data) }); } catch { /* not JSON */ } });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  s.send = (msg) => ws.send(JSON.stringify(msg));
  s.state = () => s.msgs.findLast((m) => m.msg.t === 'state')?.msg.state ?? null;
  s.first = (pred) => s.msgs.find((m) => pred(m.msg)) ?? null;
  return s;
}

/** Init script for the student: Date runs 7 minutes slow (performance.now and timers untouched). */
function skewClock(skew) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  class SkewDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(realNow() + skew); }
    static now() { return realNow() + skew; }
  }
  globalThis.Date = SkewDate;
  // Every non-empty #announce text, in order (the page's one live region).
  globalThis.__said = [];
  addEventListener('DOMContentLoaded', () => {
    const box = document.querySelector('#announce');
    if (box) new MutationObserver(() => { if (box.textContent) globalThis.__said.push(box.textContent); }).observe(box, { childList: true, characterData: true, subtree: true });
  });
}
const said = (p) => p.page.evaluate(() => globalThis.__said.slice());
/** "🔔 Bell in 4:52" → 292 (seconds), or null. */
function pillSeconds(t) {
  const m = /(\d+):(\d\d)(?::(\d\d))?\s*$/.exec(t ?? '');
  if (!m) return null;
  return m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

const saved = await (await api('api/teacher/settings')).json();
let raw = null;
try {
  const put = await api('api/teacher/settings', { method: 'PUT', body: JSON.stringify({ bellOffsetSeconds: OFFSET, aiCheck: false, cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false, bellSchedule: [] }) });
  check('the teacher saves a bell offset of +3 s', put.ok && (await put.json()).bellOffsetSeconds === OFFSET);

  // 1. The host page: open a room ending about 6 minutes from now (a typed time).
  const host = await openPage('host', 'host/');
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  const typedEnd = timeValue(Date.now() + 6 * 60_000);
  await host.page.check('input[name="openEnd"][value="custom"]');
  await host.page.fill('#openCustom', typedEnd);
  await host.page.fill('#openCleanup', '');
  const typedMs = timeAhead(typedEnd);
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const entry = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  raw = await rawSocket(entry.room, { role: 'host', token: entry.token });
  const s0 = await until(() => raw.state());
  check('the room keeps the typed class end + 3 s', s0?.until === typedMs + OFFSET * 1000, JSON.stringify([s0?.until, typedMs]));
  check('every State carries serverNow and bellOffsetSeconds', Number.isFinite(s0?.serverNow) && Math.abs(s0.serverNow - Date.now()) < 5000 && s0.bellOffsetSeconds === OFFSET);
  const shownEnd = await host.page.evaluate((ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), typedMs);
  check('the host shows the BELL time (typed), not the +3 s moment', Boolean(await until(async () => squash(await text(host, '#untilNote')).includes(`Class ends ${squash(shownEnd)}`))), await text(host, '#untilNote'));
  const chip1 = await until(async () => /in \d:\d\d/.exec(await text(host, '#untilNote'))?.[0]);
  await wait(1600);
  const chip2 = /in \d:\d\d/.exec(await text(host, '#untilNote'))?.[0];
  check('the big-screen chip counts down live in the last 10 minutes (mm:ss)', Boolean(chip1 && chip2 && chip1 !== chip2), `${chip1} → ${chip2}`);
  check('... and it is not a live region', (await host.page.getAttribute('#untilNote', 'aria-live')) === 'off');
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  check('Settings → Class time shows the bell offset as +3', (await host.page.inputValue('#setBellOffset')) === '+3');
  await host.page.click('#cancelSettings');

  // 2. A student whose Chromebook clock is 7 minutes slow: the pill matches the server.
  const kid = await openPage('student', `?code=${encodeURIComponent(entry.classCode)}`, { fn: skewClock, arg: SKEW_MS });
  check('the student page clock really is 7 minutes slow', Math.abs(await kid.page.evaluate(() => Date.now()) - (Date.now() + SKEW_MS)) < 2000);
  await kid.page.fill('#code', entry.classCode);
  await kid.page.fill('#nick', 'Bell Kid');
  await kid.page.click('#joinBtn');
  await kid.page.waitForSelector('#roomScreen:not([hidden])');
  await until(() => kid.page.isVisible('#bellPill'), { timeout: 10_000 });
  await wait(1200);
  const pill = squash(await text(kid, '#bellPill'));
  const expected = Math.ceil((raw.state().until - Date.now()) / 1000);
  check('student: "🔔 Bell in m:ss" shows in the room', /^🔔 Bell in \d+:\d\d$/.test(pill), pill);
  check('student: the countdown matches the SERVER clock despite the slow Chromebook (±2 s)', Math.abs(pillSeconds(pill) - expected) <= 2,
    `pill ${pillSeconds(pill)} s, server says ${expected} s (a page-clock countdown would say ${expected + 420} s)`);
  check('student: the pill is a timer, not a live region', (await kid.page.getAttribute('#bellPill', 'role')) === 'timer' && (await kid.page.getAttribute('#bellPill', 'aria-live')) === 'off');
  const before = (await said(kid)).length;
  await wait(4000);
  check('student: no announcements while the countdown ticks', (await said(kid)).length === before, JSON.stringify((await said(kid)).slice(before)));

  // 3. Changing the offset in a room moves its times (the same bell times).
  const u0 = raw.state().until;
  raw.send({ t: 'settings', settings: { bellOffsetSeconds: 5 } });
  check('offset +5 in the room: class end moves +2 s', Boolean(await until(() => raw.state()?.until === u0 + 2000 && raw.state().bellOffsetSeconds === 5)));
  raw.send({ t: 'settings', settings: { bellOffsetSeconds: OFFSET } });
  check('... and back to +3', Boolean(await until(() => raw.state()?.until === u0 && raw.state().bellOffsetSeconds === OFFSET)));

  // 4. Change times to seconds from now (bell times): cleanup in 20 s, class ends in 45 s.
  const t0 = Date.now();
  const typedCleanup = t0 + 20_000;
  const typedUntil = t0 + 45_000;
  raw.send({ t: 'times', until: typedUntil, cleanupAt: typedCleanup });
  const s1 = await until(() => { const s = raw.state(); return s?.until === typedUntil + OFFSET * 1000 ? s : null; });
  check('Change times: the room keeps typed + 3 s for both', s1?.cleanupAt === typedCleanup + OFFSET * 1000, JSON.stringify([s1?.until, s1?.cleanupAt]));
  check('student: under a minute left, the pill says so', Boolean(await until(async () => (pillSeconds(await text(kid, '#bellPill')) ?? 99) <= 50, { timeout: 5000 })));
  await until(() => Date.now() >= typedCleanup + 1200, { timeout: 30_000, every: 50 });
  check('cleanup has NOT started 1 s after the typed time (the offset holds it 3 s)', raw.state()?.cleanup === false && !(await kid.page.isVisible('#cleanupNote')));
  const cleanupMsg = await until(() => raw.first((m) => m.t === 'state' && m.state.cleanup === true), { timeout: 15_000, every: 50 });
  check('cleanup starts 3 s after the typed time (±1.5 s)', Boolean(cleanupMsg) && cleanupMsg.at >= typedCleanup + 3000 - 100 && cleanupMsg.at <= typedCleanup + 4500,
    `${cleanupMsg ? cleanupMsg.at - typedCleanup : 'never'} ms after the typed time`);
  check('student: "🧹 Cleanup! Bell in 0:ss"', Boolean(await until(async () => /^🧹 Cleanup! Bell in 0:\d\d$/.test(squash(await text(kid, '#bellPill'))))), await text(kid, '#bellPill'));
  const closed = await until(() => raw.first((m) => m.t === 'closed'), { timeout: 40_000, every: 50 });
  check('the room closes 3 s after the typed class end (±1.5 s)', Boolean(closed) && closed.at >= typedUntil + 3000 - 100 && closed.at <= typedUntil + 4500,
    `${closed ? closed.at - typedUntil : 'never'} ms after the typed time`);

  // 5. Screen readers: only the two moments, once each.
  const all = (await said(kid)).filter((x) => /bell|cleanup/i.test(x));
  check('announced once at 1 minute left', all.filter((x) => /One minute until the bell/.test(x)).length === 1, JSON.stringify(all));
  check('announced once when cleanup started', all.filter((x) => /^Cleanup time!/.test(x)).length === 1, JSON.stringify(all));
  check('nothing else about the bell was announced', all.length === 2, JSON.stringify(all));
  check('the student page went to the end screen', Boolean(await until(() => kid.page.isVisible('#endScreen'), { timeout: 10_000 })));
  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL bell stopped: ${e?.stack ?? e}`);
  for (const p of pages) await p.page.screenshot({ path: `${OUT}bell-crash-${p.name}.png` }).catch(() => {});
} finally {
  try {
    if (raw && raw.ws.readyState === WebSocket.OPEN) {
      raw.send({ t: 'close' });
      await wait(500);
      raw.ws.close();
    }
  } catch { /* closed */ }
  const r = await api('api/teacher/settings', { method: 'PUT', body: JSON.stringify(saved) });
  if (!r.ok) {
    failures++;
    console.log('FAIL could not put the saved teacher settings back');
  }
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
