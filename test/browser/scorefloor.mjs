// Browser test of "Scores never go below 0" (protocol.js SCORE FLOOR): a host page, a student page
// and student sockets in installed Chrome (playwright-core), against a LOCAL wrangler dev only.
//   npm run dev, then:  npm run test:scorefloor   (or: node test/browser/scorefloor.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// No Workers AI call: the AI theme check and the album art check are off in Teacher 1's saved
// settings while it runs (put back at the end). Searches hit the real iTunes API (through the host page).
// Covers: the Settings → Songs switch (off by default) greys out the remove score with a note; with it
// on, 3 👎 show 0 and the song is not removed (a 4th neither), a 0-vote song plays first (fewer 👎);
// turning it off removes nothing at once and the next vote removes at the threshold; Save as my default.

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
  body: JSON.stringify({ aiCheck: false, blockUnknownSongs: false, artCheck: false, cooldownDays: null, downvoteMode: 'shown', backToWork: false,
    maxWaitingPerStudent: 10, maxSongMinutes: null, maxDownvotes: 3, removeAtScore: -3, scoreFloor: false }),
});
const pages = [];
try {
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { room: roomId, classCode: code } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  check('a new room starts with the floor off', Boolean(await until(() => lastState(host)?.settings.scoreFloor === false)));

  // Two songs from a socket student: A first, then B.
  const maya = await studentSock(roomId, code, 'scorefloor-test-maya-01', 'Maya');
  const pool = [];
  const keys = new Set();
  for (const q of ['Beatles', 'happy']) {
    for (const s of await roomSearch(roomId, 'scorefloor-test-maya-01', q)) {
      if (pool.length >= 2 || keys.has(songKey(s))) continue;
      keys.add(songKey(s));
      if ((await suggestBy(maya, s.id))?.ok) pool.push(s.id);
      await wait(20); // B is added strictly later
    }
  }
  check('two songs are waiting', pool.length === 2 && Boolean(await until(() => lastState(host)?.queue.length === 2)), String(pool.length));
  const item = (songId) => lastState(host)?.queue.find((q) => q.song.id === songId);
  const [A, B] = [item(pool[0]).id, item(pool[1]).id];
  const byId = (id) => lastState(host)?.queue.find((q) => q.id === id);

  // Settings → Songs: the switch, off; the remove score enabled. Turn it on: greyed with the note.
  await hostSettings(host, async () => {
    const sw = await reveal(host.page, '#setScoreFloor');
    check('Settings → Songs: "Scores never go below 0" is off', !(await host.page.isChecked(sw))
      && (await host.page.locator('label', { has: host.page.locator('#setScoreFloor') }).textContent()).includes('Scores never go below 0'));
    check('Settings: the help text', (await text(host, '#scoreFloorHelp')).trim() === "Votes never remove a song, so every student's song gets to play. 👎 can push a song down. Only you can veto.");
    check('floor off: the remove score is enabled, no note', !(await host.page.isDisabled('#setRemove')) && !(await host.page.locator('#removeOffNote').isVisible()));
    await host.page.setChecked(sw, true);
    check('floor on: the remove score is greyed out with a note', (await host.page.isDisabled('#setRemove'))
      && await host.page.locator('#removeOffNote').isVisible()
      && (await host.page.$eval('#removeRow', (el) => Number(getComputedStyle(el).opacity))) < 1);
  });
  check('Use in this room: the floor is on', Boolean(await until(() => lastState(host)?.settings.scoreFloor === true)));

  // The student page, to see what students see.
  const ava = await openPage('ava', `?code=${encodeURIComponent(code)}`);
  pages.push(ava);
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');
  await ava.page.waitForFunction(() => document.querySelectorAll('#queue li').length === 2);

  // Three 👎 on A (three students): it shows 0 and stays.
  const voters = [];
  for (const nick of ['Kai', 'Lux', 'Moe', 'Ned']) voters.push(await studentSock(roomId, code, `scorefloor-test-${nick.toLowerCase()}-00001`, nick));
  for (const v of voters.slice(0, 3)) {
    await until(() => wsState(v));
    send(v, { t: 'vote', id: A, v: -1 });
  }
  check('3 👎: the server counts them', Boolean(await until(() => byId(A)?.down === 3)), JSON.stringify(byId(A)));
  await wait(300);
  check('3 👎 with the remove score at −3: the song is still there, score 0', byId(A)?.score === 0 && lastState(host).queue.length === 2, JSON.stringify(byId(A)));
  const scoreText = () => host.page.locator(`#queue li[data-id="${A}"] .score`).textContent().catch(() => '');
  check('host page shows 0 for it (👎 3)', Boolean(await until(async () => /^\s*0\s*👍 0 · 👎 3/.test(await scoreText()))), await scoreText());
  check('ordering: the 0-vote song (added later) is ahead of the 0 with 3 👎',
    lastState(host).queue.map((q) => q.id).join() === [B, A].join() && Boolean(await until(async () =>
      (await host.page.$$eval('#queue li', (ls) => ls.map((l) => l.dataset.id))).join() === [B, A].join())));
  check('student page: the same order', Boolean(await until(async () => (await ava.page.$$eval('#queue li', (ls) => ls.map((l) => l.dataset.id))).join() === [B, A].join())));
  await until(() => wsState(voters[3]));
  send(voters[3], { t: 'vote', id: A, v: -1 });
  check('a 4th 👎 (below −3): still not removed, still 0', Boolean(await until(() => byId(A)?.down === 4)) && byId(A)?.score === 0);
  await host.page.screenshot({ path: `${OUT}scorefloor-on.png` });

  // Turn it off: nothing removed at once, the real score shows again.
  await hostSettings(host, async () => {
    check('Settings reopened: the switch is on and the remove score greyed', (await host.page.isChecked(await reveal(host.page, '#setScoreFloor'))) && (await host.page.isDisabled('#setRemove')));
    await host.page.setChecked('#setScoreFloor', false);
    check('switch off: the remove score is enabled again', !(await host.page.isDisabled('#setRemove')) && (await host.page.inputValue('#setRemove')) === '-3');
  });
  check('floor off in the room', Boolean(await until(() => lastState(host)?.settings.scoreFloor === false)));
  await wait(400);
  check('turning it off removes nothing at once; the score shows −4', byId(A)?.score === -4 && lastState(host).queue.length === 2, JSON.stringify(byId(A)));
  // The next vote (a 👍 on the other song) applies the remove score.
  send(voters[0], { t: 'vote', id: B, v: 1 });
  check('the next vote removes it at the threshold', Boolean(await until(() => lastState(host)?.queue.length === 1 && !byId(A) && byId(B)?.up === 1)),
    JSON.stringify(lastState(host)?.queue.map((q) => [q.id, q.score])));
  check('student page: it left the queue', Boolean(await until(async () => (await ava.page.locator('#queue li').count()) === 1)));

  // Save as my default: the switch is saved.
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  await host.page.setChecked(await reveal(host.page, '#setScoreFloor'), true);
  await host.page.click(await reveal(host.page, '#saveDefault'));
  const saved = await until(async () => {
    const s = await (await api('/api/teacher/settings')).json();
    return s.scoreFloor === true ? s : null;
  });
  check('Save as my default: the floor is saved on', saved?.scoreFloor === true);
  check('...and this room uses it now', Boolean(await until(() => lastState(host)?.settings.scoreFloor === true)));

  for (const p of pages) check(`${p.name}: no page errors`, p.errors.length === 0, p.errors.join(' | '));
  // Close the room (a closed tab alone leaves it open until `until`).
  const { token } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const closer = await sock(roomId, { role: 'host', token });
  send(closer, { t: 'close' });
} catch (e) {
  failures++;
  console.log(`FAIL the flow stopped: ${e.stack ?? e}`);
  for (const p of pages) await p.page.screenshot({ path: `${OUT}scorefloor-error-${p.name}.png` }).catch(() => {});
} finally {
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) }).catch(() => {});
  await wait(300);
  for (const ws of sockets) try { ws.close(); } catch { /* closed */ }
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
