// Browser test of the board + remote (protocol.js BOARD + REMOTE; web/board/, web/src/board.js,
// web/src/board-host.js, src/room.js board sockets): the desktop runs the host page, a second
// browser context (the projector laptop) opens the board link.
// Against a LOCAL wrangler dev only:
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:board                (or: node test/browser/board.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// No Workers AI call (the room's AI check is off; the repeat cooldown is off so songs replay).
// Searches hit the real iTunes API through the host page.
// Checks: the host makes a board link (fragment, not query); the board shows code, now playing, the
// queue, progress, display preferences; the token leaves the address bar and goes only in the first
// socket message; remote skip / lock / veto (the student is told) work; remote pause and volume are
// relayed to the host page's player; "Start the music on the teacher computer first" and "The
// teacher computer is not connected"; ▶ Play recap from the board plays on the board (← → work)
// and from the desktop too; at most BOARDS_MAX boards; a student cannot use the board token or the
// board's actions; a wrong token and host messages from a board are refused; 🔁 New board link
// kicks the old board (no reconnect); closing the room shows the board's closed screen; no audio,
// video or iframe on the board, no CSP violations, the board's headers.

import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pickTeacher } from './teacher-pick.mjs';
import { displayCode } from '../../shared/code.js';
import { BOARDS_MAX } from '../../shared/protocol.js';
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
const WS_BASE = BASE.replace(/^http/, 'ws');

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const pages = [];

/** Keep every <audio> the page makes (the host's preview player; the board must make none). */
function audioSpy() {
  const A = window.Audio;
  window.__audios = [];
  window.Audio = function Audio(...args) {
    const a = new A(...args);
    window.__audios.push(a);
    return a;
  };
  window.Audio.prototype = A.prototype;
  // Web Audio too (the host's recap ta-das; the board must make none).
  window.__ctx = 0;
  const AC = window.AudioContext;
  if (AC) {
    window.AudioContext = function AudioContext(...args) {
      window.__ctx++;
      return new AC(...args);
    };
    window.AudioContext.prototype = AC.prototype;
  }
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
}

async function newContext() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
  await ctx.addInitScript(audioSpy);
  return ctx;
}

async function openPage(ctx, name, path) {
  const page = await ctx.newPage();
  const p = { name, page, msgs: [], sent: [], sockets: [], errors: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|NotSupportedError|play\(\)|NotAllowedError/.test(m.text())) p.errors.push(m.text());
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
/** The remote hides after a few seconds without the mouse: move it, then press the button. */
async function tap(p, sel) {
  wiggle = (wiggle + 1) % 7;
  await p.page.mouse.move(300 + wiggle * 10, 300);
  await p.page.waitForSelector(`${sel}:visible`);
  await p.page.click(sel);
}
const shot = (p, label) => p.page.screenshot({ path: `${OUT}board-${label}-${p.name}.png` }).catch(() => {});

/** A raw socket (a student, a raw host, or a raw board). */
async function rawSocket(roomId, params) {
  const ws = new WebSocket(`${WS_BASE}api/rooms/${roomId}/ws?${new URLSearchParams(params)}`);
  const s = { ws, msgs: [], closed: null };
  ws.addEventListener('message', (e) => { try { s.msgs.push(JSON.parse(e.data)); } catch { /* not JSON */ } });
  ws.addEventListener('close', (e) => { s.closed = e.code; });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  s.send = (msg) => ws.send(JSON.stringify(msg));
  s.ask = async (msg, pred, timeout = 8000) => {
    const n = s.msgs.length;
    s.send(msg);
    return until(() => s.msgs.slice(n).find(pred), { timeout });
  };
  s.state = () => [...s.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
  return s;
}

let searches = 0;
async function findSong(roomId, q) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    const probe = ['boardtest-device-probe01', 'boardtest-device-probe02'][searches++ % 2];
    const r = await fetch(new URL(`api/rooms/${roomId}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': probe } });
    const data = await r.json();
    if (data.results?.[0]) return data.results[0];
    last = `${r.status} ${JSON.stringify(data).slice(0, 200)}`;
    await wait(2000);
  }
  throw new Error(`no search result for ${q}: ${last}`);
}
const join = (code, device) => fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });

let rawHost = null;
let student = null;
const raws = [];
try {
  // ---- The desktop: open a room as Teacher 1 ----
  const ctxDesk = await newContext();
  const host = await openPage(ctxDesk, 'host', 'host/');
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  const code = `board test ${Date.now() % 100000}`;
  await host.page.fill('#openCode', code);
  await host.page.click('#openBtn');
  check('a room opens on the desktop', Boolean(await until(async () => (await visible(host, '#hostScreen')) && lastState(host), { timeout: 15_000 })));
  const saved = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const roomId = saved.room;
  for (const d of ['boardtest-device-probe01', 'boardtest-device-probe02']) await join(code, d);

  // A raw host socket for the settings (no AI, songs may replay, room for several songs each).
  rawHost = await rawSocket(roomId, { role: 'host', token: saved.token });
  rawHost.send({ t: 'settings', settings: { aiCheck: false, blockUnknownSongs: false, hideVoteCounts: false, maxWaitingPerStudent: 10, cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, noBackToBackArtist: false, oneSongPerArtist: false, backToWork: false } });
  await until(() => rawHost.state()?.settings?.aiCheck === false);
  const STU = 'boardtest-student-0001';
  await join(code, STU);
  student = await rawSocket(roomId, { role: 'student', device: STU, nick: 'Robin' });
  check('a student joins', Boolean(await until(() => student.state()?.you?.nick === 'Robin')));
  const queries = ['Happy Pharrell Williams', 'Shake It Off Taylor Swift', 'Roar Katy Perry', 'Here Comes the Sun Beatles', 'Firework Katy Perry', 'Good as Hell Lizzo'];
  for (const q of queries) {
    const song = await findSong(roomId, q);
    const r = await student.ask({ t: 'suggest', song: song.id }, (m) => m.t === 'suggested' && m.song === song.id, 15_000);
    if (!r?.ok) console.log(`  (note: ${q}: ${r?.reason ?? 'no answer'})`);
  }
  check('songs are in the queue', Boolean(await until(() => (lastState(host)?.queue.length ?? 0) >= 4, { timeout: 15_000 })), String(lastState(host)?.queue.length));
  await host.page.click('#startBtn');
  check('Start music on the desktop: a song plays', Boolean(await until(() => lastState(host)?.nowPlaying, { timeout: 15_000 })));

  // ---- 📺 Board link ----
  check('the host has a 📺 Board link button', await visible(host, await reveal(host.page, '#boardBtn')));
  check('no "Board connected" pill yet', !(await visible(host, '#boardPill')));
  await host.page.click(await reveal(host.page, '#boardBtn'));
  await host.page.waitForSelector('#boardDlg[open]');
  check('no board link yet: "Make a board link"', (await visible(host, '#boardNone')) && (await text(host, '#boardNew')) === '📺 Make a board link');
  await host.page.click('#boardNew');
  const url1 = await until(async () => (await host.page.inputValue('#boardUrl').catch(() => '')) || null);
  const m1 = /\/board\/#([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(url1 ?? '');
  check('the board link is /board/#<room>.<token> (fragment, no query)', Boolean(m1) && m1[1] === roomId && !new URL(url1).search, url1);
  const token1 = m1?.[2] ?? '';
  check('the token is not the host token', token1 && token1 !== saved.token);
  check('the token is kept with the room entry (cq.host)', (await host.page.evaluate(() => JSON.parse(localStorage.getItem('cq.host'))?.boardToken)) === token1);
  await host.page.click('#boardCopy');
  check('Copy puts the link on the clipboard', (await host.page.evaluate(() => navigator.clipboard.readText())) === url1);
  check('the boardLink answer went to that host socket only (not to the raw host)', !rawHost.msgs.some((m) => m.t === 'boardLink'));
  check('students never get the board token', !JSON.stringify(student.msgs).includes(token1));
  await host.page.click('#boardDlg button[value="done"]');

  // ---- The projector laptop opens the board ----
  const ctxBoard = await newContext();
  const board = await openPage(ctxBoard, 'board', null);
  const resp = await board.page.goto(url1);
  const headers = resp.headers();
  check('board CSP: no media at all, scripts and sockets only from this site', /media-src 'none'/.test(headers['content-security-policy'] ?? '')
    && /script-src 'self';/.test(headers['content-security-policy']) && /connect-src 'self';/.test(headers['content-security-policy'])
    && /frame-src 'none'/.test(headers['content-security-policy']), headers['content-security-policy']);
  check('board COOP same-origin, no Referer, no autoplay', headers['cross-origin-opener-policy'] === 'same-origin'
    && headers['referrer-policy'] === 'no-referrer' && /autoplay=\(\)/.test(headers['permissions-policy'] ?? ''));
  check('the board shows the room', Boolean(await until(() => visible(board, '#boardScreen'), { timeout: 15_000 })));
  check('the token left the address bar', (await board.page.evaluate(() => location.hash)) === '' && !(await board.page.url()).includes(token1));
  check('the board socket URL has no token', board.sockets.length > 0 && board.sockets.every((u) => !u.includes(token1) && /role=board/.test(u)), board.sockets.join(' '));
  check('the token goes in the first message', board.sent[0]?.t === 'board' && board.sent[0]?.token === token1);
  check('the class code is on the board', Boolean(await until(async () => (await board.page.getAttribute('#bigCode', 'aria-label')) === displayCode(code))),
    await board.page.getAttribute('#bigCode', 'aria-label'));
  check('the join address is on the board', (await text(board, '#joinHost')) === new URL(BASE).host);
  const hs = lastState(host);
  check('now playing on the board', Boolean(await until(async () => (await text(board, '#nowPlaying .now-title').catch(() => '')) === lastState(host)?.nowPlaying?.song.title)));
  // A 👍 on the song playing (protocol.js VOTES; Robin's own song, as in the queue): live on the board and the host.
  const upNow = async (p) => (await text(p, '#nowPlaying .now-votes .n').catch(() => '')).trim();
  check('the board shows the playing song\'s 👍 (0)', Boolean(await until(async () => (await upNow(board)) === '0')), await upNow(board));
  student.send({ t: 'vote', id: lastState(host).nowPlaying.id, v: 1 });
  check('a 👍 on the song playing: the board shows 👍 1', Boolean(await until(async () => (await upNow(board)) === '1')), await upNow(board));
  check('... and the host page too', Boolean(await until(async () => (await upNow(host)) === '1')) && lastState(host).nowPlaying.up === 1);
  check('up next on the board (votes shown)', Boolean(await until(async () => (await board.page.locator('#queue li').count()) === Math.min(5, lastState(host).queue.length)))
    && /👍/.test(await text(board, '#queue li:first-child .score')));
  check('the host shows "📺 Board connected"', Boolean(await until(() => visible(host, '#boardPill'))) && lastState(host).boards === 1);
  const bs = lastState(board);
  check('the board state has no settings, students, review songs or blocked words', bs && bs.settings === undefined && bs.students === undefined
    && bs.review === undefined && typeof bs.reviewCount === 'number' && !JSON.stringify(board.msgs).includes(saved.token));
  check('the board never gets Blocked today or lookups', !board.msgs.some((m) => ['blocked', 'lookup', 'favoritesAll', 'boardLink'].includes(m.t)));
  check('progress reaches the board', Boolean(await until(() => board.msgs.some((m) => m.t === 'progress' && m.started), { timeout: 12_000 })));
  await board.page.mouse.move(200, 200);
  check('the remote is there', await visible(board, '#remote'));
  await wait(4600);
  check('... and it hides after a few seconds without the mouse', !(await visible(board, '#rPlay')));
  await board.page.keyboard.press('Shift');
  check('... a key brings it back', Boolean(await until(() => visible(board, '#rPlay'))));
  void hs;

  // Display preferences follow the host's (Settings → Teacher preferences).
  await host.page.click('#settingsBtn');
  await host.page.selectOption(await reveal(host.page, '#prefSize'), 'l');
  await host.page.setChecked(await reveal(host.page, '#prefWho'), false);
  await host.page.click('#cancelSettings');
  check('the host\'s text size and "who suggested" reach the board', Boolean(await until(() => board.page.evaluate(() => document.body.classList.contains('big-size-l') && document.body.classList.contains('big-no-who')))));
  await host.page.click('#settingsBtn');
  await host.page.selectOption(await reveal(host.page, '#prefSize'), 'm');
  await host.page.setChecked(await reveal(host.page, '#prefWho'), true);
  await host.page.click('#cancelSettings');

  // ---- Remote: pause / play are relayed to the host's player ----
  await board.page.mouse.move(500, 500);
  check('the board\'s play button says Pause while the desktop plays', Boolean(await until(async () => (await text(board, '#rPlay')) === '⏸ Pause')), await text(board, '#rPlay'));
  await tap(board, '#rPlay');
  check('remote pause: the host page pauses its player', Boolean(await until(async () => (await text(host, '#playBtn')) === '▶ Play'
    && (await host.page.evaluate(() => window.__audios.every((a) => a.paused))))), await text(host, '#playBtn'));
  check('... and the board shows ▶ Play and ⏸ Paused', Boolean(await until(async () => (await text(board, '#rPlay')) === '▶ Play' && (await visible(board, '#pausedNote')))));
  await tap(board, '#rPlay');
  check('remote play: the host plays again', Boolean(await until(async () => (await text(host, '#playBtn')) === '⏸ Pause')));
  const vol0 = Number(await host.page.inputValue('#volume'));
  await tap(board, '#rVolDown');
  check('remote volume down reaches the host', Boolean(await until(async () => Number(await host.page.inputValue('#volume')) < vol0)));
  await tap(board, '#rVolUp');
  check('remote volume up reaches the host', Boolean(await until(async () => Number(await host.page.inputValue('#volume')) === vol0)));

  // ---- Remote: skip, lock, veto ----
  const before = lastState(host).nowPlaying.id;
  await tap(board, '#rSkip');
  check('remote skip: the next song plays', Boolean(await until(() => lastState(host)?.nowPlaying && lastState(host).nowPlaying.id !== before)));
  check('... and the board shows it', Boolean(await until(async () => (await text(board, '#nowPlaying .now-title').catch(() => '')) === lastState(host)?.nowPlaying?.song.title)));
  await board.page.keyboard.press('l');
  check('remote lock (L key): suggestions are locked', Boolean(await until(() => lastState(host)?.locked === true)) && (await text(host, '#lockBtn')) === '🔒 Suggestions locked');
  check('... the board says so', Boolean(await until(async () => (await text(board, '#rLock')) === '🔒 Unlock suggestions' && (await visible(board, '#boardLocked')))));
  await tap(board, '#rLock');
  check('remote unlock', Boolean(await until(() => lastState(host)?.locked === false)));
  const vetoed = lastState(host).nowPlaying;
  await tap(board, '#rVeto');
  await board.page.waitForSelector('#confirm[open]');
  check('veto asks first', /Veto "/.test(await text(board, '#confirmQ')));
  await board.page.click('#confirm button[value="ok"]');
  check('remote veto: the song stops and the next one plays', Boolean(await until(() => lastState(host)?.nowPlaying?.id !== vetoed.id)));
  check('... its student is told', Boolean(await until(() => student.msgs.some((m) => m.t === 'removed' && m.id === vetoed.id && m.why?.id === 'teacher'))));
  check('... it is in Blocked today as a veto', Boolean(await until(() => [...host.msgs].reverse().find((m) => m.t === 'blocked')?.list?.some((b) => b.song.id === vetoed.song.id && b.action === 'veto'))));
  check('... and it is not in the Top 5', !(lastState(host).top5 ?? []).some((t) => t.id === vetoed.id));

  // ---- ▶ Play recap from the board: it plays on the board ----
  await tap(board, '#rRecap');
  check('recap from the board plays on the board', Boolean(await until(() => board.page.evaluate(() => document.querySelector('#showDlg').open))));
  const slide0 = await board.page.getAttribute('#showDlg', 'data-slide');
  await board.page.keyboard.press('ArrowRight');
  check('→ moves to the next slide on the board', Boolean(await until(async () => (await board.page.getAttribute('#showDlg', 'data-slide')) === String(Number(slide0) + 1))));
  await board.page.keyboard.press('ArrowLeft');
  check('← goes back', Boolean(await until(async () => (await board.page.getAttribute('#showDlg', 'data-slide')) === slide0)));
  check('the desktop (not in big screen) does not play it, it says where it plays', !(await host.page.evaluate(() => document.querySelector('#showDlg').open)));
  // 🎵 Recap music (protocol.js RECAP MUSIC): the desktop's speakers play it, timed by the board's cues.
  const hostTop = [...host.msgs].reverse().find((m) => m.t === 'recap' && m.show)?.recap?.top5 ?? [];
  const boardTop = [...board.msgs].reverse().find((m) => m.t === 'recap' && m.show)?.recap?.top5 ?? [];
  check('the board recap has no preview links; the desktop recap has them', boardTop.length > 0 && boardTop.every((t) => !('previewUrl' in t))
    && hostTop.some((t) => t.previewUrl), JSON.stringify({ host: hostTop.map((t) => Boolean(t.previewUrl)), board: boardTop.length }));
  const hostMusic = () => host.page.evaluate(() => document.querySelector('#recapMusic').dataset.state ?? '');
  check('the desktop plays the recap music while the board shows it', Boolean(await until(async () => (await hostMusic()) === 'playing')));
  check('... its preview audio is playing', Boolean(await until(() => host.page.evaluate(() => [...document.querySelectorAll('#recapMusic audio')].some((a) => !a.paused)))));
  await board.page.keyboard.press('Escape');
  check('Esc closes the show on the board', Boolean(await until(() => board.page.evaluate(() => !document.querySelector('#showDlg').open))));
  check('... and the board "end" cue stops the desktop recap music', Boolean(await until(async () => (await hostMusic()) === '')));
  // From the desktop's 🏆 Top 5 dialog: it plays on the board too.
  await host.page.click(await reveal(host.page, '#top5Btn'));
  await host.page.click('#playRecapBtn');
  check('▶ Play recap on the desktop plays on the board', Boolean(await until(() => board.page.evaluate(() => document.querySelector('#showDlg').open))));
  await board.page.keyboard.press('Escape');

  // ---- No audio on the board ----
  const media = await board.page.evaluate(() => ({ audios: window.__audios.length, ctx: window.__ctx, els: document.querySelectorAll('audio, video, iframe').length, csp: window.__csp }));
  check('the board makes no audio, video or iframe (and no Web Audio), even during the recap show', media.audios === 0 && media.ctx === 0 && media.els === 0, JSON.stringify(media));

  // ---- The board and its token, from a student's side ----
  const sBefore = lastState(host);
  const r1 = await student.ask({ t: 'board', token: token1 }, (m) => m.t === 'error');
  check('a student socket cannot send the board hello', r1?.error === 'bad_message');
  const r2 = await student.ask({ t: 'skip', from: sBefore.nowPlaying?.id ?? null }, (m) => m.t === 'error');
  check('a student socket cannot skip', r2?.error === 'bad_message');
  const r3 = await student.ask({ t: 'remote', action: 'playPause' }, (m) => m.t === 'error');
  check('a student socket cannot use the remote', r3?.error === 'bad_message' && lastState(host).nowPlaying?.id === sBefore.nowPlaying?.id);
  // The board endpoint without the token (a student only knows the room id).
  const noTok = await rawSocket(roomId, { role: 'board' });
  raws.push(noTok);
  noTok.send({ t: 'skip', from: null });
  check('the board endpoint: another first message is refused (4002)', Boolean(await until(() => noTok.closed === 4002)) && noTok.msgs.some((m) => m.error === 'board'));
  const wrong = await rawSocket(roomId, { role: 'board' });
  raws.push(wrong);
  wrong.send({ t: 'board', token: 'A'.repeat(43) });
  check('the board endpoint: a wrong token is refused (4002)', Boolean(await until(() => wrong.closed === 4002)) && wrong.msgs.some((m) => m.error === 'board') && !wrong.msgs.some((m) => m.t === 'state'));
  const hostTok = await rawSocket(roomId, { role: 'board', token: saved.token });
  raws.push(hostTok);
  hostTok.send({ t: 'board', token: saved.token });
  check('the board endpoint: the host token is not a board token', Boolean(await until(() => hostTok.closed === 4002)));
  const queryTok = await rawSocket(roomId, { role: 'board', token: token1 });
  raws.push(queryTok);
  queryTok.send({ t: 'ping' });
  await wait(800);
  check('a token in the query string is ignored (no state before the first message)', !queryTok.msgs.some((m) => m.t === 'state'));
  queryTok.ws.close();
  // A real board: host-only messages are refused, nothing changes.
  const rb = await rawSocket(roomId, { role: 'board' });
  raws.push(rb);
  rb.send({ t: 'board', token: token1 });
  check('a raw board with the token gets the board state', Boolean(await until(() => rb.state()?.reviewCount !== undefined)));
  for (const msg of [{ t: 'close' }, { t: 'ban', id: lastState(host).nowPlaying?.id }, { t: 'settings', settings: { aiCheck: true } }, { t: 'kick', device: STU },
    { t: 'next', from: lastState(host).nowPlaying?.id ?? null }, { t: 'boardLink' }, { t: 'code', code: 'hacked code 1' }, { t: 'credits', all: true, amount: 5 }]) {
    const r = await rb.ask(msg, (m) => m.t === 'error');
    check(`a board cannot send '${msg.t}'`, r?.error === 'bad_message');
  }
  await wait(300);
  check('... and the room is unchanged (open, same song, AI still off, student still in)', lastState(host)?.open && lastState(host).nowPlaying?.id === sBefore.nowPlaying?.id
    && lastState(host).settings.aiCheck === false && lastState(host).students.some((s) => s.device === STU) && (await visible(host, '#hostScreen')));
  const stale = await rb.ask({ t: 'veto', id: 'q-not-playing' }, (m) => m.t === 'error');
  check('a veto of a song that is not playing is refused', stale?.error === 'no_item');

  // ---- At most BOARDS_MAX boards: the newest win ----
  const extra = [];
  for (let i = 0; i < BOARDS_MAX - 1; i++) {
    const b = await rawSocket(roomId, { role: 'board' });
    raws.push(b);
    b.send({ t: 'board', token: token1 });
    await until(() => b.state());
    extra.push(b);
  }
  check(`more than ${BOARDS_MAX} boards: the oldest stops`, Boolean(await until(async () => (await visible(board, '#msgScreen')) && /stopped/.test(await text(board, '#msgTitle')))),
    await text(board, '#msgTitle'));
  check(`... the host counts ${BOARDS_MAX}`, Boolean(await until(() => lastState(host)?.boards === BOARDS_MAX)));
  for (const b of [rb, ...extra]) b.ws.close();
  await board.page.goto(new URL('board/', BASE).href);
  check('the board page comes back from its kept entry (no link needed)', Boolean(await until(() => visible(board, '#boardScreen'), { timeout: 15_000 })));

  // ---- "Start the music first" and "not connected" ----
  await host.page.reload();
  check('the desktop reloads into the room', Boolean(await until(async () => (await visible(host, '#hostScreen')) && (await text(host, '#connText')) === 'Connected', { timeout: 15_000 })));
  check('... it keeps the board link', (await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host'))?.boardToken ?? JSON.parse(localStorage.getItem('cq.host'))?.boardToken)) === token1);
  await wait(800);
  await board.page.mouse.move(400, 400);
  await tap(board, '#rPlay');
  check('remote play before Start music: the board says so', Boolean(await until(async () => /Start the music on the teacher computer first/.test(await text(board, '#rNote')))));
  check('... and the desktop asks for the click', Boolean(await until(async () => /Click Start music on this computer/.test(await host.page.locator('#toasts').textContent()))));
  rawHost.ws.close(); // only the host page is a host from here on
  rawHost = null;
  await host.page.close();
  check('no host page: "The teacher computer is not connected" and ⏯ is off', Boolean(await until(async () => /not connected/.test(await text(board, '#rNote'))
    && (await board.page.isDisabled('#rPlay')))));
  const host2 = await openPage(ctxDesk, 'host2', 'host/');
  check('the desktop comes back', Boolean(await until(async () => (await visible(host2, '#hostScreen')) && lastState(host2), { timeout: 15_000 })));
  check('... the board sees it', Boolean(await until(async () => !(await board.page.isDisabled('#rPlay')))));
  await host2.page.click(await reveal(host2.page, '#boardBtn'));
  check('... and its Board link dialog shows the same link', (await host2.page.inputValue('#boardUrl')) === url1);

  // ---- 🔁 New board link: the old board stops for good ----
  const boardSockets = board.sockets.length;
  await host2.page.click('#boardNew');
  await host2.page.waitForSelector('#confirm[open]');
  await host2.page.click('#confirm button[value="ok"]');
  const url2 = await until(async () => {
    const v = await host2.page.inputValue('#boardUrl').catch(() => '');
    return v && v !== url1 ? v : null;
  });
  check('🔁 New board link makes a different link', Boolean(url2));
  check('... the old board shows "A new board link was made"', Boolean(await until(async () => (await visible(board, '#msgScreen'))
    && (await text(board, '#msgTitle')) === 'A new board link was made')));
  await wait(5000);
  check('... and it does not reconnect', board.sockets.length === boardSockets, `${board.sockets.length} vs ${boardSockets}`);
  check('... its kept entry is gone', (await board.page.evaluate(() => localStorage.getItem('cq.board'))) === null);
  const old = await rawSocket(roomId, { role: 'board' });
  raws.push(old);
  old.send({ t: 'board', token: token1 });
  check('... the old token is refused', Boolean(await until(() => old.closed === 4002)));
  await host2.page.click('#boardDlg button[value="done"]');
  await board.page.goto(url2); // the same tab: only the fragment changes (no reload)
  check('the new link pasted into the same tab works', Boolean(await until(() => visible(board, '#boardScreen'), { timeout: 15_000 })));
  check('... and leaves the address bar too', (await board.page.evaluate(() => location.hash)) === '');

  // ---- Closing the room: the board's closed screen ----
  await host2.page.click(await reveal(host2.page, '#closeBtn'));
  await host2.page.waitForSelector('#confirm[open]');
  await host2.page.click('#confirm button[value="ok"]');
  check('closing the room: the board shows the closed screen', Boolean(await until(async () => (await visible(board, '#msgScreen')) && (await text(board, '#msgTitle')) === 'The room is closed')));

  const csp = await board.page.evaluate(() => window.__csp);
  check('no CSP violations on the board', csp.length === 0, csp.join(' | '));
  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
  await shot(board, 'end');
} catch (e) {
  failures++;
  console.log(`FAIL board stopped: ${e?.stack ?? e}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  for (const s of [rawHost, student, ...raws]) try { s?.ws.close(); } catch { /* closed */ }
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
