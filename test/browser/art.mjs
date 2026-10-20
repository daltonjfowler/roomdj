// Browser test of the album art check (protocol.js ALBUM ART): a host page, a student page and a
// board in installed Chrome (playwright-core), against a LOCAL wrangler dev only.
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:art                  (or: node test/browser/art.mjs http://127.0.0.1:8792/)
// A dev server started with --persist-to <dir>: set CQ_PERSIST=<dir> so the KV seeding reaches it.
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// No Workers AI call: the AI theme check is off for the room, and every cover this test suggests
// has its art verdict seeded into the LOCAL KV first (art:v1:<key>, like the other tests seed song
// verdicts); search results are never checked (cost), so they show blurred or from the cache.
// Seeded keys and the teacher's Show anyway (artok:<key>) are deleted at the end, and Teacher 1's
// saved settings put back. Searches hit the real iTunes API (through the host page).
// Covers: search results (blurred when unchecked; DOM = the server's art), browsing before joining,
// a flagged cover hidden on the student page, the host and the board (no URL, no reason for
// students), the host's "🖼 cover hidden" note + Show anyway, Hide all album covers, the check off.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artKey, artKvKey, artOkName } from '../../shared/art.js';
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

// ---- Local KV (wrangler kv --local; never --remote) -------------------------------------------

const WRANGLER = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));
function localKv(...args) {
  const persist = process.env.CQ_PERSIST ? ['--persist-to', process.env.CQ_PERSIST] : [];
  const r = spawnSync(process.execPath, [WRANGLER, 'kv', ...args, '--binding', 'CLASS_KV', '--local', ...persist],
    { cwd: fileURLToPath(ROOT), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler kv ${args[0]} ${args[1]} --local failed: ${r.stderr.slice(-300)}`);
  return r.stdout;
}
function localKvBulk(action, entries) {
  const file = `${OUT}art-kv-${action}.json`;
  writeFileSync(file, JSON.stringify(entries));
  localKv('bulk', action, file, ...(action === 'delete' ? ['--force'] : []));
}
const localKvGet = (key) => {
  const out = localKv('key', 'get', key, '--text').trim();
  return out.startsWith('Value not found') ? null : out;
};

const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

// ---- Pages -------------------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function openPage(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const p = { name, ctx, page, msgs: [], errors: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    try {
      p.msgs.push(JSON.parse(f.payload));
    } catch {
      // not JSON
    }
  }));
  if (path !== null) await page.goto(new URL(path, BASE).href);
  return p;
}

const lastState = (p) => [...p.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const text = (p, sel) => p.page.locator(sel).textContent();
const shot = (p, label) => p.page.screenshot({ path: `${OUT}art-${label}-${p.name}.png` }).catch(() => {});

async function joinStudent(p, code, nick) {
  await p.page.fill('#code', code);
  await p.page.fill('#nick', nick);
  await p.page.click('#joinBtn');
  await p.page.waitForSelector('#roomScreen:not([hidden])');
}

/** A student search: the server's answer (with art) and the page's rows once drawn. */
async function search(p, q) {
  const answer = p.page.waitForResponse((r) => r.url().includes('/search?'), { timeout: 20_000 });
  await p.page.fill('#q', q);
  await p.page.press('#q', 'Enter');
  const body = await (await answer).json();
  await until(async () => (await p.page.$$('#results li[data-id]')).length === (body.results?.length ?? 0), { timeout: 10_000 });
  return body.results ?? [];
}

/** What a row's cover looks like on a page: 'img' (the cover), 'blur' or 'tile' (🎵). */
function coverKind(p, rowSel) {
  return p.page.evaluate((sel) => {
    const row = document.querySelector(sel);
    const el = row?.querySelector('.art, .now-art');
    if (!el) return null;
    if (el.classList.contains('art-tile')) return 'tile';
    if (el.classList.contains('art-blur')) return 'blur';
    return el.tagName === 'IMG' ? 'img' : 'other';
  }, rowSel);
}
const want = { ok: 'img', unchecked: 'blur', hidden: 'tile' };

async function suggest(p, songId) {
  const n = p.msgs.length;
  await p.page.click(`#results li[data-id="${songId}"] button[data-act="suggest"]`);
  return until(() => p.msgs.slice(n).find((m) => m.t === 'suggested' && m.song === songId), { timeout: 30_000 });
}

async function hostState(host, pred, timeout = 10_000) {
  return until(() => {
    const s = lastState(host);
    return s && pred(s) ? s : null;
  }, { timeout });
}

async function hostSettings(host, { ai, artCheck, hideAllArt }) {
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  if (ai !== undefined) await host.page.setChecked(await reveal(host.page, '#setAi'), ai);
  if (artCheck !== undefined) await host.page.setChecked(await reveal(host.page, '#setArtCheck'), artCheck);
  if (hideAllArt !== undefined) await host.page.setChecked(await reveal(host.page, '#setHideAllArt'), hideAllArt);
  await host.page.click('#applySettings');
}

/** The queue row of a song on a page (by the queue item id that page's own state has). */
const qrow = (p, pick) => `#queue li[data-id="${queueItem(lastState(p), pick.song.id)?.id ?? 'none'}"]`;
const queueItem = (s, songId) => s?.queue.find((q) => q.song.id === songId) ?? (s?.nowPlaying?.song.id === songId ? s.nowPlaying : null);

// ---- The flow ----------------------------------------------------------------------------------

const savedDefaults = await (await api('/api/teacher/settings')).json();
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false, artCheck: true, hideAllArt: false, maxWaitingPerStudent: 10 }) });
const pages = [];
const seeded = [];
try {
  // Browsing before joining: covers from the KV cache only; the page draws what the server said.
  const visitor = await openPage('visitor', '');
  pages.push(visitor);
  {
    const answer = visitor.page.waitForResponse((r) => r.url().endsWith('/api/browse'), { timeout: 20_000 });
    await visitor.page.fill('#bq', 'Here Comes the Sun Beatles');
    const body = await (await answer).json();
    check('browse: the server says which covers may show (one art per song)', Array.isArray(body.art) && body.art.length === body.allowed.length
      && body.art.every((a) => ['ok', 'unchecked', 'hidden'].includes(a)), JSON.stringify(body.art));
    await until(async () => (await visitor.page.$$('#browseResults li[data-id]')).length > 0, { timeout: 10_000 });
    const kinds = await visitor.page.$$eval('#browseResults li[data-id] .song > :first-child', (els) => els.map((el) => (
      el.classList.contains('art-tile') ? 'tile' : el.classList.contains('art-blur') ? 'blur' : el.tagName === 'IMG' ? 'img' : 'other')));
    const allowedArt = body.art.filter((_, i) => body.allowed[i]);
    check('browse: each row draws the server\'s answer (img / blur / 🎵)', kinds.length > 0 && kinds.every((k, i) => k === want[allowedArt[i]]), `${kinds} vs ${allowedArt}`);
    await shot(visitor, 'browse');
  }

  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { classCode: code } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  await hostSettings(host, { ai: false });
  await hostState(host, (s) => !s.settings.aiCheck && s.settings.artCheck && !s.settings.hideAllArt);

  const ava = await openPage('ava', `?code=${code}`);
  pages.push(ava);
  await joinStudent(ava, code, 'Ava');

  // 1. Search results: every song carries the server's art; the page draws it; unchecked = blurred.
  const results = await search(ava, 'Fleetwood Mac');
  check('search: every result has art from the server', results.length > 0 && results.every((r) => ['ok', 'unchecked', 'hidden'].includes(r.art)), JSON.stringify(results.map((r) => r.art)));
  let drawn = true;
  for (const r of results.slice(0, 10)) {
    const kind = await coverKind(ava, `#results li[data-id="${r.id}"]`);
    if (kind !== want[r.art]) drawn = false;
  }
  check('search: each row draws its art state (img / blurred / 🎵)', drawn);
  check('search: covers not checked yet show blurred under a 🎵', !results.some((r) => r.art === 'unchecked')
    || (await ava.page.$$('#results .art-blur')).length > 0);
  await shot(ava, 'search');

  // Three songs with three different covers: one flagged, one fine, one for "check off".
  const picks = [];
  for (const q of ['Fleetwood Mac', 'Here Comes the Sun Beatles', 'Africa Toto', 'Dreams Fleetwood Mac', 'September Earth Wind Fire']) {
    const rows = q === 'Fleetwood Mac' ? results : await search(ava, q);
    for (const r of rows) {
      const key = artKey(r.artwork);
      const free = await ava.page.locator(`#results li[data-id="${r.id}"] button[data-act="suggest"]`).isEnabled().catch(() => false);
      if (key && free && !picks.some((x) => x.key === key)) {
        picks.push({ song: r, key, q });
        break;
      }
    }
    if (picks.length === 3) break;
  }
  if (picks.length < 3) throw new Error('could not find three songs with different covers');
  const [bad, fine, later] = picks;
  // Seed the verdicts (and drop a Show anyway left from an earlier run).
  localKvBulk('delete', picks.map((x) => artOkName(x.key)));
  localKvBulk('put', [
    { key: artKvKey(bad.key), value: JSON.stringify({ verdict: 'inappropriate', reason: 'Partial nudity (art test)', at: Date.now() }) },
    { key: artKvKey(fine.key), value: JSON.stringify({ verdict: 'ok', reason: 'ordinary cover', at: Date.now() }) },
    { key: artKvKey(later.key), value: JSON.stringify({ verdict: 'inappropriate', reason: 'Suggestive pose (art test)', at: Date.now() }) },
  ]);
  seeded.push(...picks.flatMap((x) => [artKvKey(x.key), artOkName(x.key)]));

  // 2. Suggest the flagged one and the fine one: the song is never blocked; only its cover is hidden.
  await search(ava, bad.q);
  const r1 = await suggest(ava, bad.song.id);
  check('a flagged cover never blocks the song', r1?.ok === true, JSON.stringify(r1));
  await search(ava, fine.q);
  const r2 = await suggest(ava, fine.song.id);
  check('a fine cover: the song is in too', r2?.ok === true, JSON.stringify(r2));
  const sH = await hostState(host, (s) => queueItem(s, bad.song.id)?.song.art === 'hidden' && queueItem(s, fine.song.id)?.song.art === 'ok');
  check('host state: flagged = hidden (no URL), fine = ok', Boolean(sH) && queueItem(sH, bad.song.id).song.artwork === '', JSON.stringify(queueItem(lastState(host), bad.song.id)?.song));
  check('host state: the flagged cover carries its key and reason (host only)', queueItem(sH, bad.song.id)?.song.artKey === bad.key
    && queueItem(sH, bad.song.id).song.artReason === 'Partial nudity (art test)');
  const sA = await until(() => {
    const s = lastState(ava);
    return queueItem(s, bad.song.id)?.song.art === 'hidden' && queueItem(s, fine.song.id)?.song.art === 'ok' ? s : null;
  });
  check('student state: the same art, and no artwork URL for the flagged cover', Boolean(sA) && queueItem(sA, bad.song.id).song.artwork === '');
  const studentText = JSON.stringify(ava.msgs);
  check('students never get the reason or the key', !studentText.includes('Partial nudity (art test)') && !studentText.includes('"artKey"'));

  // On the pages: the student's queue, the host's queue (+ note), the board.
  const rowOf = (list, id) => `${list} li[data-id="${id}"]`;
  const avaBad = await until(async () => (await coverKind(ava, qrow(ava, bad))) === 'tile');
  check('student page: the flagged cover is a 🎵 tile', Boolean(avaBad));
  check('student page: the fine cover shows', (await coverKind(ava, qrow(ava, fine))) === 'img');
  const badItem = queueItem(lastState(host), bad.song.id);
  const hostRow = rowOf('#queue', badItem.id);
  check('host page: the flagged cover is a 🎵 tile', Boolean(await until(async () => (await coverKind(host, hostRow)) === 'tile')));
  check('host page: "🖼 cover hidden" with the reason and Show anyway', /🖼 cover hidden: Partial nudity \(art test\)/.test(await text(host, `${hostRow} .art-note`))
    && (await host.page.locator(`${hostRow} [data-art-show]`).isVisible()));
  check('student page: no cover-hidden note', (await ava.page.$$('.art-note')).length === 0);
  await shot(host, 'flagged');
  await shot(ava, 'flagged');

  // The board.
  await host.page.click(await reveal(host.page, '#boardBtn'));
  await host.page.waitForSelector('#boardDlg[open]');
  await host.page.click('#boardNew');
  const boardUrl = await until(async () => (await host.page.inputValue('#boardUrl').catch(() => '')) || null);
  await host.page.click('#boardDlg button[value="done"]');
  const board = await openPage('board', null);
  pages.push(board);
  await board.page.goto(boardUrl);
  const boardBad = await until(async () => (await coverKind(board, qrow(board, bad))) === 'tile', { timeout: 15_000 });
  check('board: the flagged cover is a 🎵 tile', Boolean(boardBad));
  check('board: the fine cover shows', (await coverKind(board, qrow(board, fine))) === 'img');
  check('board: never the reason or the key', !JSON.stringify(board.msgs).includes('Partial nudity (art test)') && !JSON.stringify(board.msgs).includes('"artKey"'));
  await shot(board, 'flagged');

  // 3. Show anyway: this teacher sees it from now on; every page shows it.
  await host.page.click(`${hostRow} [data-art-show]`);
  check('Show anyway: the cover is ok everywhere', Boolean(await hostState(host, (s) => queueItem(s, bad.song.id)?.song.art === 'ok'))
    && Boolean(await until(async () => (await coverKind(ava, qrow(ava, bad))) === 'img'))
    && Boolean(await until(async () => (await coverKind(board, qrow(board, bad))) === 'img')));
  check('Show anyway: saved for this teacher (artok:<key>)', Boolean(localKvGet(artOkName(bad.key))));
  check('Show anyway: the host note is gone', Boolean(await until(async () => (await host.page.$$(`${hostRow} .art-note`)).length === 0)));

  // 4. Hide all album covers: 🎵 everywhere, no notes, search results not blurred.
  await hostSettings(host, { hideAllArt: true });
  await hostState(host, (s) => s.settings.hideAllArt === true);
  const allTiles = async (p) => p.page.$$eval('#queue li .art, #queue li .now-art, #nowPlaying .now-art', (els) => els.length > 0
    && els.every((el) => el.classList.contains('art-tile')));
  check('hide all: student page 🎵 only', Boolean(await until(() => allTiles(ava))));
  check('hide all: host page 🎵 only, no notes', Boolean(await until(() => allTiles(host))) && (await host.page.$$('.art-note')).length === 0);
  check('hide all: board 🎵 only', Boolean(await until(() => allTiles(board))));
  check('hide all: no artwork URL reaches the pages', [lastState(ava), lastState(host)].every((s) => s.queue.every((q) => q.song.artwork === '' && q.song.art === 'hidden')));
  const hidden = await search(ava, 'Africa Toto');
  check('hide all: search results are 🎵 tiles (not blurred)', hidden.every((r) => r.art === 'hidden') && (await ava.page.$$('#results .art-blur, #results img.art')).length === 0);
  await hostSettings(host, { hideAllArt: false });
  await hostState(host, (s) => s.settings.hideAllArt === false);

  // 5. The check off: covers show without a check (the old behaviour), even a flagged one.
  await hostSettings(host, { artCheck: false });
  await hostState(host, (s) => s.settings.artCheck === false);
  await search(ava, later.q);
  const r3 = await suggest(ava, later.song.id);
  check('check off: the song is in', r3?.ok === true, JSON.stringify(r3));
  check('check off: its (flagged) cover shows, like before the check', Boolean(await hostState(host, (s) => queueItem(s, later.song.id)?.song.art === 'ok'))
    && Boolean(await until(async () => (await coverKind(ava, qrow(ava, later))) === 'img')));
  // ... and back on: waiting songs are checked again (here from the cache), so it is hidden now.
  await hostSettings(host, { artCheck: true });
  check('check back on: the waiting song\'s cover is checked and hidden', Boolean(await hostState(host, (s) => queueItem(s, later.song.id)?.song.art === 'hidden', 15_000))
    && Boolean(await until(async () => (await coverKind(ava, qrow(ava, later))) === 'tile')));

  // 6. Save as my default keeps the two switches.
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  await host.page.setChecked(await reveal(host.page, '#setHideAllArt'), true);
  await host.page.click(await reveal(host.page, '#saveDefault'));
  const savedNow = await until(async () => {
    const s = await (await api('/api/teacher/settings')).json();
    return s.hideAllArt === true ? s : null;
  });
  check('Save as my default: hideAllArt and artCheck are saved', savedNow?.hideAllArt === true && savedNow.artCheck === true, JSON.stringify(savedNow));

  for (const p of pages) check(`${p.name}: no page errors`, p.errors.length === 0, p.errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL the flow stopped: ${e.stack ?? e}`);
  for (const p of pages) await shot(p, 'error');
} finally {
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) }).catch(() => {});
  if (seeded.length) {
    try {
      localKvBulk('delete', seeded);
    } catch (e) {
      console.log(`(could not delete the seeded keys: ${e.message})`);
    }
  }
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
