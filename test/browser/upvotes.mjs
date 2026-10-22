// Browser test of the 👍 limit and 👍 off (protocol.js UPVOTE LIMIT) and the Settings levels (Simple /
// All settings, ⚙️ More options on the open-room form): a host page, a student page and a student
// socket in installed Chrome (playwright-core), against a LOCAL wrangler dev only.
//   npm run dev, then:  npm run test:upvotes   (or: node test/browser/upvotes.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// No Workers AI call: the AI theme check and the album art check are off in Teacher 1's saved
// settings while it runs (put back at the end). Searches hit the real iTunes API (through the host page).
// Covers: ⚙️ More options (every setting, Save only, saved for the next room), Simple hides the
// advanced rows and the Shortcuts tab, All settings is remembered, "👍 per student per class"
// "👍 votes" Off / On and "👍 per student per class" (1 / 2 / 3 / 5 / Unlimited, like 👎), "👍 2 left", a third 👍 explained and not sent, the server
// refusing a forced 👍 (upvotes, upvotes_off), the host's "👍 2/2", 👍 Off (no 👍 buttons anywhere).

import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { songKey } from '../../shared/repeats.js';
import { T1, pickTeacher } from './teacher-pick.mjs';
import { reveal } from './ui.mjs';

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
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 10_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(every);
  }
}

const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

// ---- Pages and sockets ----
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
async function openPage(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const p = { name, ctx, page, msgs: [], errors: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => { try { p.msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ } });
    ws.on('framesent', (f) => { try { (p.sent ??= []).push(JSON.parse(f.payload)); } catch { /* not JSON */ } });
  });
  await page.goto(new URL(path, BASE).href);
  return p;
}
const lastState = (p) => [...p.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const text = (p, sel) => p.page.locator(sel).textContent();
const shown = (p, sel) => p.page.locator(sel).isVisible();

const wsBase = BASE.replace(/^http/, 'ws');
const sockets = [];
const sock = (roomId, params) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${wsBase}api/rooms/${roomId}/ws?${new URLSearchParams(params)}`);
  ws.msgs = [];
  ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
  ws.onopen = () => resolve(ws);
  ws.onerror = reject;
  sockets.push(ws);
});
const send = (ws, msg) => ws.send(JSON.stringify(msg));
const wsState = (ws) => [...ws.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
async function studentSock(roomId, code, device, nick) {
  await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  return sock(roomId, { role: 'student', device, nick });
}
async function roomSearch(roomId, device, q) {
  const r = await fetch(new URL(`api/rooms/${roomId}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': device } });
  return (await r.json()).results ?? [];
}
async function suggestBy(ws, id) {
  const n = ws.msgs.length;
  send(ws, { t: 'suggest', song: id });
  return until(() => ws.msgs.slice(n).find((m) => m.t === 'suggested' && m.song === id), { timeout: 20_000 });
}

async function hostSettings(host, set) {
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  await set();
  await host.page.click('#applySettings');
}

// ---- The flow ----
const savedDefaults = await (await api('/api/teacher/settings')).json();
await api('/api/teacher/settings', {
  method: 'PUT',
  body: JSON.stringify({ aiCheck: false, blockUnknownSongs: false, hideVoteCounts: false, artCheck: false, cooldownDays: null, downvoteMode: 'off',
    scoreFloor: true, backToWork: false, maxWaitingPerStudent: 10, maxSongMinutes: null, upvotes: true, maxUpvotes: 3 }),
});
const pages = [];
try {
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);

  // ⚙️ More options: every setting before the room opens; only Save.
  await host.page.click('#moreOptions');
  await host.page.waitForSelector('#settingsDlg[open]');
  check('More options: the saved defaults dialog', (await text(host, '#settingsTitle')) === 'Settings for your rooms' && await shown(host, '#defaultsNote'));
  check('More options: All settings (the Shortcuts tab shows)', (await host.page.getAttribute('#levelAll', 'aria-pressed')) === 'true' && await shown(host, '#tabKeys'));
  check('More options: no "Use in this room", only Save', !(await shown(host, '#applySettings')) && await shown(host, '#saveDefault'));
  await host.page.click('#tabSongs');
  const modeOptions = await host.page.$$eval('#setUpMode option', (os) => os.map((o) => o.textContent.trim()));
  check('"👍 votes": Off / On, showing On', modeOptions.join() === 'Off,On' && (await host.page.inputValue('#setUpMode')) === 'on', modeOptions.join());
  const upOptions = await host.page.$$eval('#setMaxUp option', (os) => os.map((o) => o.textContent));
  const downOptions = await host.page.$$eval('#setMaxDown option', (os) => os.map((o) => o.textContent));
  check('"👍 per student per class": 1 / 2 / 3 / 5 / Unlimited, the same as 👎', upOptions.join() === '1,2,3,5,Unlimited' && upOptions.join() === downOptions.join(), upOptions.join());
  check('it shows the saved 3', (await host.page.inputValue('#setMaxUp')) === '3');
  check('All: the vote counts row shows', await shown(host, '#setHideCounts'));
  await host.page.selectOption('#setMaxUp', '2');
  await host.page.click('#saveDefault');
  const saved = await until(async () => {
    const s = await (await api('/api/teacher/settings')).json();
    return s.maxUpvotes === 2 ? s : null;
  });
  check('More options → Save: 👍 2 is the saved default', saved?.maxUpvotes === 2 && saved?.upvotes === true);
  check('the dialog closes', Boolean(await until(async () => (await host.page.locator('#settingsDlg[open]').count()) === 0)));

  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { room: roomId, classCode: code } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  check('the new room takes it: 👍 on, 2', Boolean(await until(() => lastState(host)?.settings.maxUpvotes === 2 && lastState(host)?.upvotes === true)));

  // ⚙️ Settings in the room: Simple first (nothing remembered yet); All is remembered.
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  await host.page.click('#tabSongs');
  check('Settings: Simple at first', (await host.page.getAttribute('#levelSimple', 'aria-pressed')) === 'true' && await shown(host, '#levelNote'));
  check('Simple: the main rows show (👍, 👎, songs waiting, blocked words)', await shown(host, '#setUpMode') && await shown(host, '#setMaxUp') && await shown(host, '#setDownMode')
    && await shown(host, '#setMax') && await shown(host, '#setWords'));
  check('Simple: advanced rows and the Shortcuts tab hide', !(await shown(host, '#setHideCounts')) && !(await shown(host, '#setGhost'))
    && !(await shown(host, '#tabKeys')) && await shown(host, '#applySettings'));
  await host.page.screenshot({ path: `${OUT}settings-simple.png` });
  await host.page.click('#levelAll');
  check('All settings: they show', await shown(host, '#setHideCounts') && await shown(host, '#tabKeys') && !(await shown(host, '#levelNote')));
  await host.page.screenshot({ path: `${OUT}settings-all.png` });
  await host.page.click('#cancelSettings');
  await host.page.click('#settingsBtn');
  check('All settings is remembered', (await host.page.getAttribute('#levelAll', 'aria-pressed')) === 'true' && await shown(host, '#setHideCounts'));
  await host.page.click('#levelSimple');
  await host.page.click('#cancelSettings');

  // Four songs from a socket student.
  const maya = await studentSock(roomId, code, 'upvote-test-maya-00001', 'Maya');
  const pool = [];
  const keys = new Set();
  for (const q of ['Beatles', 'happy']) {
    for (const s of await roomSearch(roomId, 'upvote-test-maya-00001', q)) {
      if (pool.length >= 4 || keys.has(songKey(s))) continue;
      keys.add(songKey(s));
      if ((await suggestBy(maya, s.id))?.ok) pool.push(s.id);
    }
  }
  check('four songs are waiting', pool.length === 4 && Boolean(await until(() => lastState(host)?.queue.length === 4)), String(pool.length));
  const items = lastState(host).queue.map((q) => q.id);
  const upCount = (id) => lastState(host)?.queue.find((q) => q.id === id)?.up;

  // The student page.
  const ava = await openPage('ava', `?code=${encodeURIComponent(code)}`);
  pages.push(ava);
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');
  await ava.page.waitForFunction(() => document.querySelectorAll('#queue li').length === 4);
  check('counter: "👍 2 left"', Boolean(await until(async () => (await text(ava, '#upLeft')) === '👍 2 left')) && await shown(ava, '#upLeft'), await text(ava, '#upLeft'));
  const up = (id) => `#queue li[data-id="${id}"] .vote.up`;
  await ava.page.click(up(items[0]));
  await ava.page.click(up(items[1]));
  check('two 👍 count on the server', Boolean(await until(() => upCount(items[0]) === 1 && upCount(items[1]) === 1)));
  check('counter: "👍 0 left"', Boolean(await until(async () => (await text(ava, '#upLeft')) === '👍 0 left')), await text(ava, '#upLeft'));
  check('no 👍 left: the other 👍 buttons are aria-disabled', (await ava.page.getAttribute(up(items[2]), 'aria-disabled')) === 'true');
  const sentBefore = (ava.sent ?? []).length;
  await ava.page.click(up(items[2]), { force: true }); // aria-disabled: Playwright would wait for "enabled"
  check('a third 👍 says why', Boolean(await until(async () => (await text(ava, '#toasts')).includes("You've used your 👍 for this class."))));
  await wait(400);
  check('a third 👍 is not sent and not counted', !(ava.sent ?? []).slice(sentBefore).some((m) => m.t === 'vote') && upCount(items[2]) === 0);
  await ava.page.screenshot({ path: `${OUT}upvotes-none-left.png` });

  // Host: Students list "👍 2/2".
  await host.page.click(await reveal(host.page, '#studentsBtn'));
  await host.page.waitForSelector('#studentsDlg[open]');
  check('host Students: "👍 2/2" for Ava', Boolean(await until(async () => (await host.page.locator('#students li', { hasText: 'Ava' }).textContent()).includes('👍 2/2'))));
  await host.page.keyboard.press('Escape');

  // The server refuses a forced third 👍.
  const zed = await studentSock(roomId, code, 'upvote-test-zed-000001', 'Zed');
  await until(() => wsState(zed));
  send(zed, { t: 'vote', id: items[0], v: 1 });
  send(zed, { t: 'vote', id: items[1], v: 1 });
  await until(() => wsState(zed)?.you.upvotesLeft === 0);
  let n = zed.msgs.length;
  send(zed, { t: 'vote', id: items[2], v: 1 });
  let refused = await until(() => zed.msgs.slice(n).find((m) => m.t === 'error'));
  check('server: a forced third 👍 is refused (upvotes)', refused?.error === 'upvotes' && refused.message === "You've used your 👍 for this class.", JSON.stringify(refused));

  // 👍 Off: no 👍 buttons anywhere; a forced 👍 is refused; the 👍 already cast stay.
  await hostSettings(host, async () => {
    await host.page.selectOption(await reveal(host.page, '#setUpMode'), 'off');
    check('👍 Off: the per-student box hides', !(await shown(host, '#setMaxUp')));
  });
  check('👍 Off: the room says so', Boolean(await until(() => lastState(host)?.upvotes === false)));
  check('👍 Off: the student page has no 👍 buttons and no counter', Boolean(await until(async () => (await ava.page.locator('#queue .vote.up:visible').count()) === 0))
    && !(await shown(ava, '#upLeft')));
  check('👍 Off and 👎 Off: the hint says suggestion order', (await text(ava, '#voteHint')).startsWith('Songs play in the order they were suggested.'), await text(ava, '#voteHint'));
  check('👍 Off: the host has no 👍 buttons', (await host.page.locator('#queue button[data-act="up"]').count()) === 0);
  n = zed.msgs.length;
  send(zed, { t: 'vote', id: items[3], v: 1 });
  refused = await until(() => zed.msgs.slice(n).find((m) => m.t === 'error'));
  check('server: a forced 👍 while off is refused (upvotes_off)', refused?.error === 'upvotes_off', JSON.stringify(refused));
  check('👍 Off: the 👍 already cast stay', upCount(items[0]) === 2);
  await ava.page.screenshot({ path: `${OUT}upvotes-off.png` });

  // Unlimited: no counter, 👍 work again.
  await hostSettings(host, async () => {
    await host.page.selectOption(await reveal(host.page, '#setUpMode'), 'on');
    check('👍 On again: it remembers 2', (await host.page.inputValue('#setMaxUp')) === '2');
    await host.page.selectOption('#setMaxUp', 'off');
  });
  check('Unlimited: on, no limit', Boolean(await until(() => lastState(host)?.upvotes === true && lastState(host)?.settings.maxUpvotes === null)));
  check('Unlimited: 👍 buttons back, no counter', Boolean(await until(async () => (await ava.page.locator('#queue .vote.up:visible').count()) === 4))
    && !(await shown(ava, '#upLeft')));
  await ava.page.click(up(items[3]));
  check('Unlimited: a third 👍 counts', Boolean(await until(() => upCount(items[3]) === 1)));

  for (const p of pages) check(`${p.name}: no page errors`, p.errors.length === 0, p.errors.join(' | '));
  // Close the room (a closed tab alone leaves it open until `until`).
  const { token } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const closer = await sock(roomId, { role: 'host', token });
  send(closer, { t: 'close' });
} catch (e) {
  failures++;
  console.log(`FAIL the flow stopped: ${e.stack ?? e}`);
  for (const p of pages) await p.page.screenshot({ path: `${OUT}upvotes-error-${p.name}.png` }).catch(() => {});
} finally {
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) }).catch(() => {});
  await wait(300);
  for (const ws of sockets) try { ws.close(); } catch { /* closed */ }
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
