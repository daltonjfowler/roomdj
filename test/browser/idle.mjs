// Browser test of the ⏳ idle close (shared/classtime.js): one host page in installed Chrome
// (playwright-core), against a LOCAL wrangler dev only, with the idle time cut to 20 s:
//   npm run build
//   npx wrangler dev --ip 127.0.0.1 --port 8797 --local-upstream 127.0.0.1:8797 --var IDLE_TEST_MS:20000
//   npm run test:idle       (or: node test/browser/idle.mjs http://127.0.0.1:8797/)
// Covers: the warning shows after 10 s with a countdown, in the tab title and on the big screen; Keep
// open clears it; a student's join and search (which change no room state) clear it; music and 🎲
// Autoplay alone do NOT keep the room open: it closes with why 'idle' and the page says so.
// The teacher's saved settings are put back at the end.

import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { T1, pickTeacher } from './teacher-pick.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8797/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = fileURLToPath(new URL('./.out/', import.meta.url));
const ROOT = new URL('../../', import.meta.url);
mkdirSync(OUT, { recursive: true });

if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: runs only against a local dev server (not ${BASE})`);
  process.exit(1);
}

const line = readFileSync(new URL('.dev.vars', ROOT), 'utf8').split(/\r?\n/).find((l) => l.startsWith('TEACHER_KEY='));
if (!line) throw new Error('TEACHER_KEY is not in .dev.vars');
const KEY = line.slice('TEACHER_KEY='.length).trim().replace(/^"(.*)"$/, '$1');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
  return ok;
}
async function until(fn, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

const saved = await (await api('/api/teacher/settings')).json();
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, autoplay: true, autoplayShelves: ['pop', 'rock'] }) });
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const DEVICE = 'idletest-device-student1';

try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const msgs = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    try { msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ }
  }));
  const last = () => [...msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
  const banner = () => page.locator('#idleNote').isVisible();
  const warned = () => until(async () => (await banner()) && last()?.idleLeft > 0);
  const cleared = () => until(async () => !(await banner()) && last()?.idleLeft === 0, 6000);

  await page.goto(new URL('host/', BASE).href);
  await page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(page, KEY);
  await page.check('input[name="openEnd"][value="day"]');
  await page.fill('#openCleanup', '');
  await page.click('#openBtn');
  await page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { room } = await page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const code = (await page.textContent('#bigCode')).trim();
  check('a new room shows no warning', !(await banner()) && (last()?.idleLeft ?? 0) === 0);

  check('the warning shows on its own', Boolean(await warned()), JSON.stringify(last()?.idleLeft));
  const said = await page.textContent('#idleText');
  check('it counts down and says what is lost', /closes in 0:\d\d/.test(said) && said.includes('deleted'), said);
  check('the tab title warns too', /Closing in 0:\d\d/.test(await page.title()), await page.title());
  await page.screenshot({ path: `${OUT}idle-warning.png` });
  await page.evaluate(() => document.querySelector('#bigBtn').click());
  check('the big screen shows it too', await banner());
  await page.screenshot({ path: `${OUT}idle-warning-big.png` });

  await page.click('#idleKeep'); // from the big screen
  check('Keep open clears the warning', Boolean(await cleared()), JSON.stringify(last()?.idleLeft));
  check('the title goes back', (await page.title()).startsWith('RoomDJ:'), await page.title());

  await warned();
  const joined = await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': DEVICE, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  check('a student joins', joined.ok, String(joined.status));
  check('a student joining clears the warning', Boolean(await cleared()), JSON.stringify(last()?.idleLeft));

  await warned();
  const search = await fetch(new URL(`api/rooms/${room}/search?q=${encodeURIComponent('here comes the sun')}`, BASE), { headers: { 'x-device': DEVICE } });
  check('a student searches', search.status < 500, String(search.status));
  check('a student searching clears the warning', Boolean(await cleared()), JSON.stringify(last()?.idleLeft));

  // Music alone: Start, then nobody does anything. Autoplay plays songs and the room still closes.
  await page.click('#startBtn');
  check('🎲 Autoplay plays a song', Boolean(await until(() => last()?.nowPlaying?.autoplay === true, 15_000)));
  const playingAt = Date.now();
  check('the warning comes while a song plays', Boolean(await warned()));
  const closed = await until(() => msgs.find((m) => m.t === 'closed'), 25_000);
  check('music alone does not keep it open: closed, why idle', closed?.why === 'idle', JSON.stringify(closed));
  check('it closed about 20 s after Start', Date.now() - playingAt < 22_000, String(Date.now() - playingAt));
  check('the page says why', Boolean(await until(async () => (await page.locator('#closedText').textContent())?.includes('Nobody used it for 1 hour'), 5000)), await page.locator('#closedText').textContent());
  check('the tab title stops warning', !(await page.title()).includes('Closing'), await page.title());
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL idle stopped: ${e?.stack ?? e}`);
} finally {
  const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(saved) });
  if (!r.ok) console.log('FAIL could not put the saved teacher settings back');
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
