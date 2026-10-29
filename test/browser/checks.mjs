// Browser test of LRCLIB's limit work (CLAUDE.md invariants 38 and 39): ✓ Checked songs in a room's
// search come first and carry the tag; a song waiting in Needs a look shows on its student's page
// ("Waiting for your teacher to check it", place in line, how long), only for that student. Seeds verdicts in LOCAL KV (no AI call, no LRCLIB call) and deletes them.
// Against a LOCAL wrangler dev only (the teacher key from .dev.vars, never printed; TEST_AI_OFF=on
// so the test can switch the AI check on with seeded verdicts).
//   npm run dev, then:  npm run test:checks   (or: node test/browser/checks.mjs http://127.0.0.1:8792/)
// For a dev server started with --persist-to <dir>, set CQ_PERSIST=<dir>. Searches hit the real iTunes API.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_LYRICS, banKey, verdictKey } from '../../shared/filter.js';
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

// ---- Local KV (wrangler kv --local; never --remote) ----
const WRANGLER = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));
function localKv(...args) {
  const persist = process.env.CQ_PERSIST ? ['--persist-to', process.env.CQ_PERSIST] : [];
  const r = spawnSync(process.execPath, [WRANGLER, 'kv', ...args, '--binding', 'CLASS_KV', '--local', ...persist],
    { cwd: fileURLToPath(ROOT), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler kv ${args[0]} ${args[1]} --local failed: ${r.stderr.slice(-300)}`);
  return r.stdout;
}
function localKvBulk(action, entries) {
  const file = `${OUT}checks-kv-${action}.json`;
  writeFileSync(file, JSON.stringify(entries));
  localKv('bulk', action, file, ...(action === 'delete' ? ['--force'] : []));
}
const localKvGet = (key) => {
  const out = localKv('key', 'get', key, '--text').trim();
  return out.startsWith('Value not found') ? null : out;
};

// ---- A room driven by API + sockets ----
async function openRoom() {
  await closeOpenRooms(BASE, KEY); // one room per teacher
  const code = `checks test ${Math.floor(Math.random() * 1e6)}`;
  const r = await fetch(new URL('api/teacher/rooms', BASE), {
    method: 'POST', headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json' },
    body: JSON.stringify({ code, until: Date.now() + 30 * 60_000 }),
  });
  const room = await r.json();
  if (!r.ok) throw new Error(`could not open a room: ${room.error}`);
  return { ...room, code };
}
const wsBase = BASE.replace(/^http/, 'ws');
const sockets = [];
const sock = (room, params) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${wsBase}api/rooms/${room.room}/ws?${new URLSearchParams(params)}`);
  ws.msgs = [];
  ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
  ws.onopen = () => resolve(ws);
  ws.onerror = reject;
  sockets.push(ws);
});
const lastState = (ws) => [...ws.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const send = (ws, msg) => ws.send(JSON.stringify(msg));
async function studentSock(room, device, nick) {
  await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code: room.code }) });
  return sock(room, { role: 'student', device, nick });
}
async function roomSearch(room, device, q) {
  const r = await fetch(new URL(`api/rooms/${room.room}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': device } });
  return (await r.json()).results ?? [];
}

const seeded = [];
const browser = await chromium.launch({ executablePath: CHROME });
try {
  // A scout room finds songs the room's search shows (the local ban list may hide some); the test
  // room opens after the seeding, so its memory of unchecked songs is fresh.
  const scout = await openRoom();
  const devS = `dev-checks-s-${Date.now()}`;
  await studentSock(scout, devS, 'Quiet Owl');
  const first = (await roomSearch(scout, devS, 'Here Comes the Sun')).filter((x) => x.check !== 'ready');

  const devA = `dev-checks-a-${Date.now()}`;
  const devB = `dev-checks-b-${Date.now()}`;
  check('search finds songs', first.length >= 3, `${first.length} results`);
  const ready = first[first.length - 1];
  const held = first.find((s) => s !== ready && banKey(s) !== banKey(ready));
  const okVerdict = { verdict: 'ok', category: 'other', evidence: '', instrumental: false, lyrics: 'found', lv: 1, source: 'lyrics' };
  const unknownVerdict = { verdict: 'unknown', category: 'other', evidence: '', instrumental: false, ...NO_LYRICS };
  const entries = [
    { key: verdictKey(banKey(ready)), value: JSON.stringify(okVerdict) },
    { key: verdictKey(ready.id), value: JSON.stringify(okVerdict) },
    { key: verdictKey(banKey(held)), value: JSON.stringify(unknownVerdict) },
    { key: verdictKey(held.id), value: JSON.stringify(unknownVerdict) },
  ];
  localKvBulk('put', entries);
  seeded.push(...entries.map((e) => e.key));

  const room = await openRoom(); // closes the scout room (one room per teacher)
  const host = await sock(room, { role: 'host', token: room.hostToken });
  send(host, { t: 'settings', settings: { aiCheck: true, blockUnknownSongs: true, maxWaitingPerStudent: 10, maxSongMinutes: null, cooldownDays: null, backToWork: false, instrumentalsOnly: false } });
  await until(() => lastState(host)?.settings.aiCheck === true);
  const a = await studentSock(room, devA, 'Calm Otter');
  const b = await studentSock(room, devB, 'Brave Fox');

  // ✓ Checked: the room's search puts the seeded song first.
  const again = await roomSearch(room, devB, 'Here Comes the Sun');
  const marked = again.filter((s) => s.check === 'ready');
  if (process.env.CHECKS_DEBUG) console.log(JSON.stringify({ ready: [ready.id, banKey(ready)], held: [held.id, banKey(held)], got: again.map((s) => [s.id, banKey(s), s.check]) }));
  check('✓ Checked: the lyrics-confirmed song is marked ready', marked.some((s) => banKey(s) === banKey(ready)),
    `ready: ${marked.map((s) => s.title).join(', ') || 'none'}`);
  check('✓ Checked: ready songs come first', again.length > 0 && again[0].check === 'ready');
  check('tags: the one LRCLIB had nothing for says Needs teacher OK', again.find((s) => s.id === held.id)?.check === 'teacher');
  check('tags: every other result is tagged', again.every((s) => ['ready', 'teacher', 'unchecked'].includes(s.check)));

  // ⏳ My checks: Calm Otter suggests the song the checker could not settle.
  const n = a.msgs.length;
  send(a, { t: 'suggest', song: held.id });
  const answer = await until(() => a.msgs.slice(n).find((m) => m.t === 'suggested' && m.song === held.id), { timeout: 20_000 });
  check('the unsure song waits for the teacher (reason review)', answer?.reason === 'review', JSON.stringify(answer));
  const mine = await until(() => lastState(a)?.you?.checks?.length ? lastState(a).you.checks : null);
  check('you.checks: Calm Otter sees their own waiting song', mine?.[0]?.title === held.title && mine[0].place === 1 && mine[0].of === 1, JSON.stringify(mine));
  check('you.checks: Brave Fox does not see it', (lastState(b)?.you?.checks ?? []).length === 0 && !JSON.stringify(lastState(b)).includes(held.title));
  // LRCLIB had no lyrics for it (seeded 'none'): the night cannot settle it, so it stays off the night
  // list (src/night.js nightWorthy; the list itself: test/night.test.mjs).
  const night = localKvGet(`lyricsq:v1:look:${banKey(held)}`);
  check('night list: a song LRCLIB has no lyrics for is not on it', night === null, night ?? '');


  // The page: Calm Otter's #myChecks, and the ✓ Checked tag in the page's search.
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.addInitScript((d) => localStorage.setItem('cq.device', d), devA); // the page is Calm Otter's device
  await page.goto(new URL(`?code=${encodeURIComponent(room.code)}`, BASE).href);
  await page.fill('#nick', 'Calm Otter');
  await page.click('#joinBtn');
  await page.waitForSelector('#roomScreen:not([hidden])', { timeout: 15_000 });
  const line = await until(() => page.locator('#myChecks li').first().textContent().catch(() => null), { timeout: 8000 });
  check('page: #myChecks says it waits for the teacher, place and time', /Waiting for your teacher to check it \(next in line\)\. Suggested just now\./.test(line ?? ''), line ?? 'none');
  await page.fill('#q', 'Here Comes the Sun');
  await page.press('#q', 'Enter');
  await page.waitForFunction(() => /found/.test(document.querySelector('#searchMsg').textContent), null, { timeout: 15_000 });
  const firstRow = page.locator('#results li').first();
  check('page: the first result has the ✓ Checked tag', (await firstRow.locator('.ready-tag').count()) === 1);
  const tags = await page.locator('#results li .tag').allTextContents();
  check('page: unchecked songs say Not checked yet', tags.includes('Not checked yet'), tags.join(', '));
  const rows = await page.locator('#results li').count();
  const tagged = await page.locator('#results li:has(.ready-tag), #results li:has(.unchecked-tag)').count();
  check('page: every result row has a check tag', rows > 0 && tagged === rows, `${tagged} of ${rows}`);
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check('page: no sideways scrolling', noScroll);
  await page.screenshot({ path: `${OUT}checks-student.png` });
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // 🧒 Kidz Bop setting: block leaves them out of search, allow tags them ✓ Checked. A made-up Kidz Bop
  // song in the LOCAL search and song caches (src/itunes.js reads them before iTunes), so the result
  // does not depend on how iTunes ranks today; deleted at the end.
  const kidTrack = 990_000_000 + Math.floor(Math.random() * 1_000_000);
  const kidQuery = `checks kidz test ${kidTrack}`;
  const kidSong = {
    id: `it:${kidTrack}`, title: `Checks Test Song ${kidTrack}`, artist: 'KIDZ BOP Kids', album: 'KIDZ BOP Test', artwork: '',
    durationMs: 180_000, explicit: 'notExplicit', previewUrl: 'https://audio-ssl.itunes.apple.com/test.m4a', genre: "Children's Music", year: 2024,
  };
  const kidEntries = [
    { key: `search:${kidQuery}`, value: JSON.stringify([kidSong]) },
    { key: `song:${kidTrack}`, value: JSON.stringify(kidSong) },
  ];
  localKvBulk('put', kidEntries);
  seeded.push(...kidEntries.map((e) => e.key));
  const kidzSearch = async () => (await roomSearch(room, devB, kidQuery)).filter((s) => s.artist === 'KIDZ BOP Kids');
  send(host, { t: 'settings', settings: { kidzBop: 'block' } });
  await until(() => lastState(host)?.settings.kidzBop === 'block');
  check('🧒 Always blocked: no Kidz Bop in search', (await kidzSearch()).length === 0);
  send(host, { t: 'settings', settings: { kidzBop: 'allow' } });
  await until(() => lastState(host)?.settings.kidzBop === 'allow');
  const kidz = await kidzSearch();
  check('🧒 Always allowed: Kidz Bop songs show as ✓ Checked', kidz.length === 1 && kidz[0].check === 'ready', JSON.stringify(kidz));
  const kn = a.msgs.length;
  send(a, { t: 'suggest', song: kidz[0]?.id });
  const kidAnswer = await until(() => a.msgs.slice(kn).find((m) => m.t === 'suggested' && m.song === kidz[0]?.id), { timeout: 20_000 });
  check('🧒 Always allowed: a Kidz Bop suggestion joins the queue at once', kidAnswer?.ok === true, JSON.stringify(kidAnswer));

  // The teacher removes it (Needs a look's Remove): it goes on the night list for everyone.
  const reviewItem = await until(() => lastState(host)?.review?.find((i) => i.song.id === held.id));
  send(host, { t: 'veto', id: reviewItem?.id });
  await until(() => !(lastState(host)?.review ?? []).some((i) => i.song.id === held.id));
  const tKey = `lyricsq:v1:t:${banKey(held)}`;
  const rejected = await until(() => localKvGet(tKey), { timeout: 5000, every: 500 });
  if (rejected) seeded.push(tKey);
  check('night list: a song the teacher removed goes on it, song details only', Boolean(rejected) && JSON.parse(rejected)[0]?.id === held.id && !rejected.includes('Calm Otter'), rejected ?? 'missing');

  send(host, { t: 'close' });
  await wait(300);
} catch (e) {
  failures++;
  console.log(`FAIL crashed: ${e?.stack ?? e}`);
} finally {
  for (const ws of sockets) try { ws.close(); } catch { /* closed */ }
  if (seeded.length) localKvBulk('delete', seeded);
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
