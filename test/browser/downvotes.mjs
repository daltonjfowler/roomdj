// Browser test of the 👎 limit (protocol.js DOWNVOTE LIMIT): a host page, a student page and a
// student socket in installed Chrome (playwright-core), against a LOCAL wrangler dev only.
//   npm run dev, then:  npm run test:downvotes   (or: node test/browser/downvotes.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// No Workers AI call: the AI theme check and the album art check are off in Teacher 1's saved
// settings while it runs (put back at the end). Searches hit the real iTunes API (through the host page).
// Covers: Settings → Songs "👎 per student per class" (1 / 2 / 3 / 5 / Unlimited), the "👎 2 left"
// counter, a third 👎 refused with the message (page: says why, no vote sent; socket: error
// 'downvotes', no rest started), the 👎 buttons aria-disabled but still explained on click, an own
// votes are final (no take-back), a reload keeps the count, the host's Students list "👎 2/2", Unlimited,
// and Save as my default.

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
  body: JSON.stringify({ aiCheck: false, blockUnknownSongs: false, hideVoteCounts: false, artCheck: false, cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false, maxWaitingPerStudent: 10, maxSongMinutes: null, maxDownvotes: 3 }),
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
  check('a new room takes the saved default: 3', Boolean(await until(() => lastState(host)?.settings.maxDownvotes === 3)));

  // Settings → Songs: 1 / 2 / 3 / 5 / Unlimited; pick 2.
  await hostSettings(host, async () => {
    const sel = await reveal(host.page, '#setMaxDown');
    const options = await host.page.$$eval(`${sel} option`, (os) => os.map((o) => o.textContent));
    check('Settings → Songs: "👎 per student per class" offers 1 / 2 / 3 / 5 / Unlimited', options.join() === '1,2,3,5,Unlimited', options.join());
    check('Settings: it shows the room\'s 3', (await host.page.inputValue(sel)) === '3');
    await host.page.selectOption(sel, '2');
  });
  check('Use in this room: the limit is 2', Boolean(await until(() => lastState(host)?.settings.maxDownvotes === 2)));

  // Five songs from a socket student.
  const maya = await studentSock(roomId, code, 'downvote-test-maya-0001', 'Maya');
  const pool = [];
  const keys = new Set();
  for (const q of ['Beatles', 'happy']) {
    for (const s of await roomSearch(roomId, 'downvote-test-maya-0001', q)) {
      if (pool.length >= 5 || keys.has(songKey(s))) continue;
      keys.add(songKey(s));
      if ((await suggestBy(maya, s.id))?.ok) pool.push(s.id);
    }
  }
  check('five songs are waiting', pool.length === 5 && Boolean(await until(() => lastState(host)?.queue.length === 5)), String(pool.length));
  const items = lastState(host).queue.map((q) => q.id);

  // The student page.
  const ava = await openPage('ava', `?code=${encodeURIComponent(code)}`);
  pages.push(ava);
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');
  await ava.page.waitForFunction(() => document.querySelectorAll('#queue li').length === 5);
  check('counter: "👎 2 left" next to the votes', Boolean(await until(async () => (await text(ava, '#downLeft')) === '👎 2 left'))
    && await ava.page.locator('#downLeft').isVisible(), await text(ava, '#downLeft'));
  const down = (id) => `#queue li[data-id="${id}"] .vote.down`;
  const downCount = (id) => lastState(host)?.queue.find((q) => q.id === id)?.down;
  await ava.page.click(down(items[0]));
  await ava.page.click(down(items[1]));
  check('two 👎 count on the server', Boolean(await until(() => downCount(items[0]) === 1 && downCount(items[1]) === 1)));
  check('counter: "👎 0 left"', Boolean(await until(async () => (await text(ava, '#downLeft')) === '👎 0 left')), await text(ava, '#downLeft'));
  check('no 👎 left: the other 👎 buttons are aria-disabled (still buttons, never disabled)',
    (await ava.page.getAttribute(down(items[2]), 'aria-disabled')) === 'true' && !(await ava.page.$eval(down(items[2]), (b) => b.disabled)));
  check('no 👎 left: my own 👎 is not marked spent', (await ava.page.getAttribute(down(items[0]), 'aria-disabled')) === 'false');
  const sentBefore = (ava.sent ?? []).length;
  await ava.page.click(down(items[2]), { force: true }); // aria-disabled: Playwright would wait for "enabled"
  check('a third 👎 says why ("You\'ve used your 👎 for this class…")',
    Boolean(await until(async () => (await text(ava, '#toasts')).includes("You've used your 👎 for this class. You can still 👍 songs you like."))));
  await wait(400);
  check('a third 👎 is not sent and not counted', !(ava.sent ?? []).slice(sentBefore).some((m) => m.t === 'vote') && downCount(items[2]) === 0);
  await ava.page.click(`#queue li[data-id="${items[2]}"] .vote.up`);
  check('👍 still works', Boolean(await until(() => lastState(host)?.queue.find((q) => q.id === items[2])?.up === 1)));
  await ava.page.screenshot({ path: `${OUT}downvotes-none-left.png` });

  // Host: Students list shows "👎 2/2".
  await host.page.click(await reveal(host.page, '#studentsBtn'));
  await host.page.waitForSelector('#studentsDlg[open]');
  check('host Students: "👎 2/2" for Ava', Boolean(await until(async () => (await host.page.locator('#students li', { hasText: 'Ava' }).textContent()).includes('👎 2/2'))));
  await host.page.keyboard.press('Escape');

  // Votes are final (protocol.js VOTES ARE FINAL): clicking my own 👎 again takes nothing back.
  await ava.page.click(down(items[0]));
  check('votes are final: clicking my 👎 again says so', Boolean(await until(async () => (await text(ava, '#toasts')).includes('Votes are final.'))));
  await wait(400);
  check('votes are final: the 👎 stays and none is freed', downCount(items[0]) === 1 && (await text(ava, '#downLeft')) === '👎 0 left');

  // A reload is the same device: still none left.
  await ava.page.reload();
  await ava.page.waitForSelector('#roomScreen:not([hidden])', { timeout: 15_000 });
  check('reload: still "👎 0 left"', Boolean(await until(async () => (await text(ava, '#downLeft').catch(() => '')) === '👎 0 left', { timeout: 15_000 })));

  // The server refuses a forced 👎 (a socket that ignores the page), with the message; no rest starts.
  const zed = await studentSock(roomId, code, 'downvote-test-zed-00001', 'Zed');
  await until(() => wsState(zed));
  send(zed, { t: 'vote', id: items[0], v: -1 });
  send(zed, { t: 'vote', id: items[1], v: -1 });
  await until(() => (wsState(zed)?.you.downvotesLeft === 0));
  // Back to work on: a refused vote must not start a rest (the two 👎 above happened while it was off).
  await hostSettings(host, async () => host.page.selectOption(await reveal(host.page, '#setBackToWork'), '3'));
  await until(() => lastState(host)?.settings.backToWork === true);
  const n = zed.msgs.length;
  send(zed, { t: 'vote', id: items[2], v: -1 });
  const refused = await until(() => zed.msgs.slice(n).find((m) => m.t === 'error'));
  check('server: a forced third 👎 is refused with error downvotes and the message',
    refused?.error === 'downvotes' && refused.message === "You've used your 👎 for this class. You can still 👍 songs you like." && refused.id === items[2], JSON.stringify(refused));
  send(zed, { t: 'vote', id: items[2], v: 0 }); // a take-back (not a vote, no rest): a fresh snapshot for the host
  await wait(500);
  const zedRow = lastState(host)?.students.find((s) => s.nick === 'Zed');
  check('server: the refused 👎 started no back-to-work rest', zedRow?.restUntil === null && downCount(items[2]) === 0, JSON.stringify(zedRow));
  await hostSettings(host, async () => host.page.selectOption(await reveal(host.page, '#setBackToWork'), 'off'));
  await until(() => lastState(host)?.settings.backToWork === false);

  // Unlimited: no counter, every 👎 works.
  await hostSettings(host, async () => host.page.selectOption(await reveal(host.page, '#setMaxDown'), 'off'));
  check('Unlimited: the room has no limit', Boolean(await until(() => lastState(host)?.settings.maxDownvotes === null)));
  check('Unlimited: the counter goes', Boolean(await until(async () => !(await ava.page.locator('#downLeft').isVisible()))));
  check('Unlimited: no 👎 button is aria-disabled', (await ava.page.$$eval('#queue .vote.down', (bs) => bs.every((b) => b.getAttribute('aria-disabled') !== 'true'))));
  await ava.page.click(down(items[3])); // items[2] has Ava's 👍, and votes are final
  await ava.page.click(down(items[4]));
  check('Unlimited: more 👎 count', Boolean(await until(() => downCount(items[3]) === 1 && downCount(items[4]) === 1)), `${downCount(items[3])} ${downCount(items[4])}`);

  // Lowering it mid-room keeps every 👎 and blocks new ones.
  await hostSettings(host, async () => host.page.selectOption(await reveal(host.page, '#setMaxDown'), '1'));
  check('lowered to 1: Ava\'s 👎 all stay', Boolean(await until(() => lastState(host)?.settings.maxDownvotes === 1))
    && [items[0], items[1], items[3], items[4]].every((id) => lastState(host).queue.find((q) => q.id === id)?.down >= 1));
  check('lowered to 1: "👎 0 left"', Boolean(await until(async () => (await text(ava, '#downLeft')) === '👎 0 left')));

  // Save as my default: Unlimited is saved as null.
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  await host.page.selectOption(await reveal(host.page, '#setMaxDown'), 'off');
  await host.page.click(await reveal(host.page, '#saveDefault'));
  const saved = await until(async () => {
    const s = await (await api('/api/teacher/settings')).json();
    return s.maxDownvotes === null ? s : null;
  });
  check('Save as my default: Unlimited is saved', saved?.maxDownvotes === null, JSON.stringify(saved?.maxDownvotes));
  await host.page.keyboard.press('Escape');

  for (const p of pages) check(`${p.name}: no page errors`, p.errors.length === 0, p.errors.join(' | '));
  // Close the room (a closed tab alone leaves it open until `until`).
  const { token } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const closer = await sock(roomId, { role: 'host', token });
  send(closer, { t: 'close' });
} catch (e) {
  failures++;
  console.log(`FAIL the flow stopped: ${e.stack ?? e}`);
  for (const p of pages) await p.page.screenshot({ path: `${OUT}downvotes-error-${p.name}.png` }).catch(() => {});
} finally {
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) }).catch(() => {});
  await wait(300);
  for (const ws of sockets) try { ws.close(); } catch { /* closed */ }
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
