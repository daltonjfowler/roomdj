// Browser test of class time (Dalton, 2026-10-06): the bell schedule presets, "Class ends at" and
// "Cleanup starts", Change times, Max song length, Instrumentals only, and cleanup mode (the music
// fades out and pauses, banners, Keep the music going). Installed Chrome (playwright-core),
// against a LOCAL wrangler dev only.
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:classtime            (or: node test/browser/classtime.mjs http://127.0.0.1:8792/)
// A dev server started with --persist-to <dir>: set CQ_PERSIST=<dir> so the KV seeding reaches it.
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// No Workers AI call: every song suggested while the AI check is on has a verdict seeded in the
// LOCAL KV (made-up track ids, also seeded in the KV song cache), deleted at the end; the cleanup
// room runs with the AI check off. Searches hit the real iTunes API (through the host page).
// The teacher's saved settings are put back at the end.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_LYRICS, PROMPT_VERSION, verdictKey } from '../../shared/filter.js';
import { timeValue } from '../../shared/classtime.js';
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
  const file = `${OUT}classtime-kv-${action}.json`;
  writeFileSync(file, JSON.stringify(entries));
  localKv('bulk', action, file, ...(action === 'delete' ? ['--force'] : []));
}

const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

// ---- Pages -------------------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=document-user-activation-required'] });

async function openPage(name, path, { init = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  if (init) await ctx.addInitScript(init.fn, init.arg);
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
  await page.goto(new URL(path, BASE).href);
  return p;
}

const lastState = (p) => [...p.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const lastBlocked = (p) => [...p.msgs].reverse().find((m) => m.t === 'blocked')?.list ?? null;
const visible = (p, sel) => p.page.locator(sel).isVisible();
const text = (p, sel) => p.page.locator(sel).textContent();
const shot = (p, label) => p.page.screenshot({ path: `${OUT}classtime-${label}-${p.name}.png` }).catch(() => {});
const toastHas = (p, s) => until(async () => (await text(p, '#toasts')).includes(s));

async function hostState(host, pred, timeout = 10_000) {
  return until(() => {
    const s = lastState(host);
    return s && pred(s) ? s : null;
  }, { timeout });
}

async function joinStudent(p, code, nick) {
  await p.page.fill('#code', code);
  await p.page.fill('#nick', nick);
  await p.page.click('#joinBtn');
  await p.page.waitForSelector('#roomScreen:not([hidden])');
}

async function search(p, q) {
  const before = await text(p, '#searchMsg');
  await p.page.fill('#q', q);
  await p.page.press('#q', 'Enter');
  await until(async () => {
    const t = await text(p, '#searchMsg');
    return t !== 'Searching…' && (t !== before || /found/.test(t)) && /found|not|Wait/.test(t);
  }, { timeout: 15_000 });
  return p.page.$$eval('#results li[data-id]', (els) => els.map((e) => e.dataset.id));
}

async function apiJoin(code, device) {
  const r = await fetch(new URL('api/join', BASE), {
    method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  return r.status;
}

/** A student that is only a WebSocket (to suggest song ids no search shows). */
async function rawStudent(roomId, device, nick) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}api/rooms/${roomId}/ws?${new URLSearchParams({ role: 'student', device, nick })}`);
  const s = { ws, msgs: [] };
  ws.addEventListener('message', (e) => { try { s.msgs.push(JSON.parse(e.data)); } catch { /* not JSON */ } });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  s.ask = async (msg, pred) => {
    const n = s.msgs.length;
    ws.send(JSON.stringify(msg));
    return until(() => s.msgs.slice(n).find(pred), { timeout: 30_000 });
  };
  s.state = () => [...s.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
  return s;
}

const seeded = [];
/** A made-up song in the LOCAL KV song cache (and its verdict), so the room never asks iTunes or the AI. */
function seedSong({ title, durationMs = 200_000, verdict = null, version = PROMPT_VERSION }) {
  const trackId = 980_000_000 + Math.floor(Math.random() * 9_000_000);
  const song = {
    id: `it:${trackId}`, title, artist: 'Classtime Test', album: 'Test', artwork: '',
    durationMs, explicit: 'notExplicit', previewUrl: 'https://audio-ssl.itunes.apple.com/test.m4a', genre: 'Pop',
  };
  const entries = [{ key: `song:${trackId}`, value: JSON.stringify(song) }];
  if (verdict) entries.push({ key: verdictKey(song.id, version), value: JSON.stringify(verdict) });
  localKvBulk('put', entries);
  seeded.push(...entries.map((e) => e.key));
  return song.id;
}
const OK = (instrumental) => ({ verdict: 'ok', category: 'other', evidence: '', ...(instrumental === undefined ? {} : { instrumental }) });

const devId = (n) => `classtime-device-${n}-${Math.random().toString(36).slice(2, 10)}`;
const hm = (ms) => timeValue(ms);
const minute = 60_000;
const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
};

// ---- The flow ----------------------------------------------------------------------------------

const savedDefaults = await (await api('/api/teacher/settings')).json();
// Songs replay across runs and rooms: no repeat cooldown while this test runs (the saved
// defaults, cooldown included, go back at the end).
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false }) });
const pages = [];
const raws = [];
try {
  // Bells relative to now (whole minutes): one passed, the next, a later one. Late at night the
  // later ones would be tomorrow's, so the test needs about two hours left in the day.
  const now = Date.now();
  const round = (ms) => Math.floor(ms / minute) * minute;
  const passed = round(now - 30 * minute);
  const left = (new Date(new Date(now).setHours(23, 59, 0, 0)).getTime() - now) / minute; // minutes left today
  const next = round(now + Math.min(40, Math.floor(left / 3)) * minute);
  const later = round(now + Math.min(100, Math.floor((2 * left) / 3)) * minute);
  if (left < 75 || new Date(passed).getDate() !== new Date(now).getDate()) {
    throw new Error('run this test between 00:30 and 22:45 (the bell times must be today)');
  }
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ bellSchedule: [], bellOffsetSeconds: 0, aiCheck: true, maxSongMinutes: 5, instrumentalsOnly: false, cleanupMinutes: 5, periodMinutes: 70 }) });

  // 1. The bell schedule editor (from the open-room form), saved with the teacher key.
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  check('open form: no bells yet, so the class end is one period (70 min) from now',
    await host.page.isChecked('input[name="openEnd"][value="custom"]')
    && Math.abs(at(await host.page.inputValue('#openCustom')) - (now + 70 * minute)) <= 2 * minute);
  check('open form: cleanup prefilled 5 minutes before', (await host.page.inputValue('#openCleanup'))
    === hm(at(await host.page.inputValue('#openCustom')) - 5 * minute));
  await host.page.click('#bellEditBtn');
  await host.page.waitForSelector('#bellDlg[open]');
  const rowsFill = [['P3', later], ['P1', passed], ['P2', next]]; // out of order: saved sorted
  for (let i = 0; i < rowsFill.length; i++) {
    if (i) await host.page.click('#bellAdd');
    await host.page.locator('#bellRows .bell-name').nth(i).fill(rowsFill[i][0]);
    await host.page.locator('#bellRows .bell-ends').nth(i).fill(hm(rowsFill[i][1]));
  }
  await host.page.click('#bellAdd');
  await host.page.locator('#bellRows .bell-name').nth(3).fill('Gone');
  await host.page.locator('#bellRows .bell-remove').nth(3).click();
  check('bell editor: Remove takes a row out', (await host.page.locator('#bellRows li').count()) === 3);
  await host.page.locator('#bellRows .bell-name').nth(0).fill('fuck');
  await host.page.click('#bellSave');
  check('bell editor: a rude name is refused (the word is not repeated)', Boolean(await until(async () => /students should not see/.test(await text(host, '#bellMsg'))))
    && !(await text(host, '#bellMsg')).includes('fuck'));
  await host.page.locator('#bellRows .bell-name').nth(0).fill('P3');
  await host.page.click('#bellSave');
  check('bell editor: saved', Boolean(await toastHas(host, 'Bell schedule saved.')));
  const saved = await (await api('/api/teacher/settings')).json();
  check('bell schedule: kept with the teacher settings, sorted by time', JSON.stringify(saved.bellSchedule)
    === JSON.stringify([{ name: 'P1', ends: hm(passed) }, { name: 'P2', ends: hm(next) }, { name: 'P3', ends: hm(later) }]), JSON.stringify(saved.bellSchedule));
  check('bell schedule: a partial save keeps the other settings', saved.periodMinutes === 70 && saved.maxSongMinutes === 5);

  // 2. The open form: passed bell greyed out, the next one picked, cleanup follows the pick.
  await until(() => host.page.locator('#openBells input').count().then((n) => n === 3));
  check('open form: the passed bell is greyed out', await host.page.isDisabled('#openBells input[value="bell:0"]')
    && (await text(host, '#openBells label:nth-child(1)')).includes('passed'));
  check('open form: the next bell is picked', await host.page.isChecked('#openBells input[value="bell:1"]'));
  check('open form: cleanup = the next bell − 5 minutes', (await host.page.inputValue('#openCleanup')) === hm(next - 5 * minute));
  await host.page.check('#openBells input[value="bell:2"]');
  check('open form: picking another bell moves cleanup', (await host.page.inputValue('#openCleanup')) === hm(later - 5 * minute));
  await host.page.fill('#openCustom', hm(now + 20 * minute));
  check('open form: typing a custom time picks Custom time', await host.page.isChecked('input[name="openEnd"][value="custom"]')
    && (await host.page.inputValue('#openCleanup')) === hm(round(now + 20 * minute) - 5 * minute));
  await host.page.check('input[name="openEnd"][value="day"]');
  check('open form: the end of today has no cleanup prefilled', (await host.page.inputValue('#openCleanup')) === '');
  await host.page.check('#openBells input[value="bell:1"]');
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { classCode: code, room: roomId } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const s0 = await hostState(host, () => true);
  check('room: until = the picked bell, cleanupAt = 5 minutes before', s0?.until === next && s0?.cleanupAt === next - 5 * minute && s0?.cleanup === false,
    JSON.stringify([s0?.until, next, s0?.cleanupAt]));
  check('room: the big times say when cleanup starts and when class ends', /Cleanup .*Class ends /.test(await text(host, '#untilNote')));

  // 3. Change times: another bell, then no cleanup.
  await host.page.click(await reveal(host.page, '#timesBtn'));
  await host.page.waitForSelector('#timesDlg[open]');
  check('Change times: the room\'s bell is picked', await host.page.isChecked('#timesBells input[value="bell:1"]')
    && (await host.page.inputValue('#timesCleanup')) === hm(next - 5 * minute));
  await host.page.check('#timesBells input[value="bell:2"]');
  await host.page.click('#timesSave');
  check('Change times: a preset moves class end and cleanup', Boolean(await hostState(host, (s) => s.until === later && s.cleanupAt === later - 5 * minute)));
  check('Change times: the saved host entry lasts until the new class end', Boolean(await until(() => host.page.evaluate(
    (u) => JSON.parse(localStorage.getItem('cq.host'))?.until === u, later))));
  await host.page.click(await reveal(host.page, '#timesBtn'));
  await host.page.waitForSelector('#timesDlg[open]');
  await host.page.fill('#timesCleanup', '');
  await host.page.click('#timesSave');
  check('Change times: an empty cleanup means none', Boolean(await hostState(host, (s) => s.cleanupAt === null)) && !(await text(host, '#untilNote')).includes('Cleanup'));
  await host.page.click(await reveal(host.page, '#timesBtn'));
  await host.page.fill('#timesCleanup', hm(later + 10 * minute));
  await host.page.click('#timesSave');
  check('Change times: cleanup after class ends is refused', Boolean(await until(async () => /before class ends/.test(await text(host, '#timesMsg')))));
  await host.page.click('#timesCancel');

  // 4. Max song length (Settings: Songs), checked before any credit is spent.
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  check('settings: Max song length is on at 5 minutes by default', await host.page.isChecked('#setMaxLenOn') && (await host.page.inputValue('#setMaxLen')) === '5');
  await host.page.setChecked(await reveal(host.page, '#setCreditsOn'), true);
  await host.page.fill(await reveal(host.page, '#setCredits'), '5');
  await host.page.click('#applySettings');
  await hostState(host, (s) => s.settings.startingCredits === 5);
  const long = seedSong({ title: 'Classtime Long Song', durationMs: 432_000, verdict: OK(true) });
  const okSong = seedSong({ title: 'Classtime Short Song', durationMs: 200_000, verdict: OK(false) });
  check('join: a raw student joins', (await apiJoin(code, (raws[0] = { device: devId(1) }).device)) === 200);
  const zed = await rawStudent(roomId, raws[0].device, 'Zed');
  raws[0] = zed;
  await until(() => zed.state());
  const tl = await zed.ask({ t: 'suggest', song: long }, (m) => m.t === 'suggested' && m.song === long);
  check('too long: refused with reason too_long and the times', tl?.reason === 'too_long' && tl.why?.id === 'too_long'
    && tl.why.evidence === 'This song is 7:12; the limit is 5:00.', JSON.stringify(tl));
  check('too long: no credit spent, not refunded out loud', !tl?.refunded && zed.state()?.you?.credits === 5);
  check('too long: not in Blocked today', (lastBlocked(host) ?? []).every((b) => b.song.id !== long));
  const ok1 = await zed.ask({ t: 'suggest', song: okSong }, (m) => m.t === 'suggested' && m.song === okSong);
  check('a short song (seeded verdict) joins the queue', ok1?.ok === true, JSON.stringify(ok1));

  // The student page marks long songs in its results (real iTunes search, through the host page).
  const ava = await openPage('ava', `?code=${code}`);
  pages.push(ava);
  await joinStudent(ava, code, 'Ava');
  await host.page.click('#settingsBtn');
  await host.page.fill(await reveal(host.page, '#setMaxLen'), '1');
  await host.page.click('#applySettings');
  await hostState(host, (s) => s.settings.maxSongMinutes === 1);
  const ids = await search(ava, 'Bohemian Rhapsody Queen');
  const tooLongRow = `#results li[data-id="${ids[0]}"]`;
  check('student results: a long song says ⏱ Too long', Boolean(await until(async () => (await text(ava, tooLongRow)).includes('⏱ Too long'))));
  await ava.page.click(`${tooLongRow} button[data-act="why"]`);
  check('student results: Why? gives the times', Boolean(await toastHas(ava, '⏱ Too long: This song is')));
  await host.page.click('#settingsBtn');
  await host.page.setChecked(await reveal(host.page, '#setMaxLenOn'), false);
  await host.page.click('#applySettings');
  await hostState(host, (s) => s.settings.maxSongMinutes === null);
  check('Max song length off: the result can be suggested again', Boolean(await until(async () => !(await text(ava, tooLongRow)).includes('Too long'))));

  // 5. Instrumentals only, with seeded verdicts (no AI call).
  await host.page.click('#settingsBtn');
  await host.page.setChecked(await reveal(host.page, '#setInstrumental'), true);
  await host.page.setChecked(await reveal(host.page, '#setMaxLenOn'), true);
  await host.page.fill(await reveal(host.page, '#setMax'), '10');
  await host.page.click('#applySettings');
  await hostState(host, (s) => s.settings.instrumentalsOnly === true && s.settings.maxSongMinutes === 5);
  check('student: the Instrumentals only note shows', Boolean(await until(() => visible(ava, '#instrumentalNote'))));
  const vocal = seedSong({ title: 'Classtime Vocal Song', verdict: OK(false) });
  const instr = seedSong({ title: 'Classtime Piano Song', verdict: OK(true) });
  const unsure = seedSong({ title: 'Classtime Mystery Song', verdict: { ...OK('unknown'), ...NO_LYRICS } }); // no LRCLIB lookup
  const titled = seedSong({ title: 'Classtime Tune (Instrumental)', verdict: OK() });
  const credits0 = zed.state()?.you?.credits;
  const v = await zed.ask({ t: 'suggest', song: vocal }, (m) => m.t === 'suggested' && m.song === vocal);
  check('instrumentals: a song with singing is refused (🎹, "This song has singing.")', v?.reason === 'not_instrumental'
    && v.why?.id === 'not_instrumental' && v.why.evidence === 'This song has singing.', JSON.stringify(v));
  check('instrumentals: its credit came back', v?.refunded === true && zed.state()?.you?.credits === credits0);
  const blockedV = await until(() => (lastBlocked(host) ?? []).find((b) => b.song.id === vocal));
  check('instrumentals: in Blocked today with Allow anyway', blockedV?.canAllow === true && blockedV.why.id === 'not_instrumental');
  const i1 = await zed.ask({ t: 'suggest', song: instr }, (m) => m.t === 'suggested' && m.song === instr);
  check('instrumentals: an instrumental song joins', i1?.ok === true, JSON.stringify(i1));
  const u1 = await zed.ask({ t: 'suggest', song: unsure }, (m) => m.t === 'suggested' && m.song === unsure);
  check('instrumentals: unsure waits in Needs a look', u1?.reason === 'review' && u1.why?.id === 'unknown');
  const t1 = await zed.ask({ t: 'suggest', song: titled }, (m) => m.t === 'suggested' && m.song === titled);
  check('instrumentals: "(Instrumental)" in the title is enough (a v4 verdict, no AI call)', t1?.ok === true, JSON.stringify(t1));
  check('instrumentals: no AI trouble', lastState(host)?.aiStatus === 'ok');

  // 6. Save as my default keeps the bell schedule and saves the Songs settings.
  await host.page.click('#settingsBtn');
  await host.page.click('#saveDefault');
  await toastHas(host, 'Saved.');
  const after = await (await api('/api/teacher/settings')).json();
  check('Save as my default: bells kept, Instrumentals only saved', after.bellSchedule?.length === 3 && after.instrumentalsOnly === true && after.maxSongMinutes === 5,
    JSON.stringify(after));
  await host.page.click(await reveal(host.page, '#closeBtn'));
  await host.page.click('#confirm button[value="ok"]');
  await until(() => visible(host, '#closedScreen'));
  await host.page.click('#newRoomBtn');
  await until(() => host.page.locator('#openBells input').count().then((n) => n === 3));
  check('a new room: the saved bells come back, the next one picked', await host.page.isChecked('#openBells input[value="bell:1"]'));

  // 7. Cleanup: a room that ends in 75 s with cleanup in 25 s (the API, for seconds), AI off.
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ aiCheck: false, instrumentalsOnly: false, maxSongMinutes: null, startingCredits: null }) });
  const t0 = Date.now();
  const cleanCode = `classtime cleanup ${Math.floor(Math.random() * 1e6)}`;
  const opened = await (await api('/api/teacher/rooms', { method: 'POST', body: JSON.stringify({ code: cleanCode, until: t0 + 75_000, cleanupAt: t0 + 25_000 }) })).json();
  check('cleanup room: opened with cleanupAt', opened.cleanupAt === t0 + 25_000, JSON.stringify(opened).replace(/"hostToken":"[^"]+"/, ''));
  const bad = await api('/api/teacher/rooms', { method: 'POST', body: JSON.stringify({ code: `${cleanCode} x`, until: t0 + 75_000, cleanupAt: t0 + 80_000 }) });
  check('open: cleanup after class end is refused (400 cleanup)', bad.status === 400 && (await bad.json()).error === 'cleanup');
  const entry = { room: opened.room, classCode: opened.code, token: opened.hostToken, until: opened.until };
  const host2 = await openPage('host2', 'host/', { init: { fn: (e) => { try { localStorage.setItem('cq.host', JSON.stringify(e)); } catch { /* blocked */ } }, arg: entry } });
  pages.push(host2);
  await host2.page.waitForSelector('#hostScreen:not([hidden])');
  const bea = await openPage('bea', `?code=${opened.code}`);
  pages.push(bea);
  await joinStudent(bea, opened.code, 'Bea');
  const found = await search(bea, 'Lovely Day Bill Withers');
  await bea.page.click(`#results li[data-id="${found[0]}"] button[data-act="suggest"]`);
  await hostState(host2, (s) => s.queue.length > 0, 20_000);
  await host2.page.click('#startBtn');
  const progressed = await until(async () => parseFloat(await host2.page.$eval('#progressBar', (e) => e.style.width || '0')) > 0, { timeout: 15_000 });
  check('cleanup room: the song plays', Boolean(progressed));
  check('cleanup room: not in cleanup yet; the note says when', lastState(host2)?.cleanup === false && (await text(host2, '#untilNote')).includes('🧹 Cleanup'));
  await host2.page.click(await reveal(host2.page, '#lockBtn')); // locked before cleanup: it stays locked after "Keep the music going"
  await hostState(host2, (s) => s.locked === true);
  const cs = await hostState(host2, (s) => s.cleanup === true, 40_000);
  check('cleanup: the room goes into cleanup mode at cleanupAt', Boolean(cs) && Date.now() >= t0 + 25_000 - 1500);
  check('cleanup: the big banner with a countdown to the bell', (await visible(host2, '#cleanupBanner'))
    && /^\d+:\d\d$/.test((await text(host2, '#cleanupCount')).trim()));
  const c1 = (await text(host2, '#cleanupCount')).trim();
  await new Promise((r) => setTimeout(r, 2100));
  check('cleanup: the countdown moves', (await text(host2, '#cleanupCount')).trim() !== c1);
  check('cleanup: the music fades out and pauses (no next song)', Boolean(await until(async () => (await text(host2, '#playBtn')).includes('Play'), { timeout: 9000 })));
  check('cleanup: the song stays now playing (not moved on)', lastState(host2)?.nowPlaying?.song.id === cs?.nowPlaying?.song.id);
  check('cleanup: the student sees the cleanup banner', Boolean(await until(() => visible(bea, '#cleanupNote'))));
  check('cleanup: background music is off too', await host2.page.isDisabled('#fillerBtn'));
  const found2 = await search(bea, 'Happy Pharrell');
  check('cleanup: results say 🧹 Cleanup', Boolean(await until(async () => (await text(bea, `#results li[data-id="${found2[0]}"]`)).includes('Cleanup'))));
  const beaState = lastState(bea);
  check('cleanup: the student state says cleanup', beaState?.cleanup === true);
  await host2.page.click(await reveal(host2.page, '#bigBtn'));
  check('big screen: the cleanup banner shows, Keep the music going does not', (await visible(host2, '#cleanupBanner')) && !(await visible(host2, '#cleanupKeep')));
  await host2.page.click(await reveal(host2.page, '#bigBtn'));
  await host2.page.click('#cleanupKeep');
  check('Keep the music going: cleanup ends, no cleanup time left', Boolean(await hostState(host2, (s) => s.cleanup === false && s.cleanupAt === null)));
  check('Keep the music going: the music comes back', Boolean(await until(async () => (await text(host2, '#playBtn')).includes('Pause'), { timeout: 8000 })));
  check('Keep the music going: the student banner goes', Boolean(await until(async () => !(await visible(bea, '#cleanupNote')))));
  check('Keep the music going: background music can play again', Boolean(await until(() => host2.page.isEnabled('#fillerBtn'))));
  check('Keep the music going: suggestions stay locked (they were locked before cleanup)', lastState(host2)?.locked === true
    && Boolean(await until(() => visible(bea, '#lockedNote'))));
  await host2.page.click(await reveal(host2.page, '#lockBtn'));
  await hostState(host2, (s) => s.locked === false);
  await bea.page.click(`#results li[data-id="${found2[0]}"] button[data-act="suggest"]`);
  check('Keep the music going: students can suggest again once unlocked', Boolean(await hostState(host2, (s) => s.queue.some((q) => q.song.id === found2[0]) || s.nowPlaying?.song.id === found2[0], 15_000)));
  await host2.page.click(await reveal(host2.page, '#closeBtn'));
  await host2.page.click('#confirm button[value="ok"]');
  await until(() => visible(host2, '#closedScreen'));

  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL classtime stopped: ${e?.stack ?? e}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  for (const r of raws) r?.ws?.close();
  const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ ...savedDefaults, bellSchedule: savedDefaults.bellSchedule ?? [] }) });
  if (!r.ok) console.log('FAIL could not put the saved teacher settings back');
  try {
    if (seeded.length) localKvBulk('delete', seeded);
  } catch (e) {
    console.log(`FAIL could not clean the seeded local KV keys: ${e.message}`);
  }
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
