// axe-core accessibility scan of the student, host and board pages, light and dark, plus layout checks at
// phone width (390 px) and 200% zoom (half the CSS pixels): no sideways scrolling, and tap targets
// on the student page at least 44 px. Against a LOCAL wrangler dev only (it opens a room with the
// teacher key from .dev.vars, which it never prints).
//   npm run dev, then:  node test/browser/a11y.mjs [http://127.0.0.1:8792/]
// axe-core and playwright-core: this repo's node_modules if present, else ../uploadmycut's.
// Searches hit the real iTunes API. Screenshots go to test/browser/.out/.

import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T1, pickTeacher, closeOpenRooms } from './teacher-pick.mjs';
import { reveal } from './ui.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = new URL('../../', import.meta.url);
const OUT = fileURLToPath(new URL('./.out/', import.meta.url));
mkdirSync(OUT, { recursive: true });
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
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- A room with songs (API + sockets, no AI) ----
const code = `axe check room ${10 + Math.floor(Math.random() * 89)}`;
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
host.send(JSON.stringify({ t: 'settings', settings: { aiCheck: false, blockUnknownSongs: false, hideVoteCounts: false, maxWaitingPerStudent: 10, cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false } }));
await wait(400);
const DEVICE = 'a11y-test-device-0001';
await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': DEVICE, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
const student = await sock({ role: 'student', device: DEVICE, nick: 'Maya' });
for (const q of ['Happy Pharrell Williams', 'Shake It Off Taylor Swift', 'Roar Katy Perry', 'Firework Katy Perry', 'Here Comes the Sun Beatles']) {
  const r = await fetch(new URL(`api/rooms/${room.room}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': DEVICE } });
  const id = (await r.json()).results?.[0]?.id;
  if (id) student.send(JSON.stringify({ t: 'suggest', song: id }));
  await wait(300);
}
host.send(JSON.stringify({ t: 'next' }));
await wait(500);
const hostSaved = { room: room.room, classCode: room.code, token: room.hostToken, until: room.until };
// The board (protocol.js BOARD + REMOTE): a board link for this room, and the class code for it.
host.send(JSON.stringify({ t: 'boardInfo', code: room.code, display: { size: 'm', who: true, art: true } }));
host.send(JSON.stringify({ t: 'boardLink' }));
await wait(500);
const boardToken = host.msgs.find((m) => m.t === 'boardLink')?.token;
if (!boardToken) throw new Error('no board link');
const boardUrl = new URL(`board/#${room.room}.${boardToken}`, BASE).href;

// ---- Pages ----
const browser = await chromium.launch({ executablePath: CHROME });

async function scan(page, label) {
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
  const detail = r.violations.map((v) => `[${v.impact}] ${v.id} (${v.nodes.length}x): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`).join(' | ');
  check(`axe: ${label}`, r.violations.length === 0, detail);
}

async function noSideScroll(page, label) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`no sideways scrolling: ${label}`, over <= 1, `${over}px too wide`);
}

/** Student page buttons smaller than 44 x 44 px (visible ones). */
async function smallTargets(page, label) {
  const small = await page.$$eval('main button, main input, main a', (els) => els
    .filter((e) => e.offsetParent && e.type !== 'hidden')
    .map((e) => ({ id: e.id || e.className || e.tagName, ...e.getBoundingClientRect().toJSON() }))
    .filter((b) => b.height < 44 || b.width < 44)
    .map((b) => `${b.id} ${Math.round(b.width)}x${Math.round(b.height)}`));
  check(`tap targets at least 44 px: ${label}`, small.length === 0, small.join(', '));
}

async function newPage(viewport, scheme, init) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, bypassCSP: true });
  await ctx.addInitScript(() => { if (!localStorage.getItem('cq.theme')) localStorage.setItem('cq.theme', 'system'); }); // the scheme decides (default is Dark)
  await ctx.addInitScript(() => localStorage.setItem('cq.useKey', '1')); // the teacher key, not Spotify sign-in
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => check('no page errors', false, String(e)));
  return { ctx, page };
}

async function studentInRoom(viewport, scheme) {
  const p = await newPage(viewport, scheme);
  await p.page.goto(new URL(`?code=${encodeURIComponent(room.code)}`, BASE).href);
  await p.page.fill('#nick', 'Ava');
  await p.page.click('#joinBtn');
  await p.page.waitForSelector('#roomScreen:not([hidden]) #queue li');
  await p.page.fill('#q', 'dancing queen');
  await p.page.press('#q', 'Enter');
  await p.page.waitForSelector('#results li', { timeout: 15_000 });
  return p;
}

const hostInit = { fn: (saved) => sessionStorage.setItem('cq.host', JSON.stringify(saved)), arg: hostSaved };
async function hostInRoom(viewport, scheme, big = false) {
  const p = await newPage(viewport, scheme, hostInit);
  await p.page.goto(new URL('host/', BASE).href);
  await p.page.waitForSelector('#queue li');
  if (big) await p.page.click(await reveal(p.page, '#bigBtn'));
  return p;
}

try {
  for (const scheme of ['light', 'dark']) {
    const desk = { width: 1366, height: 768 };
    // Student: join screen with browse results
    {
      const p = await newPage(desk, scheme);
      await p.page.goto(BASE);
      await p.page.fill('#bq', 'happy');
      await p.page.press('#bq', 'Enter');
      await p.page.waitForSelector('#browseResults li', { timeout: 15_000 });
      await scan(p.page, `${scheme}: student join + browse`);
      await p.ctx.close();
    }
    // Student: in the room
    {
      const p = await studentInRoom(desk, scheme);
      await scan(p.page, `${scheme}: student room`);
      await p.page.screenshot({ path: `${OUT}a11y-student-${scheme}.png` });
      await p.ctx.close();
    }
    // Host: start screen
    {
      const p = await newPage(desk, scheme);
      await p.page.goto(new URL('host/', BASE).href);
      await p.page.waitForSelector('#startScreen:not([hidden])');
      await scan(p.page, `${scheme}: host start screen`);
      await p.ctx.close();
    }
    // Host: the room, its dialogs, and big screen
    {
      const p = await hostInRoom(desk, scheme);
      await scan(p.page, `${scheme}: host room`);
      // The toolbar menus and a queue row's ⋯ menu, open (menu.js).
      for (const m of ['#screenMenuBtn', '#roomMenuBtn', '#listsMenuBtn', '#queue li:first-child .menu-btn', '#nowMenuBtn']) {
        await p.page.click(m);
        check(`${scheme}: menu ${m} opens with focus on its first item`, await p.page.evaluate((sel) => {
          const btn = document.querySelector(sel);
          const pop = document.getElementById(btn.getAttribute('aria-controls'));
          return btn.getAttribute('aria-expanded') === 'true' && !pop.hidden && pop.contains(document.activeElement);
        }, m));
        await scan(p.page, `${scheme}: host menu ${m} open`);
        await p.page.keyboard.press('ArrowDown');
        await p.page.keyboard.press('Escape');
        check(`${scheme}: Esc closes ${m} and focus goes back to its button`, await p.page.evaluate((sel) => {
          const btn = document.querySelector(sel);
          return btn.getAttribute('aria-expanded') === 'false' && document.activeElement === btn;
        }, m));
      }
      check(`${scheme}: Esc in a menu does not leave the room view`, await p.page.isVisible('#settingsBtn'));
      await p.page.click('#settingsBtn');
      await scan(p.page, `${scheme}: host settings dialog`);
      // Every Settings tab (tabs.js), moved through with the arrow keys.
      await p.page.click('#tabSongs');
      for (let i = 0; i < 6; i++) {
        const tab = await p.page.evaluate(() => document.activeElement?.id);
        check(`${scheme}: settings tab ${tab} is selected, its panel shows`, await p.page.evaluate((id) => {
          const t = document.getElementById(id);
          return t?.getAttribute('aria-selected') === 'true' && !document.getElementById(t.getAttribute('aria-controls')).hidden;
        }, tab));
        await scan(p.page, `${scheme}: host settings tab ${tab}`);
        await p.page.keyboard.press('ArrowRight');
      }
      // Credits and Priority jump switched on (not applied: Escape cancels).
      await p.page.click(await reveal(p.page, '#setCreditsOn'));
      await p.page.click(await reveal(p.page, '#setJump'));
      check(`${scheme}: settings switches are role=switch and on`, await p.page.evaluate(() => ['#setCreditsOn', '#setJump']
        .every((s) => document.querySelector(s).getAttribute('role') === 'switch' && document.querySelector(s).checked)));
      await scan(p.page, `${scheme}: host settings dialog, credits + priority jump on`);
      await p.page.keyboard.press('Escape');
      await p.page.click(await reveal(p.page, '#studentsBtn'));
      await scan(p.page, `${scheme}: host students dialog`);
      await p.page.keyboard.press('Escape');
      await p.page.click(await reveal(p.page, '#changeCodeBtn'));
      await scan(p.page, `${scheme}: host change code dialog`);
      await p.page.keyboard.press('Escape');
      await p.page.click(await reveal(p.page, '#bigBtn'));
      await scan(p.page, `${scheme}: host big screen`);
      await p.page.click(await reveal(p.page, '#bigBtn'));
      await p.page.click(await reveal(p.page, '#boardBtn'));
      await scan(p.page, `${scheme}: host board link dialog`);
      await p.page.keyboard.press('Escape');
      // 🔎 Suggest a song: the teacher's own search, with results (protocol.js TEACHER PICKS).
      await p.page.click('#suggestBtn');
      await p.page.fill('#tq', 'dancing queen');
      await p.page.press('#tq', 'Enter');
      await p.page.waitForSelector('#tResults li', { timeout: 20_000 });
      await scan(p.page, `${scheme}: host suggest a song dialog`);
      await p.page.keyboard.press('Escape');
      await p.ctx.close();
    }
    // Board: the projector page with its remote, and the page with no link
    {
      const p = await newPage(desk, scheme);
      await p.page.goto(boardUrl);
      await p.page.waitForSelector('#boardScreen:not([hidden]) #queue li');
      await p.page.mouse.move(300, 300); // the remote shows
      await scan(p.page, `${scheme}: board`);
      await p.page.screenshot({ path: `${OUT}a11y-board-${scheme}.png` });
      await p.ctx.close();
      // No link: the board's sign-in (protocol.js BOARD SIGN-IN), then waiting for Teacher 2 (no room open).
      const n = await newPage(desk, scheme);
      await n.page.goto(new URL('board/', BASE).href);
      await n.page.waitForSelector('#signinScreen:not([hidden]) #keyStep:not([hidden])');
      await scan(n.page, `${scheme}: board sign-in, teacher key`);
      await n.page.fill('#key', KEY);
      await n.page.click('#keyNext');
      await n.page.waitForSelector('#whoStep:not([hidden]) #whoList .who-pick');
      await scan(n.page, `${scheme}: board sign-in, who's teaching`);
      await n.page.locator('#whoList .who-pick', { hasText: 'Teacher 2' }).first().click();
      await n.page.waitForSelector('#waitScreen:not([hidden])');
      await scan(n.page, `${scheme}: board waiting for the teacher's room`);
      await n.page.screenshot({ path: `${OUT}a11y-board-waiting-${scheme}.png` });
      await n.ctx.close();
    }
  }

  // Phone width and 200% zoom (a 1366 px screen at 200% is 683 CSS px wide).
  for (const [label, viewport] of [['phone 390', { width: 390, height: 844 }], ['200% zoom', { width: 683, height: 384 }]]) {
    const p = await studentInRoom(viewport, 'light');
    await noSideScroll(p.page, `student room, ${label}`);
    await smallTargets(p.page, `student room, ${label}`);
    await p.page.screenshot({ path: `${OUT}a11y-student-${label.replace(/\W+/g, '')}.png`, fullPage: true });
    await p.ctx.close();
    const j = await newPage(viewport, 'dark');
    await j.page.goto(BASE);
    await noSideScroll(j.page, `student join, ${label}`);
    await smallTargets(j.page, `student join, ${label}`);
    await j.ctx.close();
    const b = await newPage(viewport, 'dark');
    await b.page.goto(boardUrl);
    await b.page.waitForSelector('#boardScreen:not([hidden]) #queue li');
    await b.page.mouse.move(100, 100);
    await noSideScroll(b.page, `board, ${label}`);
    await b.page.screenshot({ path: `${OUT}a11y-board-${label.replace(/\W+/g, '')}.png`, fullPage: true });
    await b.ctx.close();
    const h = await hostInRoom(viewport, 'light');
    await noSideScroll(h.page, `host room, ${label}`);
    await h.page.screenshot({ path: `${OUT}a11y-host-${label.replace(/\W+/g, '')}.png`, fullPage: true });
    await h.ctx.close();
  }

  // Votes: one spoken sentence after a vote settles; a reorder keeps each song's own <li>.
  {
    const p = await studentInRoom({ width: 390, height: 844 }, 'light');
    const last = await p.page.$eval('#queue li:last-child', (li) => { li.__mark = true; return li.dataset.id; });
    await p.page.click(`#queue li[data-id="${last}"] button[data-act="up"]`);
    await wait(300);
    const early = await p.page.textContent('#announce');
    student.send(JSON.stringify({ t: 'vote', id: last, v: 1 })); // another student agrees: it moves up
    await p.page.waitForFunction((id) => document.querySelector('#queue li')?.dataset.id === id, last, { timeout: 5_000 });
    check('votes: a song that moves up keeps its own <li> (no flicker, focus kept)',
      await p.page.$eval(`#queue li[data-id="${last}"]`, (li) => li.__mark === true));
    check('votes: focus stays on the thumbs up after the reorder',
      await p.page.evaluate((id) => document.activeElement?.closest('li')?.dataset.id === id && document.activeElement.dataset.act === 'up', last));
    await wait(1500);
    const said = await p.page.textContent('#announce');
    check('votes: counts are said once things settle, not at once', !/thumbs up, \d/.test(early) && /thumbs up, 2 votes, thumbs down, 0 votes\. Your vote: thumbs up\./.test(said), `${early} | ${said}`);
    await p.ctx.close();
  }

  // Keyboard: Tab order on the student room follows the screen (search before the queue's votes).
  {
    const p = await studentInRoom({ width: 1366, height: 768 }, 'light');
    await p.page.focus('#q');
    const order = [];
    for (let i = 0; i < 60 && !order.includes('up'); i++) {
      await p.page.keyboard.press('Tab');
      order.push(await p.page.evaluate(() => document.activeElement?.dataset.act || document.activeElement?.id || document.activeElement?.tagName));
    }
    const firstUp = order.indexOf('up');
    check('keyboard: Tab from the search goes through the results, then to the queue votes',
      order[0] === 'suggest' && firstUp > 0 && order.slice(0, firstUp).every((x) => x === 'suggest'), [...new Set(order)].join(' > '));
    await p.ctx.close();
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
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
