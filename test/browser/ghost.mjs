// Browser test of the 👻 ghost 👍 (protocol.js GHOST VOTE): a host page, a student page, a board and
// student sockets in installed Chrome (playwright-core), against a LOCAL wrangler dev only.
//   npm run dev, then:  npm run test:ghost   (or: node test/browser/ghost.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// No Workers AI call: the AI theme check and the album art check are off in Teacher 1's saved
// settings while it runs (put back at the end). Searches hit the real iTunes API (through the host page).
// Takes about 1.5 minutes: ghostVoteMinutes is 1 (no test hooks in the room) and the room's alarm
// must re-sort with no message at all.
// Covers: Settings → Songs → The queue (off by default, minutes greyed while off, help text); an older
// 0-vote song A and a newer song B with one real 👍: B leads, then at A's 1-minute mark A ties at 1 and
// moves ahead (added first) with NO event; the host's normal view shows a small 👻 on A (not on the Big
// screen); the student page and the board show 👍 1 on A with no 👻 and no "ghost" in any message they
// got; A plays and the Top 5 shows its 👍 1 (what the class saw); Save as my default.

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
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
async function openPage(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const p = { name, ctx, page, msgs: [], raw: [], errors: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      p.raw.push(String(f.payload));
      try { p.msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ }
    });
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
  ws.raw = [];
  ws.onmessage = (e) => {
    ws.raw.push(String(e.data));
    ws.msgs.push(JSON.parse(e.data));
  };
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
/** A song from the search that suggests fine (not one already used). */
async function suggestOne(ws, roomId, device, queries, used) {
  for (const q of queries) {
    for (const s of await roomSearch(roomId, device, q)) {
      if (used.has(songKey(s)) || !(s.previewUrl)) continue;
      used.add(songKey(s));
      if ((await suggestBy(ws, s.id))?.ok) return s;
    }
  }
  return null;
}

// ---- The flow ----
const savedDefaults = await (await api('/api/teacher/settings')).json();
await api('/api/teacher/settings', {
  method: 'PUT',
  body: JSON.stringify({ aiCheck: false, blockUnknownSongs: false, hideVoteCounts: false, artCheck: false, cooldownDays: null, backToWork: false,
    maxWaitingPerStudent: 10, maxSongMinutes: null, noBackToBackArtist: false, ghostVote: false, ghostVoteMinutes: 3 }),
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
  check('a new room starts with the ghost 👍 off', Boolean(await until(() => lastState(host)?.settings.ghostVote === false)));

  // Settings → Songs → The queue: off, minutes greyed; turn it on with 1 minute.
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  const sw = await reveal(host.page, '#setGhost');
  check('Settings → Songs: "👻 Ghost 👍" is off', !(await host.page.isChecked(sw))
    && (await host.page.locator('label', { has: host.page.locator('#setGhost') }).textContent()).includes('👻 Ghost 👍'));
  check('off: the minutes box hides (keeping 3)', !(await host.page.isVisible('#setGhostMin')) && (await host.page.inputValue('#setGhostMin')) === '3');
  check('off: the help says what off does', (await text(host, '#ghostHelp')).trim() === 'Off: songs only get the 👍 students give them.', await text(host, '#ghostHelp'));
  await host.page.setChecked(sw, true);
  check('on: the minutes box shows', await host.page.isVisible('#setGhostMin'));
  check('on: the help says what on does', (await text(host, '#ghostHelp')).trim()
    === 'A song that waits 3 minutes gets 1 free 👍, so every song gets some love. Students cannot tell.', await text(host, '#ghostHelp'));
  await host.page.fill('#setGhostMin', '1');
  check('the help follows the minutes', (await text(host, '#ghostHelp')).includes('waits 1 minute gets'), await text(host, '#ghostHelp'));

  // Song A (0 votes) from a socket student before the setting is applied: its clock runs from addedAt.
  const maya = await studentSock(roomId, code, 'ghost-test-maya-000001', 'Maya');
  const used = new Set();
  const songA = await suggestOne(maya, roomId, 'ghost-test-maya-000001', ['Beatles', 'happy'], used);
  const tA = Date.now();
  check('song A is waiting', Boolean(songA) && Boolean(await until(() => lastState(host)?.queue.length === 1)));
  await host.page.click('#applySettings');
  check('Use in this room: ghost on, 1 minute', Boolean(await until(() => lastState(host)?.settings.ghostVote === true && lastState(host)?.settings.ghostVoteMinutes === 1)));

  // The student page and the board, to see what the class sees.
  const ava = await openPage('ava', `?code=${encodeURIComponent(code)}`);
  pages.push(ava);
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');
  check('students do not get the ghost settings', !('ghostVote' in (lastState(ava)?.settings ?? {})) && !('ghostVoteMinutes' in (lastState(ava)?.settings ?? {})),
    JSON.stringify(Object.keys(lastState(ava)?.settings ?? {})));

  await host.page.click(await reveal(host.page, '#boardBtn'));
  await host.page.waitForSelector('#boardDlg[open]');
  await host.page.click('#boardNew');
  const boardUrl = await until(async () => (await host.page.inputValue('#boardUrl').catch(() => '')) || null);
  await host.page.click('#boardDlg button[value="done"]');
  const board = await openPage('board', null);
  pages.push(board);
  await board.page.goto(boardUrl);
  check('the board shows the queue', Boolean(await until(async () => (await board.page.locator('#queue li').count()) >= 1, { timeout: 15_000 })));

  // Song B, 20 s after A, with one real 👍: B leads (1 vs 0).
  await wait(Math.max(0, tA + 20_000 - Date.now()));
  const songB = await suggestOne(maya, roomId, 'ghost-test-maya-000001', ['Queen', 'sunshine'], used);
  check('song B is waiting', Boolean(songB) && Boolean(await until(() => lastState(host)?.queue.length === 2)));
  const byId = (p, s) => lastState(p)?.queue.find((q) => q.song.id === s.id);
  const kai = await studentSock(roomId, code, 'ghost-test-kai-0000001', 'Kai');
  await until(() => wsState(kai));
  send(kai, { t: 'vote', id: byId(host, songB).id, v: 1 });
  check('B has 1 real 👍 and leads; A has none', Boolean(await until(() => byId(host, songB)?.up === 1))
    && lastState(host).queue[0].song.id === songB.id && byId(host, songA).up === 0 && !byId(host, songA).ghost,
    JSON.stringify(lastState(host)?.queue.map((q) => [q.song.title, q.up, q.ghost])));
  check('student page: B first before A\'s ghost', Boolean(await until(async () => (await ava.page.$$eval('#queue li', (ls) => ls.map((l) => l.dataset.id))).join()
    === lastState(host).queue.map((q) => q.id).join())));

  // A's 1-minute mark: no message from anyone; the room's alarm re-sorts and broadcasts.
  const msgsBefore = host.msgs.length;
  const flipped = await until(() => lastState(host)?.queue[0]?.song.id === songA.id, { timeout: Math.max(5_000, tA + 75_000 - Date.now()), every: 250 });
  const flipAt = Date.now() - tA;
  check('at 1 minute A ties at 1 (ghost) and moves ahead (added first) with no event', Boolean(flipped) && flipAt >= 59_000,
    `${flipAt} ms; ${JSON.stringify(lastState(host)?.queue.map((q) => [q.song.title, q.up, q.ghost]))}`);
  check('a new state arrived by itself', host.msgs.length > msgsBefore);
  const hostA = byId(host, songA);
  check('host state: A up 1 with ghost: 1; B has no ghost yet', hostA?.up === 1 && hostA?.ghost === 1 && !byId(host, songB)?.ghost, JSON.stringify(hostA));
  const mark = host.page.locator(`#queue li[data-id="${hostA.id}"] .ghost-mark`);
  check('host normal view: a small 👻 on A', Boolean(await until(() => mark.isVisible())));
  check('host: no 👻 on B', (await host.page.locator(`#queue li[data-id="${byId(host, songB).id}"] .ghost-mark`).count()) === 0);
  await host.page.screenshot({ path: `${OUT}ghost-host.png` });
  await host.page.click(await reveal(host.page, '#bigBtn'));
  check('Big screen: no 👻', Boolean(await until(async () => !(await mark.isVisible()))));
  await host.page.keyboard.press('Escape');

  // Students: A shows 👍 1 like any vote; no 👻; no "ghost" anywhere in what they got.
  const avaRow = ava.page.locator(`#queue li[data-id="${hostA.id}"] .vote.up .n`);
  check('student page: A shows 👍 1 and is first', Boolean(await until(async () => (await avaRow.textContent().catch(() => '')) === '1'))
    && (await ava.page.$$eval('#queue li', (ls) => ls[0]?.dataset.id)) === hostA.id);
  check('student page: no 👻 shown', !(await ava.page.locator('#queue').textContent()).includes('👻'));
  check('student state: A up 1, score 1, no ghost field, myVote 0', (() => {
    const a = byId(ava, songA);
    return a?.up === 1 && a.score === 1 && !('ghost' in a) && a.myVote === 0;
  })(), JSON.stringify(byId(ava, songA)));
  check('student page: no "ghost" in any message', !ava.raw.some((r) => r.includes('ghost')));
  check('student sockets: no "ghost" in any message', ![maya, kai].some((w) => w.raw.some((r) => r.includes('ghost'))));
  check('board: A shows 👍 1 first, no 👻', Boolean(await until(async () => /👍 1/.test(await text(board, '#queue li:first-child .score').catch(() => ''))))
    && !(await board.page.locator('#queue').textContent()).includes('👻'));
  check('board: no "ghost" in any message', board.raw.length > 0 && !board.raw.some((r) => r.includes('ghost')));
  await ava.page.screenshot({ path: `${OUT}ghost-student.png` });
  await board.page.screenshot({ path: `${OUT}ghost-board.png` });

  // A plays: the Top 5 shows the 👍 the class saw (1).
  await host.page.click('#startBtn');
  check('A plays next', Boolean(await until(() => lastState(host)?.nowPlaying?.song.id === songA.id, { timeout: 15_000 })));
  check('playing: A still shows 👍 1 for students', Boolean(await until(() => lastState(ava)?.nowPlaying?.up === 1 && !('ghost' in lastState(ava).nowPlaying))));
  const t5 = await until(() => lastState(ava)?.top5?.find((t) => t.song.id === songA.id));
  check('Top 5 (students): A with 👍 1, no ghost field', t5?.up === 1 && !('ghost' in t5), JSON.stringify(t5));
  check('Top 5 (host): A with 👍 1', lastState(host)?.top5?.find((t) => t.song.id === songA.id)?.up === 1);

  // Save as my default.
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  check('Settings reopened: on, 1 minute', (await host.page.isChecked(await reveal(host.page, '#setGhost'))) && (await host.page.inputValue('#setGhostMin')) === '1');
  await host.page.fill('#setGhostMin', '4');
  await host.page.click(await reveal(host.page, '#saveDefault'));
  const saved = await until(async () => {
    const s = await (await api('/api/teacher/settings')).json();
    return s.ghostVote === true && s.ghostVoteMinutes === 4 ? s : null;
  });
  check('Save as my default: ghost on, 4 minutes', Boolean(saved));

  for (const p of pages) check(`${p.name}: no page errors`, p.errors.length === 0, p.errors.join(' | '));
  const { token } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const closer = await sock(roomId, { role: 'host', token });
  send(closer, { t: 'close' });
} catch (e) {
  failures++;
  console.log(`FAIL the flow stopped: ${e.stack ?? e}`);
  for (const p of pages) await p.page.screenshot({ path: `${OUT}ghost-error-${p.name}.png` }).catch(() => {});
} finally {
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) }).catch(() => {});
  await wait(300);
  for (const ws of sockets) try { ws.close(); } catch { /* closed */ }
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
