// Browser test of "👎 votes: Off / On, counts hidden / On, counts shown" (protocol.js DOWNVOTE MODE):
// a host page, a student page, a board page and student sockets in installed Chrome (playwright-core),
// against a LOCAL wrangler dev only.
//   npm run dev, then:  npm run test:downvotemode   (or: node test/browser/downvotemode.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// No Workers AI call: the AI theme check and the album art check are off in Teacher 1's saved
// settings while it runs (put back at the end). Searches hit the real iTunes API.
// Covers: a room with the DEFAULTS (👎 off, floor on): no 👎 buttons on the student page or the host,
// score = 👍, no "👎 N left", the hint says every song gets its turn, a forced 👎 from a socket is
// refused (downvotes_off); Settings → Songs shows "👎 votes: Off" and hides the 👎 limit; counts
// hidden: the student has a 👎 button with no count, the board and the student see 👍 only, the host
// sees the 👎 (muted); counts shown: everything as before (net score, 👎 counts everywhere).

import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { songKey } from '../../shared/repeats.js';
import { DEFAULT_SETTINGS } from '../../shared/protocol.js';
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
  });
  if (path !== null) await page.goto(new URL(path, BASE).href);
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
/** A vote from a socket; resolves with the room's error answer (or null when none came: it worked). */
async function voteBy(ws, id, v) {
  const n = ws.msgs.length;
  send(ws, { t: 'vote', id, v });
  return until(() => ws.msgs.slice(n).find((m) => m.t === 'error'), { timeout: 1500 });
}
async function setMode(host, mode) {
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  await host.page.selectOption(await reveal(host.page, '#setDownMode'), mode);
  await host.page.click('#applySettings');
  return until(() => lastState(host)?.downvoteMode === mode);
}

// ---- The flow ----
check('the defaults: 👎 on with counts hidden (2026-10-21) and the score floor on', DEFAULT_SETTINGS.downvoteMode === 'hidden' && DEFAULT_SETTINGS.scoreFloor === true);
const savedDefaults = await (await api('/api/teacher/settings')).json();
await api('/api/teacher/settings', {
  method: 'PUT',
  body: JSON.stringify({ aiCheck: false, blockUnknownSongs: false, hideVoteCounts: false, artCheck: false, cooldownDays: null, backToWork: false,
    maxWaitingPerStudent: 10, maxSongMinutes: null, maxDownvotes: 3, removeAtScore: -3,
    // 👎 Off to start (this test walks Off, then hidden, then shown); the floor as its default. 👍 unlimited.
    downvoteMode: 'off', scoreFloor: DEFAULT_SETTINGS.scoreFloor, upvotes: true, maxUpvotes: null }),
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
  check('a new room (saved 👎 Off): 👎 off, floor on', Boolean(await until(() => lastState(host)?.downvoteMode === 'off' && lastState(host)?.settings.scoreFloor === true)));

  // Two songs from a socket student.
  const maya = await studentSock(roomId, code, 'downmode-test-maya-0001', 'Maya');
  const pool = [];
  const keys = new Set();
  for (const q of ['Beatles', 'happy']) {
    for (const s of await roomSearch(roomId, 'downmode-test-maya-0001', q)) {
      if (pool.length >= 2 || keys.has(songKey(s))) continue;
      keys.add(songKey(s));
      if ((await suggestBy(maya, s.id))?.ok) pool.push(s.id);
      await wait(20);
    }
  }
  check('two songs are waiting', pool.length === 2 && Boolean(await until(() => lastState(host)?.queue.length === 2)), String(pool.length));
  const [A, B] = pool.map((sid) => lastState(host).queue.find((q) => q.song.id === sid).id);
  const byId = (id) => lastState(host)?.queue.find((q) => q.id === id);

  // The student page.
  const ava = await openPage('ava', `?code=${encodeURIComponent(code)}`);
  pages.push(ava);
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');
  await ava.page.waitForFunction(() => document.querySelectorAll('#queue li').length === 2);
  const row = (p, id) => p.page.locator(`#queue li[data-id="${id}"]`);

  // ---- Off ----
  check('off: the student page has no 👎 buttons', (await ava.page.locator('#queue .vote.down:visible').count()) === 0
    && (await ava.page.locator('#queue .vote.up:visible').count()) === 2);
  check('off: no "👎 N left"', !(await ava.page.locator('#downLeft').isVisible()));
  check('off: the hint says every song gets its turn', (await text(ava, '#voteHint')).includes('every song gets its turn'), await text(ava, '#voteHint'));
  await row(ava, A).locator('.vote.up').click();
  check('off: a 👍 counts (score = 👍)', Boolean(await until(() => byId(A)?.up === 1 && byId(A)?.score === 1)));
  check('off: the student sees 👍 1', Boolean(await until(async () => (await row(ava, A).locator('.vote.up .n').textContent()) === '1')));
  const kai = await studentSock(roomId, code, 'downmode-test-kai-00001', 'Kai');
  await until(() => wsState(kai));
  const refused = await voteBy(kai, A, -1);
  check('off: a forced 👎 is refused (downvotes_off)', refused?.error === 'downvotes_off' && refused?.message === '👎 is turned off in this class.', JSON.stringify(refused));
  await wait(300);
  check('off: nothing changed', byId(A)?.down === 0 && byId(A)?.score === 1, JSON.stringify(byId(A)));
  check('off: the student state says off, no 👎 left number', wsState(kai)?.downvoteMode === 'off' && wsState(kai)?.you?.downvotesLeft === null);
  check('off: the host has no 👎 buttons', (await host.page.locator('#queue button[data-act="down"]').count()) === 0
    && (await host.page.locator('#queue button[data-act="up"]').count()) === 2);
  check('off: the host shows 👍 1 for it', Boolean(await until(async () => (await host.page.locator(`#queue li[data-id="${A}"] .score`).textContent()).trim() === '👍 1')));
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  const modeSel = await reveal(host.page, '#setDownMode');
  check('Settings → Songs: "👎 votes" is Off', (await host.page.inputValue(modeSel)) === 'off'
    && (await host.page.locator('label', { has: host.page.locator('#setDownMode') }).textContent()).includes('👎 votes'));
  check('Settings: the options', JSON.stringify(await host.page.$$eval('#setDownMode option', (os) => os.map((o) => o.textContent.trim())))
    === JSON.stringify(['Off', 'On, counts hidden', 'On, counts shown']));
  check('Settings: the help', (await text(host, '#downModeHelp')).trim() === 'Nobody can 👎. Every song gets its turn.', await text(host, '#downModeHelp'));
  check('Settings: the 👎 limit is hidden while off', !(await host.page.locator('#setMaxDown').isVisible()));
  await host.page.selectOption(modeSel, 'hidden');
  check('Settings: the 👎 limit shows once 👎 is on', await host.page.locator('#setMaxDown').isVisible());
  await host.page.click('#applySettings');
  check('Use in this room: counts hidden', Boolean(await until(() => lastState(host)?.downvoteMode === 'hidden')));
  await ava.page.screenshot({ path: `${OUT}downvotemode-off-then-hidden-student.png` });

  // ---- Counts hidden ----
  check('hidden: the student has 👎 buttons with no count', Boolean(await until(async () => (await ava.page.locator('#queue .vote.down:visible').count()) === 2))
    && (await row(ava, A).locator('.vote.down .n').textContent()) === '');
  check('hidden: "👎 3 left" shows', Boolean(await until(async () => (await ava.page.locator('#downLeft').isVisible()) && (await text(ava, '#downLeft')) === '👎 3 left')));
  check('hidden: a socket 👎 works', (await voteBy(kai, A, -1)) === null);
  check('hidden: the host sees the 👎', Boolean(await until(() => byId(A)?.down === 1)));
  await row(ava, B).locator('.vote.down').click();
  check('hidden: the student page 👎 works (pressed, still no count)', Boolean(await until(() => byId(B)?.down === 1))
    && (await row(ava, B).locator('.vote.down').getAttribute('aria-pressed')) === 'true'
    && (await row(ava, B).locator('.vote.down .n').textContent()) === '');
  const studentA = wsState(kai)?.queue.find((q) => q.id === A);
  check('hidden: students get down 0 and score = 👍', studentA?.down === 0 && studentA?.score === 1, JSON.stringify(studentA));
  check('hidden: the student page shows no 👎 number anywhere', (await ava.page.$$eval('#queue .vote.down .n', (ns) => ns.every((n) => n.textContent === '')))
    && (await ava.page.$$eval('#queue .vote.down', (bs) => bs.every((b) => !/\d/.test(b.getAttribute('aria-label'))))));
  const hostScore = () => host.page.locator(`#queue li[data-id="${A}"] .score`).textContent().catch(() => '');
  check('hidden: the host page shows the 👎 (muted)', Boolean(await until(async () => /👎 1/.test(await hostScore())))
    && (await host.page.locator(`#queue li[data-id="${A}"] .down-muted`).count()) === 1, await hostScore());
  // The board.
  await host.page.click(await reveal(host.page, '#boardBtn'));
  await host.page.waitForSelector('#boardDlg[open]');
  if (await host.page.locator('#boardNew').isVisible()) await host.page.click('#boardNew');
  const boardUrl = await until(async () => (await host.page.inputValue('#boardUrl').catch(() => '')) || null);
  await host.page.click('#boardDlg button[value="done"]');
  const board = await openPage('board', null);
  pages.push(board);
  await board.page.goto(boardUrl);
  await until(() => board.page.locator('#boardScreen').isVisible(), { timeout: 15_000 });
  check('hidden: the board shows 👍 only', Boolean(await until(async () => (await board.page.locator('#queue li').count()) === 2))
    && !/👎/.test(await text(board, '#queue')) && /👍 1/.test(await text(board, '#queue')), await text(board, '#queue'));
  check('hidden: the board state has no 👎 counts', (lastState(board)?.queue ?? []).every((q) => q.down === 0) && lastState(board)?.downvoteMode === 'hidden');
  await board.page.screenshot({ path: `${OUT}downvotemode-hidden-board.png` });

  // ---- Counts shown ----
  check('shown: switched', Boolean(await setMode(host, 'shown')));
  check('shown: the student sees the 👎 counts', Boolean(await until(async () => (await row(ava, A).locator('.vote.down .n').textContent()) === '1')));
  check('shown: the board shows the net and 👎', Boolean(await until(async () => /👎 1/.test(await text(board, '#queue')))));
  check('shown: the student state has the real numbers', Boolean(await until(() => wsState(kai)?.queue.find((q) => q.id === A)?.down === 1)));
  check('shown: the host shows the net', /^\s*0\s*👍 1 · 👎 1/.test(await hostScore()), await hostScore());

  // ---- Back to off: the stored 👎 are kept but ignored; back on restores them ----
  check('off again', Boolean(await setMode(host, 'off')));
  check('off: the 👎 are ignored (score = 👍, down 0)', Boolean(await until(() => byId(A)?.down === 0 && byId(A)?.score === 1 && byId(B)?.score === 0)));
  check('off: the student page lost its 👎 buttons', Boolean(await until(async () => (await ava.page.locator('#queue .vote.down:visible').count()) === 0)));
  check('shown again: the 👎 are back', Boolean(await setMode(host, 'shown')) && Boolean(await until(() => byId(A)?.down === 1 && byId(B)?.down === 1)));
  check('...and Ava\'s own 👎 is pressed again', Boolean(await until(async () => (await row(ava, B).locator('.vote.down').getAttribute('aria-pressed')) === 'true')));

  for (const p of pages) check(`${p.name}: no page errors`, p.errors.length === 0, p.errors.join(' | '));
  const { token } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const closer = await sock(roomId, { role: 'host', token });
  send(closer, { t: 'close' });
} catch (e) {
  failures++;
  console.log(`FAIL the flow stopped: ${e.stack ?? e}`);
  for (const p of pages) await p.page.screenshot({ path: `${OUT}downvotemode-error-${p.name}.png` }).catch(() => {});
} finally {
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) }).catch(() => {});
  await wait(300);
  for (const ws of sockets) try { ws.close(); } catch { /* closed */ }
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
