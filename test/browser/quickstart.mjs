// Quick start on the open-room form (Dalton, 2026-10-20): "Song suggestions" ♾️ Unlimited or 🎟 Credits
// (each student starts with N), prefilled from the teacher's saved settings, used by the new room,
// and kept as the teacher's default. Against a LOCAL wrangler dev only:
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   node test/browser/quickstart.mjs http://127.0.0.1:8792/
// Reads TEACHER_KEY from .dev.vars and never prints it. Puts Teacher 1's saved settings back.
// Screenshots of the form (390 px light, 1366 px dark) go to test/browser/.out/quickstart-*.png.

import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T1, closeOpenRooms, pickTeacher } from './teacher-pick.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = new URL('../../', import.meta.url);
const OUT = fileURLToPath(new URL('./.out/', import.meta.url));
mkdirSync(OUT, { recursive: true });
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: runs only against a local dev server (not ${BASE})`);
  process.exit(1);
}
async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    return import(pathToFileURL(process.env.PLAYWRIGHT_CORE || fileURLToPath(new URL('../uploadmycut/node_modules/playwright-core/index.mjs', ROOT))).href);
  }
}
const { chromium } = await loadPlaywright();
const KEY = (() => {
  const line = readFileSync(new URL('.dev.vars', ROOT), 'utf8').split(/\r?\n/).find((l) => l.startsWith('TEACHER_KEY='));
  if (!line) throw new Error('TEACHER_KEY is not in .dev.vars');
  return line.slice('TEACHER_KEY='.length).trim().replace(/^"(.*)"$/, '$1');
})();

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
  return ok;
}
const headers = { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json' };
const getSettings = async () => (await fetch(new URL('/api/teacher/settings', BASE), { headers })).json();
const putSettings = (s) => fetch(new URL('/api/teacher/settings', BASE), { method: 'PUT', headers, body: JSON.stringify(s) });

/** The room's own settings, read over a raw host socket with the page's host token. */
async function roomSettings(page) {
  const host = await page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const url = new URL(`/api/rooms/${host.room}/ws?role=host&token=${encodeURIComponent(host.token)}`, BASE);
  url.protocol = 'ws:';
  const ws = new WebSocket(url);
  const state = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no state')), 10_000);
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'state') { clearTimeout(t); resolve(m.state); }
    });
  });
  return { settings: state.settings, close: () => { ws.send(JSON.stringify({ t: 'close' })); setTimeout(() => ws.close(), 300); } };
}

const saved = await getSettings();
const browser = await chromium.launch({ executablePath: CHROME });
async function startScreen(theme = 'light', viewport = { width: 1366, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((t) => { localStorage.setItem('cq.useKey', '1'); localStorage.setItem('cq.theme', t); }, theme);
  const page = await context.newPage();
  await page.goto(new URL('/host/', BASE).href);
  await pickTeacher(page, KEY);
  await page.waitForFunction(() => document.querySelector('input[name="openCredits"]:checked'));
  await page.waitForTimeout(500); // the saved setting arrives
  return { context, page };
}
const picked = (page) => page.evaluate(() => ({
  pick: document.querySelector('input[name="openCredits"]:checked')?.value,
  n: document.querySelector('#openCreditsN').value,
  row: !document.querySelector('#openCreditsRow').hidden,
}));

try {
  await closeOpenRooms(BASE, KEY);
  await putSettings({ ...saved, startingCredits: null });

  // 1. Saved: unlimited → Unlimited is picked, no credits row. Pick Credits 3 and open.
  let { context, page } = await startScreen('light', { width: 390, height: 1000 });
  let p = await picked(page);
  check('saved unlimited: ♾️ Unlimited picked, no credits row', p.pick === 'unlimited' && !p.row, JSON.stringify(p));
  await page.check('input[name="openCredits"][value="credits"]');
  p = await picked(page);
  check('🎟 Credits shows "Each student starts with"', p.row);
  await page.fill('#openCreditsN', '3');
  await page.screenshot({ path: `${OUT}quickstart-phone-light.png`, fullPage: true });
  check('no sideways scroll at 390 px', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  await page.click('#openBtn');
  await page.locator('#hostScreen').waitFor({ state: 'visible', timeout: 15_000 });
  let room = await roomSettings(page);
  check('the room opens with 3 starting credits', room.settings.startingCredits === 3, JSON.stringify(room.settings.startingCredits));
  check('kept as the teacher default', (await getSettings()).startingCredits === 3);
  room.close();
  await context.close();
  await closeOpenRooms(BASE, KEY);

  // 2. Next time: Credits 3 is prefilled. Pick Unlimited and open.
  ({ context, page } = await startScreen('dark'));
  p = await picked(page);
  check('next time: 🎟 Credits 3 prefilled', p.pick === 'credits' && p.n === '3' && p.row, JSON.stringify(p));
  await page.screenshot({ path: `${OUT}quickstart-desktop-dark.png`, fullPage: true });
  await page.fill('#openCreditsN', '99');
  await page.click('#openBtn');
  await page.waitForTimeout(500);
  check('99 credits: refused on the page, no room', /whole number from 0 to 50/.test(await page.textContent('#keyMsg')) && !(await page.locator('#hostScreen').isVisible()));
  await page.check('input[name="openCredits"][value="unlimited"]');
  await page.click('#openBtn');
  await page.locator('#hostScreen').waitFor({ state: 'visible', timeout: 15_000 });
  room = await roomSettings(page);
  check('the room opens unlimited (credits off)', room.settings.startingCredits === null);
  check('unlimited kept as the default', (await getSettings()).startingCredits === null);
  const others = await getSettings();
  check('nothing else in the saved settings changed', JSON.stringify({ ...others, startingCredits: 0 }) === JSON.stringify({ ...saved, startingCredits: 0 }));
  room.close();
  await context.close();

  // 3. The server refuses a bad value from a page that skips the form's check.
  const bad = await fetch(new URL('/api/teacher/rooms', BASE), { method: 'POST', headers, body: JSON.stringify({ code: `qs ${Date.now() % 1e6}`, until: Date.now() + 3600e3, profile: T1, startingCredits: 500 }) });
  check('server: 500 starting credits refused (400)', bad.status === 400, `HTTP ${bad.status}`);
} finally {
  await closeOpenRooms(BASE, KEY);
  await putSettings(saved);
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
