import { reveal } from './ui.mjs';
// Browser test of the board's sign-in (protocol.js BOARD SIGN-IN; web/src/board.js, src/open-rooms.js,
// POST /api/teacher/board): the projector laptop signs in once (teacher key + Remember + Teacher 1)
// and from then on finds Teacher 1's room by itself, every period.
// Against a LOCAL wrangler dev only:
//   npm run dev                          (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:board-signin            (or: node test/browser/board-signin.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override. No Workers
// AI call, no song search. Rooms other tests left open are taken off Teacher 1's and Teacher 2's local KV
// signpost (openRooms) first, so the board starts with nothing to find (local KV only, never --remote;
// for a dev server started with --persist-to <dir>, set CQ_PERSIST=<dir>).
// Checks: /board with no link asks for the key (a wrong key is refused), "Remember", Who's teaching;
// the waiting screen (teacher's name, clock); the host opens a room and the board connects by
// itself (no link; the key never in a URL, the token only in the first socket message); the remote
// works; Teacher 2's board never sees Teacher 1's room (and the API says no_room); the 📺 dialog shows the
// sign-in way first; a link board keeps working and is not kicked when sign-in tokens are handed
// out; a reload needs no key; closing the room sends the board back to waiting and it follows the
// next room; ⋯ → Switch teacher; a key that stopped working goes back to the key step; Forget this
// computer.

import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T2, T1, pickTeacher } from './teacher-pick.mjs';
import { displayCode } from '../../shared/code.js';
import { BOARD_SIGNIN_MAX } from '../../shared/protocol.js';

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

/** Delete a key from the LOCAL KV (wrangler kv --local; never --remote). */
function localKvDelete(key) {
  const persist = process.env.CQ_PERSIST ? ['--persist-to', process.env.CQ_PERSIST] : [];
  const wrangler = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));
  const r = spawnSync(process.execPath, [wrangler, 'kv', 'key', 'delete', key, '--binding', 'CLASS_KV', '--local', ...persist],
    { cwd: fileURLToPath(ROOT), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler kv key delete ${key} --local failed: ${r.stderr.slice(-300)}`);
}

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures++;
    // Never print the key, whatever a detail holds.
    console.log(`FAIL ${name}${detail ? `: ${String(detail).split(KEY).join('<key>')}` : ''}`);
  }
  return ok;
}
async function until(fn, { timeout = 10_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_WAIT = 25_000; // a waiting board asks every 10 s

/** POST /api/teacher/board as `profile` → [status, body]. */
async function signinApi(profile, key = KEY) {
  const r = await fetch(new URL('api/teacher/board', BASE), { method: 'POST', headers: { 'x-teacher-key': key, 'x-teacher-profile': profile } });
  return [r.status, await r.json().catch(() => ({}))];
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const pages = [];

function spy() {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
}

async function openPage(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.addInitScript(() => localStorage.setItem('cq.useKey', '1')); // the teacher key, not Spotify sign-in
  await ctx.addInitScript(spy);
  const page = await ctx.newPage();
  const p = { name, ctx, page, msgs: [], sent: [], sockets: [], errors: [], urls: [], keyHeaders: 0 };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|NotSupportedError|play\(\)|NotAllowedError/.test(m.text())) p.errors.push(m.text());
  });
  page.on('request', (req) => {
    p.urls.push(req.url());
    if (req.url().endsWith('/api/teacher/board') && req.headers()['x-teacher-key'] === KEY) p.keyHeaders++;
  });
  page.on('websocket', (ws) => {
    p.sockets.push(ws.url());
    ws.on('framereceived', (f) => { try { p.msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ } });
    ws.on('framesent', (f) => { try { p.sent.push(JSON.parse(f.payload)); } catch { /* not JSON */ } });
  });
  if (path) await page.goto(new URL(path, BASE).href);
  pages.push(p);
  return p;
}
const lastState = (p) => [...p.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const visible = (p, sel) => p.page.locator(sel).isVisible();
const text = (p, sel) => p.page.locator(sel).textContent();
let wiggle = 0;
async function tap(p, sel) {
  wiggle = (wiggle + 1) % 7;
  await p.page.mouse.move(300 + wiggle * 10, 300);
  await p.page.waitForSelector(`${sel}:visible`);
  await p.page.click(sel);
}
const shot = (p, label) => p.page.screenshot({ path: `${OUT}board-signin-${label}-${p.name}.png` }).catch(() => {});
const screen = (p) => p.page.evaluate(() => ['boardScreen', 'msgScreen', 'signinScreen', 'waitScreen'].find((id) => !document.getElementById(id).hidden) ?? null);
const step = (p) => p.page.evaluate(() => (!document.getElementById('keyStep').hidden ? 'key' : !document.getElementById('whoStep').hidden ? 'who' : null));
const boardCode = (p) => p.page.getAttribute('#bigCode', 'aria-label');

/** Open a room on the host page as Teacher 1 (the page is already past the start screen or on it). */
async function openRoom(host, code) {
  await pickTeacher(host.page, KEY, 'Teacher 1');
  await host.page.fill('#openCode', code);
  await host.page.click('#openBtn');
  const ok = await until(async () => (await visible(host, '#hostScreen')) && lastState(host)?.open, { timeout: 15_000 });
  return ok ? host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host'))) : null;
}
async function closeRoom(host) {
  await host.page.click(await reveal(host.page, '#closeBtn'));
  await host.page.waitForSelector('#confirm[open]');
  await host.page.click('#confirm button[value="ok"]');
  await until(() => visible(host, '#closedScreen'));
}

const opened = []; // { room, token } host entries, closed at the end whatever happens
try {
  // Rooms left open by other tests: off the signpost (Teacher 1 = legacy = the plain key).
  localKvDelete('openRooms');
  localKvDelete(`p:${T2}:openRooms`);
  for (const [who, id] of [['Teacher 1', T1], ['Teacher 2', T2]]) {
    const [status] = await signinApi(id);
    if (status !== 404) throw new Error(`${who} still has a room on the signpost (a KV read cached?): run again in a minute`);
  }

  // ---- The projector laptop: /board with no link → sign in ----
  const board = await openPage('board', 'board/');
  check('no link: the board asks for the teacher key', Boolean(await until(async () => (await screen(board)) === 'signinScreen' && (await step(board)) === 'key')));
  check('... "Remember on this computer" is there, not ticked', (await visible(board, '#remember')) && !(await board.page.isChecked('#remember')));
  await board.page.fill('#key', 'not the teacher key');
  await board.page.click('#keyNext');
  check('a wrong key is refused', Boolean(await until(async () => /did not work|Wrong teacher key/.test(await text(board, '#keyStepMsg')), { timeout: 5_000 }))
    && (await step(board)) === 'key', await text(board, '#keyStepMsg'));
  check('... and nothing is remembered', (await board.page.evaluate(() => localStorage.getItem('cq.teacherKey'))) === null);
  await board.page.fill('#key', KEY);
  await board.page.check('#remember');
  await board.page.click('#keyNext');
  check('the right key: Who\'s teaching?', Boolean(await until(async () => (await step(board)) === 'who' && (await board.page.locator('#whoList .who-pick').count()) > 1)));
  check('... the key is remembered on this computer (Remember ticked)', (await board.page.evaluate(() => localStorage.getItem('cq.teacherKey'))) === KEY);
  await board.page.locator('#whoList .who-pick', { hasText: 'Teacher 1' }).first().click();
  check('no room open: "Waiting for Teacher 1 to open a room…"', Boolean(await until(async () => (await screen(board)) === 'waitScreen'
    && (await text(board, '#waitTitle')) === 'Waiting for Teacher 1 to open a room…')), await text(board, '#waitTitle'));
  check('... with a clock', /\d:\d\d/.test(await text(board, '#waitClock')), await text(board, '#waitClock'));
  check('... and Switch teacher / Forget this computer', (await visible(board, '#waitSwitch')) && (await visible(board, '#waitForget')));
  check('... the teacher is remembered on this computer', JSON.parse(await board.page.evaluate(() => localStorage.getItem('cq.boardTeacher')))?.id === T1);
  check('the board asked for Teacher 1\'s room with the key in a header', board.keyHeaders > 0);
  await shot(board, 'waiting');

  // ---- Teacher 2's board on a second laptop (no Remember) ----
  const t2 = await openPage('t2', 'board/');
  await until(async () => (await step(t2)) === 'key');
  await t2.page.fill('#key', KEY);
  await t2.page.click('#keyNext');
  await until(async () => (await step(t2)) === 'who' && (await t2.page.locator('#whoList .who-pick').count()) > 1);
  await t2.page.locator('#whoList .who-pick', { hasText: 'Teacher 2' }).first().click();
  check('Teacher 2\'s board waits for Teacher 2', Boolean(await until(async () => (await text(t2, '#waitTitle')) === 'Waiting for Teacher 2 to open a room…')));
  check('... not ticked: the key is not kept on that computer', (await t2.page.evaluate(() => localStorage.getItem('cq.teacherKey'))) === null);

  // ---- The desktop opens Teacher 1's room: the board finds it by itself ----
  const host = await openPage('host', 'host/');
  await host.page.waitForSelector('#startScreen:not([hidden])');
  const code1 = `signin one ${Date.now() % 100000}`;
  const room1 = await openRoom(host, code1);
  check('the desktop opens Teacher 1\'s room', Boolean(room1));
  opened.push(room1);
  const t0 = Date.now();
  check('the board connects to Teacher 1\'s room by itself (no link)', Boolean(await until(async () => (await screen(board)) === 'boardScreen', { timeout: POLL_WAIT })));
  console.log(`  (found the room in ${Math.round((Date.now() - t0) / 1000)} s)`);
  check('... it shows the class code', Boolean(await until(async () => (await boardCode(board)) === displayCode(code1))), await boardCode(board));
  check('... the host shows "📺 Board connected"', Boolean(await until(() => visible(host, '#boardPill'))));
  check('the key never went in a URL', board.urls.every((u) => !u.includes(encodeURIComponent(KEY)) && !u.includes(KEY))
    && board.sockets.every((u) => !u.includes(KEY)));
  const auto = JSON.parse(await board.page.evaluate(() => localStorage.getItem('cq.boardAuto')));
  check('the board token is not in the socket URL, only in the first message', board.sockets.every((u) => !u.includes(auto?.token ?? '-') && /role=board/.test(u))
    && board.sent[0]?.t === 'board' && board.sent[0]?.token === auto?.token);
  check('... and the room is Teacher 1\'s room', auto?.room === room1.room && auto?.profile === T1);

  // The remote works (lock and unlock).
  await tap(board, '#rLock');
  check('remote: lock reaches the room', Boolean(await until(() => lastState(host)?.locked === true)));
  await tap(board, '#rLock');
  check('remote: unlock', Boolean(await until(() => lastState(host)?.locked === false)));
  await board.page.mouse.move(200, 200);
  check('the remote has the ⋯ menu (signed-in board)', await visible(board, '#rMenu'));

  // ---- Teacher 2's board never sees Teacher 1's room ----
  await wait(12_000); // past one more of Teacher 2's polls
  check('Teacher 2\'s board is still waiting, it never opened a room socket', (await screen(t2)) === 'waitScreen' && t2.sockets.length === 0);
  const [dStatus, dBody] = await signinApi(T2);
  check('the API: Teacher 2 has no room (Teacher 1\'s is not handed out)', dStatus === 404 && dBody.error === 'no_room' && !JSON.stringify(dBody).includes(room1.room));
  const [, wrongKey] = await signinApi(T1, 'nope');
  check('the API: a wrong key gets nothing', wrongKey.error === 'key' && !wrongKey.room);

  // ---- 📺 Board link: the sign-in way first; a link board still works ----
  await host.page.click(await reveal(host.page, '#boardBtn'));
  await host.page.waitForSelector('#boardDlg[open]');
  check('the 📺 dialog shows the sign-in way first', (await visible(host, '#boardEasy'))
    && /sign in once and pick your name\. It finds your room every period\./.test(await text(host, '#boardEasy'))
    && (await host.page.evaluate(() => Boolean(document.querySelector('#boardEasy').compareDocumentPosition(document.querySelector('#boardNew')) & Node.DOCUMENT_POSITION_FOLLOWING))),
  await text(host, '#boardEasy'));
  check('... with this site\'s board address', (await text(host, '#boardSigninUrl')) === `${new URL(BASE).host}/board`);
  await host.page.click('#boardNew');
  // A board is connected (the signed-in one), so it asks first, and says sign-in boards keep working.
  await host.page.waitForSelector('#confirm[open]');
  check('... "Make a new board link?" says signed-in boards keep working', /signed in .* keep working/.test(await text(host, '#confirm [data-detail]')));
  await host.page.click('#confirm button[value="ok"]');
  const url1 = await until(async () => (await host.page.inputValue('#boardUrl').catch(() => '')) || null);
  await host.page.click('#boardDlg button[value="done"]');
  check('a board link is made', /\/board\/#[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(url1 ?? ''));
  const linked = await openPage('linked', null);
  await linked.page.goto(url1);
  check('the link board works as before', Boolean(await until(async () => (await screen(linked)) === 'boardScreen', { timeout: 15_000 }))
    && Boolean(await until(async () => (await boardCode(linked)) === displayCode(code1))));
  await tap(linked, '#rMenu');
  await linked.page.waitForSelector('#menuDlg[open]');
  check('... a link board ⋯ menu has Edit layout only (no Switch teacher or Forget)', await linked.page.isVisible('#menuLayout')
    && !(await linked.page.isVisible('#menuSwitch')) && !(await linked.page.isVisible('#menuForget')));
  await linked.page.keyboard.press('Escape');
  check('... the host counts 2 boards', Boolean(await until(() => lastState(host)?.boards === 2)));
  // New sign-in tokens (past the cap): never the link board.
  const boardSockets = board.sockets.length;
  for (let i = 0; i < BOARD_SIGNIN_MAX; i++) {
    const [s, b] = await signinApi(T1);
    if (!check(`the API hands Teacher 1 a new token for his room (${i + 1})`, s === 200 && b.room === room1.room && /^[A-Za-z0-9_-]{43}$/.test(b.boardToken ?? ''))) break;
  }
  await wait(1500);
  check('new sign-in tokens do not kick the link board', (await screen(linked)) === 'boardScreen' && !linked.msgs.some((m) => m.t === 'error'));
  check('the oldest sign-in token stopped: that board asked again and is back', Boolean(await until(async () => board.sockets.length > boardSockets
    && (await screen(board)) === 'boardScreen' && lastState(board), { timeout: POLL_WAIT })));
  check('... both boards connected', Boolean(await until(() => lastState(host)?.boards === 2)));

  // ---- Reload: no key prompt ----
  const calls = () => board.urls.filter((u) => u.endsWith('/api/teacher/board')).length;
  const callsBefore = calls();
  await board.page.reload();
  check('reload: no key prompt, straight back into the room', Boolean(await until(async () => (await screen(board)) === 'boardScreen'
    && (await boardCode(board)) === displayCode(code1), { timeout: 15_000 })));
  check('... it reused its kept token (no new sign-in call)', calls() === callsBefore, `${calls()} vs ${callsBefore}`);

  // ---- The room closes: back to waiting, then the next room ----
  await closeRoom(host);
  opened.length = 0;
  check('room closed: the board goes back to waiting for Teacher 1', Boolean(await until(async () => (await screen(board)) === 'waitScreen'
    && (await text(board, '#waitTitle')) === 'Waiting for Teacher 1 to open a room…')));
  check('... the link board shows "The room is closed"', Boolean(await until(async () => (await text(linked, '#msgTitle')) === 'The room is closed')));
  check('... the room\'s sign-in token is forgotten', (await board.page.evaluate(() => localStorage.getItem('cq.boardAuto'))) === null);
  const [afterClose] = await signinApi(T1);
  check('the API: no room for Teacher 1 after closing', afterClose === 404);
  await host.page.click('#newRoomBtn');
  const code2 = `signin two ${Date.now() % 100000}`;
  const room2 = await openRoom(host, code2);
  opened.push(room2);
  check('the desktop opens the next room', Boolean(room2) && room2.room !== room1.room);
  check('the board follows to the next room by itself', Boolean(await until(async () => (await screen(board)) === 'boardScreen'
    && (await boardCode(board)) === displayCode(code2), { timeout: POLL_WAIT })), await boardCode(board));
  check('... Teacher 2\'s board is still waiting', (await screen(t2)) === 'waitScreen' && t2.sockets.length === 0);

  // ---- ⋯ → Switch teacher ----
  await tap(board, '#rMenu');
  await board.page.waitForSelector('#menuDlg[open]');
  check('the menu says whose room it shows', (await text(board, '#menuTeacher')) === 'Teacher 1');
  await board.page.click('#menuSwitch');
  check('Switch teacher: Who\'s teaching? (no key asked)', Boolean(await until(async () => (await step(board)) === 'who' && (await board.page.locator('#whoList .who-pick').count()) > 1)));
  check('... the board left the room', Boolean(await until(() => lastState(host)?.boards === 0)));
  await board.page.locator('#whoList .who-pick', { hasText: 'Teacher 1' }).first().click();
  check('... picking Teacher 1 again goes back to his room', Boolean(await until(async () => (await screen(board)) === 'boardScreen'
    && (await boardCode(board)) === displayCode(code2), { timeout: POLL_WAIT })));
  await closeRoom(host);
  opened.length = 0;
  check('closed again: waiting', Boolean(await until(async () => (await screen(board)) === 'waitScreen')));

  // ---- The remembered key stops working (the password changed) ----
  await board.page.evaluate(() => {
    localStorage.setItem('cq.teacherKey', 'an old teacher key');
    sessionStorage.setItem('cq.teacherKey', JSON.stringify('an old teacher key'));
  });
  check('a key that stopped working: back to the key step, with a friendly message', Boolean(await until(async () => (await step(board)) === 'key'
    && /changed/.test(await text(board, '#keyStepMsg')), { timeout: POLL_WAIT })), await text(board, '#keyStepMsg'));
  check('... the old key is forgotten', (await board.page.evaluate(() => localStorage.getItem('cq.teacherKey'))) === null);
  await board.page.fill('#key', KEY);
  await board.page.check('#remember');
  await board.page.click('#keyNext');
  check('... the new key: straight back to waiting for Teacher 1 (the teacher is kept)', Boolean(await until(async () => (await screen(board)) === 'waitScreen')));

  // ---- Forget this computer ----
  await board.page.click('#waitForget');
  check('Forget this computer: the key step', Boolean(await until(async () => (await step(board)) === 'key')));
  const left = await board.page.evaluate(() => [localStorage.getItem('cq.teacherKey'), sessionStorage.getItem('cq.teacherKey'), localStorage.getItem('cq.boardTeacher'), localStorage.getItem('cq.boardAuto')]);
  check('... nothing of the sign-in is left on this computer', left.every((v) => v === null), JSON.stringify(left.map((v) => v !== null)));
  await board.page.reload();
  check('... and a reload asks for the key again', Boolean(await until(async () => (await step(board)) === 'key')));

  for (const p of pages) {
    const csp = await p.page.evaluate(() => window.__csp).catch(() => []);
    check(`no CSP violations on ${p.name}`, csp.length === 0, csp.join(' | '));
    check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
  }
  await shot(board, 'end');
} catch (e) {
  failures++;
  console.log(`FAIL board sign-in stopped: ${String(e?.stack ?? e).split(KEY).join('<key>')}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  // Never leave a room open (the next run, and the other tests, expect none).
  for (const r of opened) {
    try {
      const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}api/rooms/${r.room}/ws?${new URLSearchParams({ role: 'host', token: r.token })}`);
      await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
      ws.send(JSON.stringify({ t: 'close' }));
      await wait(500);
      ws.close();
    } catch { /* gone already */ }
  }
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
