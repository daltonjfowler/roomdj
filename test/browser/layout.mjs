// Browser test of ✏️ Edit layout (web/src/layout.js, shared/layout.js) on the host page (normal view
// and big screen) and the board: E and the 📺 Screen menu enter it, a gutter drag changes the column
// widths, the corner grip and A+ / arrow keys change a panel's --scale (and its text gets bigger),
// ⠿ drag and ← → swap columns, 👁 Hide + the Hidden chips, locked panels on the host, Esc and Done
// leave, the layout is kept after a reload, per view (normal vs big screen) and per teacher
// (cq.layout:<view>:<profile>), the board's own layout (cq.layout:board), Reset all, nothing to drag
// outside edit mode, and an axe scan in edit mode. Screenshots (1366x768, 1920x1080) of a sample
// arrangement go to LAYOUT_SHOTS (default test/browser/.out/layout/).
// Against a LOCAL wrangler dev only:
//   npm run dev, then:  npm run test:layout   (or node test/browser/layout.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Searches hit the real iTunes API.

import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T1, T2, closeOpenRooms } from './teacher-pick.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = new URL('../../', import.meta.url);
const SHOTS = process.env.LAYOUT_SHOTS || fileURLToPath(new URL('./.out/layout/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: runs only against a local dev server (not ${BASE})`);
  process.exit(1);
}

const UMC = fileURLToPath(new URL('../uploadmycut/', ROOT));
function resolveFrom(spec) {
  try { return createRequire(import.meta.url).resolve(spec); } catch { return createRequire(`${UMC}package.json`).resolve(spec); }
}
const pw = await import(pathToFileURL(resolveFrom('playwright-core')).href);
const { chromium } = pw.chromium ? pw : pw.default;
const AXE = readFileSync(resolveFrom('axe-core/axe.min.js'), 'utf8');

const vars = readFileSync(new URL('.dev.vars', ROOT), 'utf8');
const KEY = vars.split(/\r?\n/).find((l) => l.startsWith('TEACHER_KEY='))?.slice('TEACHER_KEY='.length).trim().replace(/^"(.*)"$/, '$1');
if (!KEY) throw new Error('TEACHER_KEY is not in .dev.vars');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
  return ok;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 8_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(every);
  }
}

// ---- A room with songs (API + sockets, no AI; songs may replay) ----
const code = `layout room ${10 + Math.floor(Math.random() * 89)}`;
await closeOpenRooms(BASE, KEY); // one room per teacher
const opened = await fetch(new URL('api/teacher/rooms', BASE), {
  method: 'POST', headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json' },
  body: JSON.stringify({ code, until: Date.now() + 30 * 60_000 }),
});
const room = await opened.json();
if (!opened.ok) throw new Error(`could not open a room: ${room.error}`);
const wsBase = BASE.replace(/^http/, 'ws');
const sock = (params) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${wsBase}api/rooms/${room.room}/ws?${new URLSearchParams(params)}`);
  ws.msgs = [];
  ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
  ws.onopen = () => resolve(ws);
  ws.onerror = reject;
});
const host = await sock({ role: 'host', token: room.hostToken });
host.send(JSON.stringify({ t: 'settings', settings: { aiCheck: false, blockUnknownSongs: false, maxWaitingPerStudent: 10, cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false } }));
await wait(400);
const DEVICE = 'layout-test-device-001';
await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': DEVICE, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
const student = await sock({ role: 'student', device: DEVICE, nick: 'Maya' });
for (const q of ['Happy Pharrell Williams', 'Shake It Off Taylor Swift', 'Roar Katy Perry', 'Firework Katy Perry']) {
  const r = await fetch(new URL(`api/rooms/${room.room}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': DEVICE } });
  const id = (await r.json()).results?.[0]?.id;
  if (id) student.send(JSON.stringify({ t: 'suggest', song: id }));
  await wait(300);
}
host.send(JSON.stringify({ t: 'next' }));
await wait(500);
host.send(JSON.stringify({ t: 'boardInfo', code: room.code, display: { size: 'm', who: true, art: true } }));
host.send(JSON.stringify({ t: 'boardLink' }));
await wait(500);
const boardToken = host.msgs.find((m) => m.t === 'boardLink')?.token;
if (!boardToken) throw new Error('no board link');
const boardUrl = new URL(`board/#${room.room}.${boardToken}`, BASE).href;
const hostSaved = { room: room.room, classCode: room.code, token: room.hostToken, until: room.until };

const browser = await chromium.launch({ executablePath: CHROME });

async function newHost(viewport = { width: 1366, height: 768 }) {
  const ctx = await browser.newContext({ viewport, bypassCSP: true });
  await ctx.addInitScript(({ saved, t1 }) => {
    sessionStorage.setItem('cq.host', JSON.stringify(saved));
    if (!localStorage.getItem('cq.profile')) {
      localStorage.setItem('cq.profile', JSON.stringify({ id: t1, name: 'Teacher 1' }));
      localStorage.setItem('cq.profilePrefs', t1);
    }
  }, { saved: hostSaved, t1: T1 });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(new URL('host/', BASE).href);
  await page.waitForSelector('#hostScreen:not([hidden]) #queue li', { timeout: 15_000 });
  return { ctx, page };
}

// ---- Helpers that read the page ----
const editing = (page) => page.evaluate(() => document.body.classList.contains('layout-edit'));
const scaleOf = (page, panel) => page.evaluate((p) => Number(document.querySelector(`[data-panel="${p}"]`).style.getPropertyValue('--scale') || 1), panel);
const width = (page, sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().width, sel);
const left = (page, sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().left, sel);
const shown = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return Boolean(el && el.getClientRects().length); }, sel);
const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const box = async (page, sel) => (await page.locator(sel).first().boundingBox());
const frame = (panel) => `.layout-frame[data-for="${panel}"]`;
async function drag(page, sel, dx, dy) {
  await page.evaluate(() => scrollTo(0, 0));
  const b = await box(page, sel);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await wait(60);
  await page.mouse.up();
  await wait(100);
}
async function pressKey(page, key) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(key);
}
async function scan(page, label) {
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
  const detail = r.violations.map((v) => `[${v.impact}] ${v.id} (${v.nodes.length}x): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`).join(' | ');
  check(`axe: ${label}`, r.violations.length === 0, detail);
}
/** The height of a queue song title on screen (zoom makes the text itself bigger). */
const titleHeight = (page) => page.evaluate(() => document.querySelector('#queue .song-title').getBoundingClientRect().height);

const NORMAL = `cq.layout:normal:${T1}`;
const BIG = `cq.layout:big:${T1}`;

try {
  // ==== Host, normal view ====
  let { ctx, page } = await newHost();
  await page.evaluate(() => localStorage.removeItem('cq.big'));

  // Outside edit mode: nothing to drag, Ctrl + wheel does nothing to the layout.
  check('outside edit mode: no edit frames, grips or gutters on screen', !(await shown(page, '.layout-layer'))
    && !(await shown(page, '.layout-grip')) && !(await shown(page, '.layout-gutter')));
  const qb = await box(page, '[data-panel="queue"]');
  await page.mouse.move(qb.x + 40, qb.y + 40);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  check('outside edit mode: Ctrl + wheel does not scale a panel', (await scaleOf(page, 'queue')) === 1);
  check('outside edit mode: nothing stored', (await stored(page, NORMAL)) === null);

  // E enters edit mode.
  await pressKey(page, 'e');
  check('E: edit mode on (dashed frames, edit bar)', await editing(page) && await shown(page, '.layout-editbar') && await shown(page, frame('queue')));
  check('... announced', Boolean(await until(async () => /Edit layout on/.test(await page.textContent('#announce')))));
  check('... focus on Done', await page.evaluate(() => document.activeElement?.dataset.do === 'done'));
  check('... the menu item says it is on', (await page.getAttribute('#layoutBtn', 'aria-checked')) === 'true');
  check('... Now playing and Needs a look have no Hide on the host', !(await page.locator(`${frame('now')} [data-do="hide"]`).count())
    && !(await page.locator(`${frame('review')} [data-do="hide"]`).count()) && (await page.locator(`${frame('queue')} [data-do="hide"]`).count()) === 1);
  check('... the handles are labelled buttons', await page.evaluate(() => ['Move Now playing', 'Make Up next text bigger', 'Hide Up next', 'Reset Join at']
    .every((l) => document.querySelector(`.layout-layer button[aria-label="${l}"]`))));
  await scan(page, 'host normal view in edit mode');

  // Gutter: the edge between Now playing and Up next.
  const nowW = await width(page, '[data-col="now"]');
  const queueW = await width(page, '[data-col="queue"]');
  await drag(page, '.layout-gutter[data-pair="now|queue"]', 150, 0);
  const nowW2 = await width(page, '[data-col="now"]');
  const queueW2 = await width(page, '[data-col="queue"]');
  check('gutter drag: Now playing wider, Up next narrower', nowW2 > nowW + 80 && queueW2 < queueW - 80, `${nowW}→${nowW2}, ${queueW}→${queueW2}`);
  await drag(page, '.layout-gutter[data-pair="now|queue"]', 2000, 0);
  check('gutter drag far: Up next keeps at least 200 px', (await width(page, '[data-col="queue"]')) >= 199, String(await width(page, '[data-col="queue"]')));
  await page.focus('.layout-gutter[data-pair="now|queue"]');
  const before = await width(page, '[data-col="now"]');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await wait(100);
  check('gutter keys: ← makes the left column narrower', (await width(page, '[data-col="now"]')) < before - 10);
  check('... the separator has a value', Number(await page.getAttribute('.layout-gutter[data-pair="now|queue"]', 'aria-valuenow')) > 0);

  // Corner grip: Up next text bigger.
  const h0 = await titleHeight(page);
  await drag(page, `${frame('queue')} .layout-grip`, 120, 120);
  const s1 = await scaleOf(page, 'queue');
  const h1 = await titleHeight(page);
  check('corner drag: Up next --scale grows', s1 > 1.2 && s1 <= 2.5, String(s1));
  check('... and its text gets bigger', h1 > h0 * 1.15, `${h0}→${h1}`);
  check('... the readout says so', (await page.textContent(`${frame('queue')} .layout-pct`)) === `${Math.round(s1 * 100)}%`);
  await drag(page, `${frame('queue')} .layout-grip`, 2000, 2000);
  check('corner drag far: at most 2.5', (await scaleOf(page, 'queue')) === 2.5);
  check('... Up next does not spill sideways out of its panel', await page.evaluate(() => {
    const p = document.querySelector('[data-panel="queue"]');
    return p.scrollWidth <= p.clientWidth + 1 || getComputedStyle(p).overflowX === 'auto';
  }));
  await page.click(`${frame('queue')} [data-do="reset"]`);
  check('↺ on Up next: back to 1', (await scaleOf(page, 'queue')) === 1);
  // Keyboard: A+ and the grip's arrow keys; Ctrl + wheel in edit mode.
  await page.click(`${frame('join')} [data-do="bigger"]`);
  await page.click(`${frame('join')} [data-do="bigger"]`);
  check('A+ twice on Join at: 1.2', (await scaleOf(page, 'join')) === 1.2);
  await page.focus(`${frame('join')} .layout-grip`);
  await page.keyboard.press('ArrowDown');
  check('grip ↓: 1.1', (await scaleOf(page, 'join')) === 1.1);
  const jb = await box(page, '[data-panel="join"]');
  await page.mouse.move(jb.x + jb.width / 2, jb.y + jb.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  check('Ctrl + wheel up over Join at in edit mode: bigger', Boolean(await until(async () => (await scaleOf(page, 'join')) === 1.2)));
  check('... the class code times scale with their panel', await page.evaluate(() => document.querySelector('#untilNote').closest('[data-panel]').dataset.panel === 'join'));

  // Move: drag Join at onto Up next's column, then ← → buttons.
  await page.evaluate(() => scrollTo(0, 0));
  await drag(page, `${frame('join')} .layout-move`, (await box(page, '[data-col="queue"]')).x + 60 - ((await box(page, `${frame('join')} .layout-move`)).x + 20), 0);
  check('move drag: Join at and Up next swap places', Boolean(await until(async () => (await left(page, '[data-col="join"]')) > (await left(page, '[data-col="queue"]')))));
  await page.click(`${frame('join')} [data-do="left"]`);
  const order = await page.evaluate(() => ['join', 'now', 'queue'].sort((a, b) => document.querySelector(`[data-col="${a}"]`).getBoundingClientRect().left - document.querySelector(`[data-col="${b}"]`).getBoundingClientRect().left));
  check('← on Join at: one place left', order.join() === 'queue,join,now', order.join());
  check('... announced with the new order', Boolean(await until(async () => /Join at moved left/.test(await page.textContent('#announce')))));

  // Hide / show.
  await page.click(`${frame('queue')} [data-do="hide"]`);
  check('👁 Hide Up next: gone, Needs a look column kept', !(await shown(page, '[data-panel="queue"]')) && (await page.evaluate(() => !document.querySelector('[data-col="queue"]').classList.contains('layout-col-off'))));
  check('... the edit bar lists it', /Hidden:\s*Up next \(show\)/.test(await page.textContent('.layout-hidden-list')));
  await page.click('.layout-chip[data-show="queue"]');
  check('Up next (show): back', await shown(page, '[data-panel="queue"]'));
  await page.click(`${frame('join')} [data-do="hide"]`);
  check('👁 Hide Join at: its column goes', !(await shown(page, '[data-col="join"]')));
  await page.click('.layout-chip[data-show="join"]');
  await page.click(`${frame('top5')} [data-do="smaller"]`).catch(() => {}); // Top 5 not on screen: no frame shown

  // Esc leaves; Done too.
  await page.keyboard.press('Escape');
  check('Esc: edit mode off', !(await editing(page)) && !(await shown(page, '.layout-layer')));
  check('... focus back on 📺 Screen', await page.evaluate(() => document.activeElement?.id === 'screenMenuBtn'));
  const savedNormal = JSON.parse(await stored(page, NORMAL));
  check('saved under cq.layout:normal:<Teacher 1>', savedNormal?.v === 1 && savedNormal.order.join() === 'queue,join,now' && savedNormal.scale.join === 1.2 && Boolean(savedNormal.widths), JSON.stringify(savedNormal));
  check('outside edit mode again: the grip is gone', !(await shown(page, '.layout-grip')));
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}host-normal-1366.png` });

  // Reload: the same layout.
  await page.reload();
  await page.waitForSelector('#hostScreen:not([hidden]) #queue li', { timeout: 15_000 });
  check('after a reload: the same order and sizes', (await scaleOf(page, 'join')) === 1.2
    && (await left(page, '[data-col="queue"]')) < (await left(page, '[data-col="join"]'))
    && (await left(page, '[data-col="join"]')) < (await left(page, '[data-col="now"]')));

  // Big screen: its own layout.
  await pressKey(page, 'b');
  await page.waitForFunction(() => document.body.classList.contains('big'));
  check('big screen: its own layout (the usual one)', (await scaleOf(page, 'join')) === 1
    && (await left(page, '[data-col="join"]')) < (await left(page, '[data-col="now"]')));
  await page.click('#screenMenuBtn');
  await page.click('#layoutBtn');
  check('📺 Screen → ✏️ Edit layout on big screen', await editing(page) && await shown(page, frame('now')));
  check('... on the big screen Now playing can be hidden', (await page.locator(`${frame('now')} [data-do="hide"]`).count()) === 1);
  await page.click(`${frame('now')} [data-do="bigger"]`);
  await page.click(`${frame('now')} [data-do="bigger"]`);
  await page.click(`${frame('queue')} [data-do="hide"]`);
  check('big screen: Up next hidden, its column gone', !(await shown(page, '[data-col="queue"]')));
  await scan(page, 'host big screen in edit mode');
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${SHOTS}host-big-edit-1366.png` });
  await page.keyboard.press('Escape');
  check('Esc on big screen: leaves edit mode, stays big', !(await editing(page)) && await page.evaluate(() => document.body.classList.contains('big')));
  const savedBig = JSON.parse(await stored(page, BIG));
  check('saved under cq.layout:big:<Teacher 1>', savedBig?.scale.now === 1.2 && savedBig.hidden.includes('queue'), JSON.stringify(savedBig));
  await page.screenshot({ path: `${SHOTS}host-big-1366.png` });
  await pressKey(page, 'b');
  await page.waitForFunction(() => !document.body.classList.contains('big'));
  check('back to the normal view: its own layout again', (await scaleOf(page, 'join')) === 1.2 && (await scaleOf(page, 'now')) === 1 && await shown(page, '[data-panel="queue"]'));

  // Per teacher: Teacher 2 on this computer has the usual layout; Teacher 1's comes back.
  await page.evaluate((t2) => localStorage.setItem('cq.profile', JSON.stringify({ id: t2, name: 'Teacher 2' })), T2);
  await page.reload();
  await page.waitForSelector('#hostScreen:not([hidden]) #queue li', { timeout: 15_000 });
  check('Teacher 2 on this computer: the usual layout', (await scaleOf(page, 'join')) === 1
    && (await left(page, '[data-col="join"]')) < (await left(page, '[data-col="now"]')));
  await pressKey(page, 'e');
  await page.click(`${frame('queue')} [data-do="bigger"]`);
  await page.keyboard.press('Escape');
  check('... Teacher 2\'s own layout is stored apart', JSON.parse(await stored(page, `cq.layout:normal:${T2}`))?.scale.queue === 1.1
    && JSON.parse(await stored(page, NORMAL))?.scale.queue === undefined);
  await page.evaluate((t1) => localStorage.setItem('cq.profile', JSON.stringify({ id: t1, name: 'Teacher 1' })), T1);
  await page.reload();
  await page.waitForSelector('#hostScreen:not([hidden]) #queue li', { timeout: 15_000 });
  check('back to Teacher 1: his layout', (await scaleOf(page, 'join')) === 1.2 && (await scaleOf(page, 'queue')) === 1);
  await page.close();
  await ctx.close();

  // ==== Screenshots at 1920 x 1080 of the same arrangement ====
  {
    const big = await newHost({ width: 1920, height: 1080 });
    await big.page.evaluate(({ n, b, nk, bk }) => { localStorage.setItem(nk, n); localStorage.setItem(bk, b); }, { n: JSON.stringify(savedNormal), b: JSON.stringify(savedBig), nk: NORMAL, bk: BIG });
    await big.page.reload();
    await big.page.waitForSelector('#hostScreen:not([hidden]) #queue li', { timeout: 15_000 });
    await big.page.screenshot({ path: `${SHOTS}host-normal-1920.png` });
    await pressKey(big.page, 'e');
    await wait(150);
    await big.page.screenshot({ path: `${SHOTS}host-normal-edit-1920.png` });
    await big.page.keyboard.press('Escape');
    await pressKey(big.page, 'b');
    await wait(200);
    await big.page.screenshot({ path: `${SHOTS}host-big-1920.png` });
    check('1920 x 1080: no sideways scrolling (normal and big)', await big.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await big.ctx.close();
  }

  // ==== Reset all ====
  ({ ctx, page } = await newHost());
  await page.evaluate((k) => localStorage.removeItem('cq.big'), null);
  await page.evaluate(({ n, nk }) => localStorage.setItem(nk, n), { n: JSON.stringify(savedNormal), nk: NORMAL });
  await page.reload();
  await page.waitForSelector('#hostScreen:not([hidden]) #queue li', { timeout: 15_000 });
  await pressKey(page, 'e');
  await page.click('.layout-editbar [data-do="resetAll"]');
  check('↺ Reset all: the usual order and sizes, nothing stored', (await scaleOf(page, 'join')) === 1
    && (await left(page, '[data-col="join"]')) < (await left(page, '[data-col="now"]'))
    && (await stored(page, NORMAL)) === null
    && (await page.evaluate(() => !document.querySelector('#hostScreen').style.getPropertyValue('--cols'))));
  await page.click('.layout-editbar [data-do="done"]');
  check('Done ✓: edit mode off', !(await editing(page)));
  // A broken stored value: the usual layout, no error.
  await page.evaluate((nk) => localStorage.setItem(nk, '{"v":1,"order":["x"],"scale":{"join":"huge"},"hidden":["now"]}'), NORMAL);
  await page.reload();
  await page.waitForSelector('#hostScreen:not([hidden]) #queue li', { timeout: 15_000 });
  check('a broken stored layout: repaired (usual order, Now playing shown)', (await scaleOf(page, 'join')) === 1 && await shown(page, '[data-panel="now"]'));
  check('no page errors (host)', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();

  // ==== The board ====
  {
    const bctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, bypassCSP: true });
    const b = await bctx.newPage();
    b.errors = [];
    b.on('pageerror', (e) => b.errors.push(String(e)));
    await b.goto(boardUrl);
    await b.waitForSelector('#boardScreen:not([hidden]) #queue li', { timeout: 15_000 });
    check('board: nothing to drag outside edit mode', !(await shown(b, '.layout-grip')));
    await b.mouse.move(300, 300);
    await b.click('#rMenu');
    await b.waitForSelector('#menuDlg[open]');
    await b.click('#menuLayout');
    check('board: ⋯ → ✏️ Edit layout', await editing(b) && await shown(b, frame('queue')));
    await b.click(`${frame('queue')} [data-do="bigger"]`);
    await b.click(`${frame('queue')} [data-do="bigger"]`);
    await b.click(`${frame('queue')} [data-do="bigger"]`);
    await drag(b, '.layout-gutter[data-pair="join|now"]', -60, 0);
    await b.click(`${frame('join')} [data-do="right"]`);
    await scan(b, 'board in edit mode');
    await b.screenshot({ path: `${SHOTS}board-edit-1366.png` });
    await b.keyboard.press('Escape');
    check('board: Esc leaves edit mode', !(await editing(b)));
    const sb = JSON.parse(await stored(b, 'cq.layout:board'));
    check('board: saved under cq.layout:board', sb?.scale.queue === 1.3 && sb.order.join() === 'now,join,queue', JSON.stringify(sb));
    await b.screenshot({ path: `${SHOTS}board-1366.png` });
    await b.reload();
    await b.waitForSelector('#boardScreen:not([hidden]) #queue li', { timeout: 15_000 });
    check('board: after a reload, the same layout', (await scaleOf(b, 'queue')) === 1.3 && (await left(b, '[data-col="now"]')) < (await left(b, '[data-col="join"]')));
    await pressKey(b, 'e');
    check('board: E enters edit mode', await editing(b));
    await b.click(`${frame('top5')} [data-do="hide"]`).catch(() => {}); // Top 5 only in cleanup
    await b.click(`${frame('join')} [data-do="hide"]`);
    check('board: Join at hidden', !(await shown(b, '[data-col="join"]')));
    await b.click('.layout-chip[data-show="join"]');
    await pressKey(b, 'e');
    check('board: E again leaves edit mode', !(await editing(b)));
    await b.setViewportSize({ width: 1920, height: 1080 });
    await wait(200);
    await b.screenshot({ path: `${SHOTS}board-1920.png` });
    check('board: the host\'s layouts are not the board\'s', (await stored(b, NORMAL)) === null);
    check('no page errors (board)', b.errors.length === 0, b.errors.join(' | '));
    await bctx.close();
  }
} catch (e) {
  failures++;
  console.log(`FAIL crashed: ${e?.stack || e}`);
} finally {
  await browser.close();
  host.send(JSON.stringify({ t: 'close' }));
  await wait(300);
  host.close();
  student.close();
}
console.log(`\nScreenshots: ${SHOTS}`);
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
