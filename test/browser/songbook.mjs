// Browser test of the songbook and the search filters (CLAUDE.md invariant 40): a shelf sends only
// ✓ Checked songs (the hand-checked Drake songs with no verdict at all, a seeded OK verdict), the API's
// guards, and the student page: the list buttons while the search box is empty, 🔥 Popular when the
// empty search box is tapped, a list's rows, then a
// search with ✓ Checked only, a genre and Newest first. Seeds one verdict in LOCAL KV and deletes it.
// Against a LOCAL wrangler dev only (the teacher key from .dev.vars, never printed).
//   npm run dev, then:  npm run test:songbook   (or: node test/browser/songbook.mjs http://127.0.0.1:8792/)
// For a dev server started with --persist-to <dir>, set CQ_PERSIST=<dir>. Searches hit the real iTunes API.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { banKey, houseOk, verdictKey } from '../../shared/filter.js';
import { shelfSongs } from '../../src/songbook.js';
import { T1, closeOpenRooms } from './teacher-pick.mjs';

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

const WRANGLER = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));
function localKv(...args) {
  const persist = process.env.CQ_PERSIST ? ['--persist-to', process.env.CQ_PERSIST] : [];
  const r = spawnSync(process.execPath, [WRANGLER, 'kv', ...args, '--binding', 'CLASS_KV', '--local', ...persist],
    { cwd: fileURLToPath(ROOT), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler kv ${args[0]} ${args[1]} --local failed: ${r.stderr.slice(-300)}`);
  return r.stdout;
}
function localKvBulk(action, entries) {
  const file = `${OUT}songbook-kv-${action}.json`;
  writeFileSync(file, JSON.stringify(entries));
  localKv('bulk', action, file, ...(action === 'delete' ? ['--force'] : []));
}

async function openRoom() {
  await closeOpenRooms(BASE, KEY); // one room per teacher
  const code = `songbook test ${Math.floor(Math.random() * 1e6)}`;
  const r = await fetch(new URL('api/teacher/rooms', BASE), {
    method: 'POST', headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json' },
    body: JSON.stringify({ code, until: Date.now() + 30 * 60_000 }),
  });
  const room = await r.json();
  if (!r.ok) throw new Error(`could not open a room: ${room.error}`);
  return { ...room, code };
}
const join = (room, device) => fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code: room.code }) });
const shelf = (room, device, id) => fetch(new URL(`api/rooms/${room.room}/songbook?shelf=${id}`, BASE), { headers: { 'x-device': device } });

const pop = shelfSongs('pop').find((s) => !houseOk(s));
const okVerdict = { verdict: 'ok', category: 'other', evidence: '', instrumental: false, lyrics: 'found', lv: 1, source: 'lyrics' };
const seeded = [{ key: verdictKey(banKey(pop)), value: JSON.stringify(okVerdict) }];
const browser = await chromium.launch({ executablePath: CHROME });
try {
  localKvBulk('put', seeded);
  const room = await openRoom();
  const dev = `dev-songbook-${Date.now()}`;

  // ---- The API ----
  check('a device that did not join gets 403', (await shelf(room, dev, 'pop')).status === 403);
  await join(room, dev);
  check('an unknown shelf gets 400', (await shelf(room, dev, 'nope')).status === 400);
  const hip = await (await shelf(room, dev, 'hiphop')).json();
  const titles = (hip.results ?? []).map((s) => s.title);
  check('hip-hop: the hand-checked Hotline Bling and God\'s Plan are listed with no verdict', titles.some((t) => /hotline bling/i.test(t)) && titles.some((t) => /god.s plan/i.test(t)), titles.join(', '));
  check('hip-hop: every song sent is ✓ Checked', hip.results.length > 0 && hip.results.every((s) => s.check === 'ready'));
  check('hip-hop: never an explicit version', hip.results.every((s) => s.explicit !== 'explicit'));
  const popList = await (await shelf(room, dev, 'pop')).json();
  check('pop: the song with a seeded OK verdict is listed', popList.results.some((s) => banKey(s) === banKey(pop)), `${pop.title}; got ${popList.results.map((s) => s.title).join(', ')}`);

  // ---- The page ----
  for (const [w, h] of [[1366, 768], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const pdev = `dev-songbook-p${w}-${Date.now()}`;
    await ctx.addInitScript((d) => localStorage.setItem('cq.device', d), pdev);
    await page.goto(new URL(`?code=${encodeURIComponent(room.code)}`, BASE).href);
    await page.fill('#nick', w > 500 ? 'Calm Otter' : 'Brave Fox');
    await page.click('#joinBtn');
    await page.waitForSelector('#roomScreen:not([hidden])', { timeout: 15_000 });
    await page.waitForSelector('#shelves:not([hidden])', { timeout: 8000 });
    check(`${w}px: the list buttons show while the search box is empty`, (await page.locator('#shelfBtns button').count()) >= 8);
    await page.focus('#q');
    const pop = await page.waitForFunction(() => /Popular on RoomDJ|Nothing is popular/.test(document.querySelector('#searchMsg').textContent), null, { timeout: 10_000 }).then(() => true, () => false);
    check(`${w}px: tapping the empty search box opens 🔥 Popular`, pop && (await page.getAttribute('#shelfBtns button[data-shelf="popular"]', 'aria-pressed')) === 'true');
    await page.click('#shelfBtns button[data-shelf="hiphop"]');
    await page.waitForFunction(() => /checked song/.test(document.querySelector('#searchMsg').textContent), null, { timeout: 10_000 });
    const rows = await page.locator('#results li').count();
    const ready = await page.locator('#results li:has(.ready-tag)').count();
    check(`${w}px: hip-hop list rows, all ✓ Checked`, rows > 0 && ready === rows, `${ready} of ${rows}`);
    check(`${w}px: the open list's button is pressed`, (await page.getAttribute('#shelfBtns button[data-shelf="hiphop"]', 'aria-pressed')) === 'true');
    if (w > 500) await page.screenshot({ path: `${OUT}songbook-shelf.png` });

    await page.fill('#q', 'Drake');
    await page.press('#q', 'Enter');
    await page.waitForFunction(() => /found/.test(document.querySelector('#searchMsg').textContent), null, { timeout: 20_000 });
    check(`${w}px: searching hides the list buttons`, await page.locator('#shelves').isHidden());
    check(`${w}px: the filters show with results`, await page.locator('#searchTools').isVisible());
    const all = await page.locator('#results li').count();
    await page.check('#onlyChecked');
    const onlyRows = await page.locator('#results li').count();
    const onlyReady = await page.locator('#results li:has(.ready-tag)').count();
    check(`${w}px: ✓ Checked only leaves only checked songs`, onlyRows === onlyReady && onlyRows <= all && onlyRows > 0, `${onlyReady}/${onlyRows} of ${all}`);
    await page.uncheck('#onlyChecked');
    const genres = await page.locator('#genre option').allTextContents();
    check(`${w}px: the genre list is the results' own`, genres[0] === 'All genres' && genres.length >= 2, genres.join(', '));
    await page.selectOption('#genre', { index: 1 });
    const inGenre = await page.locator('#results li').count();
    check(`${w}px: a genre narrows the list`, inGenre > 0 && inGenre <= all, `${inGenre} of ${all}`);
    await page.selectOption('#genre', '');
    await page.selectOption('#sortBy', 'newest');
    const order = await page.evaluate(() => [...document.querySelectorAll('#results li')].length);
    check(`${w}px: Newest keeps every result`, order === all);
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('cq.searchView') ?? 'null'));
    check(`${w}px: the sort is kept on this device`, kept?.sort === 'newest', JSON.stringify(kept));
    await page.selectOption('#sortBy', 'popular');
    const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    check(`${w}px: no sideways scrolling`, noScroll);
    if (w < 500) await page.screenshot({ path: `${OUT}songbook-search-phone.png`, fullPage: true });
    check(`${w}px: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  await closeOpenRooms(BASE, KEY);
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack ?? e}`);
} finally {
  await browser.close();
  try { localKvBulk('delete', seeded.map((e) => e.key)); } catch (e) { console.log(`FAIL cleanup: ${e.message}`); }
}
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
