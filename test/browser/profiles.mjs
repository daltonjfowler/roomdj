// Browser test of teacher profiles ("Who's teaching?", protocol.js TEACHER PROFILES) in installed
// Chrome (playwright-core), against a LOCAL wrangler dev only:
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:profiles             (or: node test/browser/profiles.mjs http://127.0.0.1:8792/)
// It backs up the LOCAL KV keys profiles, settings, banned and favorites, deletes `profiles` (so
// the first use runs), seeds the plain keys (Teacher 1's, the legacy profile), and puts every
// one back at the end; the p:<profile>:* keys it made are deleted. Checks: the first use makes
// Teacher 1 (legacy) + Teacher 2 and a second call makes nothing new; Teacher 1 sees the old
// settings, bans and favorites, Teacher 2 starts fresh; settings, bans, approvals and favorites stay
// with their teacher; the picked teacher is remembered on this computer; add, rename, hide and
// show a teacher; the student page says "<name>'s class". AI calls: none (aiCheck off, or a seeded
// UNKNOWN verdict). Searches hit the real iTunes API through the host page.
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_LYRICS, approvedKey, verdictKey } from '../../shared/filter.js';
import { DEFAULT_SETTINGS } from '../../shared/protocol.js';
import { T2, T1, pickTeacher, startStep } from './teacher-pick.mjs';

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
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Local KV (wrangler kv --local; never --remote) -------------------------------------------
const WRANGLER = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));
function localKv(...args) {
  const persist = process.env.CQ_PERSIST ? ['--persist-to', process.env.CQ_PERSIST] : [];
  return spawnSync(process.execPath, [WRANGLER, 'kv', ...args, '--binding', 'CLASS_KV', '--local', ...persist],
    { cwd: fileURLToPath(ROOT), encoding: 'utf8' });
}
function kvGet(key) {
  const r = localKv('key', 'get', key, '--text');
  if (r.status !== 0 || /Value not found/i.test(r.stdout + r.stderr)) return null;
  return r.stdout.trim() || null;
}
function kvPutMany(entries) {
  const file = `${OUT}profiles-kv.json`;
  writeFileSync(file, JSON.stringify(entries));
  const r = localKv('bulk', 'put', file);
  if (r.status !== 0) throw new Error(`wrangler kv bulk put --local failed: ${r.stderr.slice(-300)}`);
}
const kvPut = (key, value) => kvPutMany([{ key, value }]);
function kvDelete(keys) {
  if (!keys.length) return;
  const file = `${OUT}profiles-kv-del.json`;
  writeFileSync(file, JSON.stringify(keys));
  localKv('bulk', 'delete', file, '--force');
}
function kvList(prefix) {
  const r = localKv('key', 'list', '--prefix', prefix);
  try { return JSON.parse(r.stdout).map((k) => k.name); } catch { return []; }
}

const api = (path, init = {}, profile = T1) => fetch(new URL(path, BASE), {
  ...init, headers: { 'x-teacher-key': KEY, ...(profile ? { 'x-teacher-profile': profile } : {}), 'content-type': 'application/json', ...init.headers },
});
const getJson = async (path, profile) => (await api(path, {}, profile)).json();

// ---- Pages and sockets ---------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const pages = [];
const raws = [];

async function openPage(name, path, ctx = null) {
  const context = ctx ?? await browser.newContext({ viewport: { width: 1366, height: 768 } });
  if (!ctx) await context.addInitScript(() => localStorage.setItem('cq.useKey', '1')); // the teacher key, not Spotify sign-in
  const page = await context.newPage();
  const p = { name, ctx: context, page, msgs: [], errors: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|NotSupportedError|play\(\)/.test(m.text())) p.errors.push(m.text()); });
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    try { p.msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ }
  }));
  await page.goto(new URL(path, BASE).href);
  pages.push(p);
  return p;
}
const text = (p, sel) => p.page.locator(sel).textContent();
const visible = (p, sel) => p.page.locator(sel).isVisible();
const lastState = (p) => p.msgs.findLast((m) => m.t === 'state')?.state ?? null;

async function rawSocket(roomId, params) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}api/rooms/${roomId}/ws?${new URLSearchParams(params)}`);
  const s = { ws, msgs: [] };
  ws.addEventListener('message', (e) => { try { s.msgs.push(JSON.parse(e.data)); } catch { /* not JSON */ } });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  s.ask = async (msg, pred, timeout = 15_000) => {
    const n = s.msgs.length;
    ws.send(JSON.stringify(msg));
    return until(async () => s.msgs.slice(n).find(pred), { timeout });
  };
  s.send = (msg) => ws.send(JSON.stringify(msg));
  s.state = () => s.msgs.findLast((m) => m.t === 'state')?.state ?? null;
  raws.push(s);
  return s;
}
async function apiJoin(code, device) {
  const r = await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  return r.status;
}
let searches = 0;
const PROBES = ['proftest-device-probe01', 'proftest-device-probe02', 'proftest-device-probe03'];
async function findSong(roomId, q) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    const r = await fetch(new URL(`api/rooms/${roomId}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': PROBES[searches++ % 3] } });
    const data = await r.json();
    const song = data.results?.[0];
    if (song) return song;
    last = `${r.status} ${JSON.stringify(data).slice(0, 300)}`;
    await wait(2000);
  }
  throw new Error(`no search result for ${q}: ${last}`);
}

/** Open a room on the host page as the teacher shown there; → { roomId, code, token }. */
async function openRoom(host) {
  const msgsBefore = host.msgs.length;
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 30_000 });
  await until(async () => host.msgs.slice(msgsBefore).some((m) => m.t === 'state'), { timeout: 15_000 });
  const saved = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  for (const d of PROBES) await apiJoin(saved.classCode, d);
  return { roomId: saved.room, code: saved.classCode, token: saved.token };
}
async function closeRoom(host, hostWs) {
  hostWs.send({ t: 'close' });
  return until(() => visible(host, '#closedScreen'), { timeout: 15_000 });
}
const suggest = (stu, song) => stu.ask({ t: 'suggest', song: song.id }, (m) => m.t === 'suggested' && m.song === song.id, 30_000);

// ---- The test ----------------------------------------------------------------------------------
const BACKUP = ['profiles', 'settings', 'banned', 'favorites', 'recent']; // recent: the repeat cooldown record
const saved = Object.fromEntries(BACKUP.map((k) => [k, kvGet(k)]));
const extraKeys = new Set(); // seeded or made here: deleted at the end
const before = {}; // plain approved:* values before the test (they must not change)
const stamp = Date.now() % 100000;
let addedId = null; // the teacher added in part 5

try {
  // ---- 1. First use: the migration, and Teacher 1's old data ----
  kvDelete(['profiles']);
  const fakeFav = { id: 'it:999000777', title: 'Old Favorite Tune', artist: 'Test Artist', album: 'Test', artwork: '', durationMs: 180_000, explicit: 'notExplicit', previewUrl: '' };
  const now = Date.now();
  const oldBans = JSON.parse(saved.banned ?? '[]');
  kvPutMany([
    { key: 'settings', value: JSON.stringify({ ...DEFAULT_SETTINGS, cooldownDays: null, backToWork: false, aiCheck: false, blocklist: ['oneword'], maxWaitingPerStudent: 4, bellSchedule: [{ name: 'T1 P9', ends: '23:59' }] }) },
    { key: 'favorites', value: JSON.stringify({ v: 1, list: [{ song: fakeFav, top5: 1, net: 5, plays: 1, pinned: false, firstAt: now, lastAt: now }] }) },
    { key: 'banned', value: JSON.stringify([...oldBans, { id: 'it:999000555', title: 'Old Banned Song', artist: 'Test Artist', at: now }]) },
  ]);

  const first = await getJson('api/teacher/profiles', null);
  check('first use: Teacher 1 (legacy) and Teacher 2', JSON.stringify(first.profiles?.map((p) => [p.id, p.name, p.legacy === true]))
    === JSON.stringify([[T1, 'Teacher 1', true], [T2, 'Teacher 2', false]]), JSON.stringify(first));
  const kvAfterFirst = kvGet('profiles');
  const second = await getJson('api/teacher/profiles', null);
  check('a second call makes nothing new (same list in KV)', JSON.stringify(second.profiles) === JSON.stringify(first.profiles) && kvGet('profiles') === kvAfterFirst, `${kvAfterFirst} | ${kvGet('profiles')}`);
  check('the wrong key: refused', (await fetch(new URL('api/teacher/profiles', BASE), { headers: { 'x-teacher-key': 'nope' } })).status === 401);

  const t1Set = await getJson('api/teacher/settings', T1);
  check('Teacher 1 sees the old settings (the plain key)', t1Set.blocklist?.includes('oneword') && t1Set.maxWaitingPerStudent === 4 && t1Set.bellSchedule?.[0]?.name === 'T1 P9', JSON.stringify(t1Set));
  const t2Set = await getJson('api/teacher/settings', T2);
  check('Teacher 2 starts with the default settings', JSON.stringify(t2Set) === JSON.stringify({ ...DEFAULT_SETTINGS, blocklist: [] }), JSON.stringify(t2Set));
  check('settings need a teacher (no profile: 400 profile)', (await (await api('api/teacher/settings', {}, null)).json()).error === 'profile');
  check('an unknown teacher: 400 profile', (await (await api('api/teacher/settings', {}, 'nobody')).json()).error === 'profile');
  const put = await api('api/teacher/settings', { method: 'PUT', body: JSON.stringify({ maxWaitingPerStudent: 7, aiCheck: false, blocklist: ['twoword'], cooldownDays: null, backToWork: false }) }, T2);
  check('Teacher 2 saves his own defaults', put.status === 200);
  extraKeys.add(`p:${T2}:settings`);
  const t1Again = await getJson('api/teacher/settings', T1);
  check('settings saved by Teacher 2 do not appear in Teacher 1\'s', t1Again.maxWaitingPerStudent === 4 && !t1Again.blocklist.includes('twoword')
    && !kvGet('settings').includes('twoword') && kvGet(`p:${T2}:settings`)?.includes('twoword'));
  const noProfileRoom = await api('api/teacher/rooms', { method: 'POST', body: JSON.stringify({ code: `no profile ${stamp}`, until: Date.now() + 3_600_000 }) }, null);
  check('opening a room without a teacher: 400 profile', noProfileRoom.status === 400 && (await noProfileRoom.json()).error === 'profile');

  // ---- 2. Teacher 1's room (the host page: key, Who's teaching?, open) ----
  const host = await openPage('host', 'host/');
  await until(async () => (await startStep(host.page)) === 'key');
  await host.page.fill('#key', KEY);
  await host.page.click('#keyNext');
  const who = await until(async () => {
    const names = await host.page.$$eval('#whoList .who-pick', (b) => b.map((x) => x.textContent.trim()));
    return names.length ? names : null;
  });
  check('after the key: "Who\'s teaching?" with both teachers', JSON.stringify(who) === JSON.stringify(['Teacher 1', 'Teacher 2']), JSON.stringify(who));
  check('... and "＋ Add teacher"', await visible(host, '#addTeacherBtn'));
  await pickTeacher(host.page, KEY, 'Teacher 1');
  check('picked: the open-room form says "Teaching as Teacher 1"', (await text(host, '#teachingAs')).includes('Teaching as Teacher 1') && await visible(host, '#switchTeacher'));
  check('Teacher 1\'s bell schedule on the form', Boolean(await until(async () => (await text(host, '#openBells')).includes('T1 P9'))));
  const t1 = await openRoom(host);
  const jState = lastState(host);
  check('Teacher 1\'s room: his teacher name and settings', jState?.teacher === 'Teacher 1' && jState.profile === T1 && jState.settings.blocklist.includes('oneword') && jState.settings.maxWaitingPerStudent === 4, JSON.stringify(jState?.settings));
  check('the host header says "Teaching as Teacher 1"', (await visible(host, '#teacherPill')) && (await text(host, '#teacherPill')).includes('Teacher 1'));
  const t1Host = await rawSocket(t1.roomId, { role: 'host', token: t1.token });
  const jFav = await t1Host.ask({ t: 'favorites' }, (m) => m.t === 'favoritesAll');
  check('Teacher 1 sees the old favorites', jFav?.list?.some((e) => e.song.id === fakeFav.id), JSON.stringify(jFav?.list?.map((e) => e.song.title)));

  const kid = await openPage('student', `?code=${encodeURIComponent(t1.code)}`);
  await kid.page.fill('#code', t1.code);
  await kid.page.fill('#nick', 'Robin');
  await kid.page.click('#joinBtn');
  check('student page: "Teacher 1\'s class"', Boolean(await until(async () => (await visible(kid, '#classOf')) && (await text(kid, '#classOf')) === "Teacher 1's class")),
    await text(kid, '#classOf'));
  const kidText = await kid.page.locator('#main').innerText(); // (the footer's "Made by Dalton Fowler" is the site credit)
  check('... and never another teacher\'s name', !kidText.includes('Teacher 2'), kidText.slice(Math.max(0, kidText.indexOf('Teacher 2') - 200), kidText.indexOf('Teacher 2') + 60));

  const songA = await findSong(t1.roomId, 'Happy Pharrell Williams');
  const songB = await findSong(t1.roomId, 'Shake It Off Taylor Swift');
  for (const s of [songA, songB]) before[s.id] = kvGet(approvedKey(s.id));
  await apiJoin(t1.code, 'proftest-device-pat-0001');
  const pat = await rawSocket(t1.roomId, { role: 'student', device: 'proftest-device-pat-0001', nick: 'Pat' });
  const a1 = await suggest(pat, songA);
  check('Teacher 1\'s room: a song goes in', a1?.ok === true, JSON.stringify(a1));
  const item = await until(async () => t1Host.state()?.queue.find((q) => q.song.id === songA.id));
  t1Host.send({ t: 'ban', id: item.id });
  check('Teacher 1 bans it: in the plain ban list (his)', Boolean(await until(async () => kvGet('banned')?.includes(songA.id), { timeout: 15_000 })));
  check('... not in Teacher 2\'s', !kvGet(`p:${T2}:banned`)?.includes(songA.id));
  const a2 = await suggest(pat, songA);
  check('... and it is refused as banned in Teacher 1\'s room', a2?.ok === false && a2.reason === 'banned', JSON.stringify(a2));
  check('Teacher 1\'s room closes', Boolean(await closeRoom(host, t1Host)));

  // ---- 3. Switch to Teacher 2 (the page reloads with his preferences) ----
  await host.page.click('#newRoomBtn');
  await pickTeacher(host.page, KEY, 'Teacher 2');
  check('switched: "Teaching as Teacher 2", remembered on this computer', (await text(host, '#teachingName')) === 'Teacher 2'
    && (await host.page.evaluate(() => JSON.parse(localStorage.getItem('cq.profile'))?.id)) === T2);
  check('Teacher 2\'s form has no bells of Teacher 1\'s', !(await text(host, '#openBells')).includes('T1 P9'));
  host.msgs.length = 0;
  const t2 = await openRoom(host);
  const dState = lastState(host);
  check('Teacher 2\'s room: his own settings (not Teacher 1\'s)', dState?.teacher === 'Teacher 2' && dState.profile === T2
    && dState.settings.maxWaitingPerStudent === 7 && dState.settings.blocklist.join() === 'twoword', JSON.stringify(dState?.settings));
  const dHost = await rawSocket(t2.roomId, { role: 'host', token: t2.token });
  const dFav = await dHost.ask({ t: 'favorites' }, (m) => m.t === 'favoritesAll');
  check('Teacher 2\'s favorites are his own (empty, not Teacher 1\'s)', Array.isArray(dFav?.list) && !dFav.list.some((e) => e.song.id === fakeFav.id), JSON.stringify(dFav?.list?.map((e) => e.song.title)));
  await apiJoin(t2.code, 'proftest-device-sam-0001');
  const sam = await rawSocket(t2.roomId, { role: 'student', device: 'proftest-device-sam-0001', nick: 'Sam' });
  const d1 = await suggest(sam, songA);
  check('the song Teacher 1 banned is fine in Teacher 2\'s room', d1?.ok === true, JSON.stringify(d1));
  // Approvals: an UNKNOWN verdict (no AI call) puts song B in Needs a look; Teacher 2 allows it.
  kvPut(verdictKey(songB.id), JSON.stringify({ verdict: 'unknown', reason: 'profiles test', ...NO_LYRICS }));
  extraKeys.add(verdictKey(songB.id));
  await dHost.ask({ t: 'settings', settings: { aiCheck: true, blockUnknownSongs: true } }, (m) => m.t === 'state' && m.state.settings.aiCheck);
  const d2 = await suggest(sam, songB);
  check('Teacher 2\'s room: an unknown song waits for a look', d2?.reason === 'review', JSON.stringify(d2));
  const review = await until(async () => dHost.state()?.review?.find((q) => q.song.id === songB.id));
  dHost.send({ t: 'allow', id: review.id });
  check('Teacher 2 allows it: his approval (p:teacher-2:approved:*)', Boolean(await until(async () => kvGet(`p:${T2}:${approvedKey(songB.id)}`), { timeout: 15_000 })));
  for (const k of kvList(`p:${T2}:approved:`)) extraKeys.add(k);
  check('... the plain (Teacher 1\'s) approval is unchanged', kvGet(approvedKey(songB.id)) === before[songB.id]);
  check('Teacher 2\'s room closes', Boolean(await closeRoom(host, dHost)));

  // ---- 4. Remembered on this computer; back to Teacher 1: approvals are his own ----
  const again = await openPage('host2', 'host/', host.ctx);
  await until(async () => (await startStep(again.page)) === 'key');
  await again.page.fill('#key', KEY);
  await again.page.click('#keyNext');
  const step = await until(async () => {
    const s = await startStep(again.page);
    return s === 'open' || s === 'who' ? s : null;
  });
  check('a new tab on this computer: straight to "Teaching as Teacher 2" (no picking)', step === 'open' && (await text(again, '#teachingName')) === 'Teacher 2', step);
  await again.page.close();
  pages.splice(pages.indexOf(again), 1);
  await host.page.click('#newRoomBtn');
  await pickTeacher(host.page, KEY, 'Teacher 1');
  host.msgs.length = 0;
  const t12 = await openRoom(host);
  const j2Host = await rawSocket(t12.roomId, { role: 'host', token: t12.token });
  await apiJoin(t12.code, 'proftest-device-lee-0001');
  const lee = await rawSocket(t12.roomId, { role: 'student', device: 'proftest-device-lee-0001', nick: 'Lee' });
  await j2Host.ask({ t: 'settings', settings: { aiCheck: true, blockUnknownSongs: true } }, (m) => m.t === 'state' && m.state.settings.aiCheck);
  const j1 = await suggest(lee, songB);
  check('Teacher 2\'s approval does not count in Teacher 1\'s room (still Needs a look)', j1?.reason === 'review', JSON.stringify(j1));
  const j2 = await suggest(lee, songA);
  check('Teacher 1\'s ban still holds in his room', j2?.ok === false && j2.reason === 'banned', JSON.stringify(j2));
  check('Teacher 1\'s second room closes', Boolean(await closeRoom(host, j2Host)));

  // ---- 5. Add, rename, hide and show a teacher ----
  await host.page.click('#newRoomBtn');
  await until(() => visible(host, '#switchTeacher'));
  await host.page.click('#switchTeacher');
  await until(() => visible(host, '#addTeacherBtn'));
  await host.page.click('#addTeacherBtn');
  await host.page.fill('#teacherName', 'Big Shit');
  await host.page.click('#teacherSave');
  check('add: a name students must not see is refused', /Students may see this name/.test(await text(host, '#teacherMsg')));
  const name = `Pat Test ${stamp}`;
  await host.page.fill('#teacherName', name);
  await host.page.click('#teacherSave');
  check('add: the new teacher is on the list', Boolean(await until(async () => (await host.page.$$eval('#whoList .who-pick', (b) => b.map((x) => x.textContent.trim()))).includes(name))));
  const added = (await getJson('api/teacher/profiles', null)).profiles.find((p) => p.name === name);
  addedId = added?.id ?? null;
  check('... and in KV, fresh settings', Boolean(added) && JSON.stringify(await getJson('api/teacher/settings', added?.id)) === JSON.stringify({ ...DEFAULT_SETTINGS, blocklist: [] }));
  await host.page.click('#addTeacherBtn');
  await host.page.fill('#teacherName', 'teacher 1');
  await host.page.click('#teacherSave');
  check('add: the same name twice is refused', /already/.test(await until(async () => (await text(host, '#teacherMsg')) || null) ?? ''));
  await host.page.click('#teacherCancel');
  await host.page.click(`#whoList [data-id="${added.id}"] button[data-act="rename"]`);
  await host.page.fill('#teacherName', `${name} B`);
  await host.page.click('#teacherSave');
  check('rename: the list shows the new name (same id)', Boolean(await until(async () => (await text(host, `#whoList [data-id="${added.id}"] .who-pick`)).trim() === `${name} B`)));
  await host.page.click(`#whoList [data-id="${added.id}"] button[data-act="hide"]`);
  await host.page.waitForSelector('#confirm[open]');
  check('hide asks first and says nothing is deleted', /Nothing is deleted/.test(await text(host, '#confirm')));
  await host.page.click('#confirm button[value="ok"]');
  check('hidden: under Hidden teachers, off the list', Boolean(await until(async () => (await visible(host, '#whoHidden'))
    && !(await host.page.locator(`#whoList [data-id="${added.id}"]`).count()))));
  const hiddenRoom = await api('api/teacher/rooms', { method: 'POST', body: JSON.stringify({ code: `hidden ${stamp}`, until: Date.now() + 3_600_000 }) }, added.id);
  check('a hidden teacher cannot open a room', hiddenRoom.status === 400);
  await host.page.click('#whoHidden summary');
  await host.page.click(`#whoHiddenList [data-id="${added.id}"] button[data-act="show"]`);
  check('show again: back on the list', Boolean(await until(async () => (await host.page.locator(`#whoList [data-id="${added.id}"]`).count()) === 1)));

  for (const p of pages) check(`no page errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL profiles stopped: ${e?.stack ?? e}`);
  for (const p of pages) await p.page.screenshot({ path: `${OUT}profiles-crash-${p.name}.png` }).catch(() => {});
} finally {
  for (const s of raws) try { s.ws.close(); } catch { /* closed */ }
  await browser.close();
  try {
    // Every key this test made: Teacher 2's and the added teacher's p:<profile>:* keys, the seeded verdict; then the backups back.
    const made = [...new Set([...extraKeys, ...kvList(`p:${T2}:`), ...(addedId ? kvList(`p:${addedId}:`) : [])])];
    kvDelete(made);
    const back = BACKUP.filter((k) => saved[k] !== null).map((k) => ({ key: k, value: saved[k] }));
    if (back.length) kvPutMany(back);
    kvDelete(BACKUP.filter((k) => saved[k] === null));
  } catch (e) {
    failures++;
    console.log(`FAIL could not put the local KV back: ${e.message}`);
  }
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
