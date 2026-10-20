// Browser test of repeats (protocol.js REPEATS): other versions of a song count as the song, and the
// repeat cooldown (settings.cooldownDays, 1 day by default) across the teacher's rooms. One host
// page and one student page in installed Chrome (playwright-core), plus plain WebSocket students,
// against a LOCAL wrangler dev only.
//   npm run dev                      (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:repeats             (or: node test/browser/repeats.mjs http://127.0.0.1:8792/)
// A dev server started with --persist-to <dir>: set CQ_PERSIST=<dir> so the KV seeding reaches it.
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// No Workers AI call: the first room's AI check is off, and the second room only gets refusals
// that come before the filter. Searches hit the real iTunes API.
// It takes away the LOCAL KV `settings` for a moment (a fresh room must rest songs for 1 day) and
// replaces the LOCAL KV `recent` (the repeat record: the default teacher's key) with seeded songs;
// both are put back at the end.
// Covers: a fresh room's cooldown is 1 day; a seeded song is refused as resting (why resting, at +
// until, nothing charged) and the student's result says "😴 Resting until ..." with a Why?; a remix
// of a song that played is refused as played and its result says "Played already"; the record
// holds songs only; the host's 😴 Resting songs list and Wake now; the cooldown Off in Settings
// lets a resting song in; a song played in the first room rests in a second room (both versions).

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { restingUntilLabel, songKey } from '../../shared/repeats.js';
import { T1, pickTeacher } from './teacher-pick.mjs';
import { reveal } from './ui.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = fileURLToPath(new URL('./.out/', import.meta.url));
const ROOT = new URL('../../', import.meta.url);
mkdirSync(OUT, { recursive: true });
const DAY = 24 * 60 * 60 * 1000;

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
function kvPut(key, value) {
  const file = `${OUT}repeats-kv.json`;
  writeFileSync(file, JSON.stringify([{ key, value }]));
  const r = localKv('bulk', 'put', file);
  if (r.status !== 0) throw new Error(`wrangler kv bulk put --local failed: ${r.stderr.slice(-300)}`);
}
function kvDelete(key) {
  localKv('key', 'delete', key);
}

const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

// ---- Pages -------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

async function openPage(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  // Keep the preview player's <audio>, so a song can "finish" at once.
  await ctx.addInitScript(() => {
    const A = window.Audio;
    window.__audios = [];
    window.Audio = function Audio(...args) {
      const a = new A(...args);
      window.__audios.push(a);
      return a;
    };
    window.Audio.prototype = A.prototype;
  });
  const page = await ctx.newPage();
  const p = { name, ctx, page, msgs: [], errors: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|NotSupportedError|play\(\)/.test(m.text())) p.errors.push(m.text()); });
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    try { p.msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ }
  }));
  await page.goto(new URL(path, BASE).href);
  return p;
}
const lastState = (p) => [...p.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const lastOf = (p, t) => [...p.msgs].reverse().find((m) => m.t === t) ?? null;
const visible = (p, sel) => p.page.locator(sel).isVisible();
const text = (p, sel) => p.page.locator(sel).textContent();
const shot = (p, label) => p.page.screenshot({ path: `${OUT}repeats-${label}-${p.name}.png` }).catch(() => {});
async function hostState(host, pred, timeout = 10_000) {
  return until(() => {
    const s = lastState(host);
    return s && pred(s) ? s : null;
  }, { timeout });
}

async function apiJoin(code, device) {
  const r = await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  return r.status;
}
const PROBES = ['reptest-device-probe01', 'reptest-device-probe02', 'reptest-device-probe03'];
let searches = 0;
/** A song from the room's own search (three probe devices take turns: 15 searches a minute each). */
async function findSong(roomId, q, pred = () => true) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    const probe = PROBES[searches++ % 3];
    const r = await fetch(new URL(`api/rooms/${roomId}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': probe } });
    const data = await r.json();
    const song = data.results?.find(pred);
    if (song) return song;
    last = `${r.status} ${JSON.stringify(data).slice(0, 300)}`;
    await wait(2000);
  }
  throw new Error(`no search result for ${q}: ${last}`);
}

/** A socket: a student (role student) or the host (role host). */
async function rawSocket(roomId, params) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}api/rooms/${roomId}/ws?${new URLSearchParams(params)}`);
  const s = { ws, msgs: [] };
  ws.addEventListener('message', (e) => { try { s.msgs.push(JSON.parse(e.data)); } catch { /* not JSON */ } });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  s.ask = async (msg, pred, timeout = 20_000) => {
    const n = s.msgs.length;
    ws.send(JSON.stringify(msg));
    return until(() => s.msgs.slice(n).find(pred), { timeout });
  };
  s.send = (msg) => ws.send(JSON.stringify(msg));
  s.state = () => [...s.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
  s.last = (t) => [...s.msgs].reverse().find((m) => m.t === t) ?? null;
  return s;
}

async function hostSettings(host, set) {
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  if (set.ai !== undefined) await host.page.setChecked(await reveal(host.page, '#setAi'), set.ai);
  if (set.max !== undefined) await host.page.fill(await reveal(host.page, '#setMax'), String(set.max));
  if (set.credits !== undefined) {
    await host.page.setChecked(await reveal(host.page, '#setCreditsOn'), set.credits !== null);
    if (set.credits !== null) await host.page.fill(await reveal(host.page, '#setCredits'), String(set.credits));
  }
  if (set.maxLen !== undefined) await host.page.setChecked(await reveal(host.page, '#setMaxLenOn'), set.maxLen);
  if (set.cooldown !== undefined) await host.page.selectOption(await reveal(host.page, '#setCooldown'), set.cooldown);
  await host.page.selectOption(await reveal(host.page, '#setBackToWork'), 'off'); // students act many times in a row here
  await host.page.click('#applySettings');
}

/** The preview player's song ends (as if the 30 s ran out). */
async function finishSong(host) {
  const before = lastState(host)?.nowPlaying?.id ?? null;
  await host.page.evaluate(() => window.__audios.forEach((a) => a.dispatchEvent(new Event('ended'))));
  return hostState(host, (s) => (s.nowPlaying?.id ?? null) !== before);
}

async function searchOn(p, q) {
  await p.page.fill('#q', q);
  await p.page.press('#q', 'Enter');
}
const resultButton = (p, id) => p.page.locator(`#results li[data-id="${id}"] button[data-act="suggest"]`);

// ---- The flow ----------------------------------------------------------------------------------
const savedSettings = kvGet('settings');
const savedRecent = kvGet('recent');
const pages = [];
const raws = [];
try {
  // A teacher with no saved settings: a fresh room rests songs for 1 day.
  kvDelete('settings');
  kvDelete('recent');
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.check('input[name="openEnd"][value="day"]');
  await host.page.fill('#openCleanup', '');
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { classCode: code, room: roomId } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const first = await hostState(host, () => true);
  check('default: a fresh room has the repeat cooldown on at 1 day', first.settings.cooldownDays === 1, JSON.stringify(first.settings.cooldownDays));
  // The settings form shows it.
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  check('settings: Repeat cooldown shows "1 day" and offers Off to 2 weeks', (await host.page.inputValue('#setCooldown')) === '1'
    && (await host.page.$$eval('#setCooldown option', (os) => os.map((o) => o.textContent).join())) === 'Off,1 day,3 days,1 week,2 weeks');
  await host.page.click('#cancelSettings');

  for (const d of PROBES) await apiJoin(code, d);
  const songs = {};
  songs.orig = await findSong(roomId, 'Blinding Lights The Weeknd', (s) => s.title === 'Blinding Lights' && songKey(s) === 'blinding lights|the weeknd');
  const isRemix = (s) => s.id !== songs.orig.id && songKey(s) === songKey(songs.orig) && /remix|mix|edit|version|sped|slowed|live/i.test(s.title);
  songs.remix = await findSong(roomId, 'Blinding Lights remix The Weeknd', isRemix).catch(() => findSong(roomId, 'Blinding Lights Chromatics remix', isRemix));
  songs.rest1 = await findSong(roomId, 'Viva la Vida Coldplay', (s) => /^viva la vida/i.test(s.title) && songKey(s)?.endsWith('|coldplay'));
  songs.rest2 = await findSong(roomId, 'Here Comes the Sun Beatles', (s) => /^here comes the sun/i.test(s.title));
  console.log(`songs: ${Object.values(songs).map((s) => `${s.title} (${s.artist})`).join(' · ')}`);

  // Seed the record as if both played in another room 2 hours ago (the default teacher's key).
  const at = Date.now() - 2 * 60 * 60 * 1000;
  const seed = (s) => [songKey(s), { at, title: s.title, artist: s.artist }];
  kvPut('recent', JSON.stringify({ v: 1, songs: Object.fromEntries([seed(songs.rest1), seed(songs.rest2)]) }));

  await hostSettings(host, { ai: false, max: 6, credits: 5, maxLen: false });
  await hostState(host, (s) => !s.settings.aiCheck && s.settings.startingCredits === 5 && s.settings.maxSongMinutes === null);

  await apiJoin(code, 'reptest-device-cy-0001');
  const cy = await rawSocket(roomId, { role: 'student', device: 'reptest-device-cy-0001', nick: 'Cy' });
  raws.push(cy);
  const ava = await openPage('ava', `?code=${code}`);
  pages.push(ava);
  await ava.page.fill('#code', code);
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');

  // The repeats message: the seeded songs rest (song keys only).
  const rep = await until(() => lastOf(ava, 'repeats'));
  check('repeats: the student page gets the resting songs on connect', rep?.resting?.length === 2 && rep.resting.every(([k, a, u]) => typeof k === 'string' && a === at && u === at + DAY),
    JSON.stringify(rep));

  // A resting song: refused before anything is charged, why resting with at + until.
  const sug = async (s, song) => s.ask({ t: 'suggest', song: song.id }, (m) => m.t === 'suggested' && m.song === song.id);
  const credits0 = cy.state()?.you.credits;
  const r1 = await sug(cy, songs.rest1);
  check('resting: a song that played 2 hours ago is refused (reason resting)', r1?.ok === false && r1.reason === 'resting' && r1.why?.id === 'resting', JSON.stringify(r1));
  check('resting: ... with when it played and when it can come back (ms)', r1?.at === at && r1?.until === at + DAY);
  await wait(300);
  check('resting: ... and costs no credit', cy.state()?.you.credits === credits0 && credits0 === 5, `${credits0} → ${cy.state()?.you.credits}`);

  // The student's result says so before anyone tries, with a Why?.
  await searchOn(ava, 'Viva la Vida Coldplay');
  const label = `😴 Resting ${restingUntilLabel(at + DAY)}`;
  check('student: the result says "😴 Resting until ..."', Boolean(await until(async () => (await resultButton(ava, songs.rest1.id).count())
    && (await resultButton(ava, songs.rest1.id).textContent()).trim() === label, { timeout: 20_000 })),
  `${label} vs ${await resultButton(ava, songs.rest1.id).textContent().catch(() => '?')}`);
  await ava.page.click(`#results li[data-id="${songs.rest1.id}"] button[data-act="why"]`);
  check('student: Why? says when it played and when it can come back', Boolean(await until(async () => /😴 Resting: This song played (earlier today|yesterday)\. It can come back (tomorrow|later today)/.test(await text(ava, '#toasts')))),
    await text(ava, '#toasts'));
  await shot(ava, 'resting');

  // A remix of a song that played this period: refused as played.
  check('suggest the original', (await sug(cy, songs.orig))?.ok === true);
  await host.page.click('#startBtn');
  await hostState(host, (s) => s.nowPlaying?.song.id === songs.orig.id);
  await finishSong(host);
  await hostState(host, (s) => !s.nowPlaying);
  const credits1 = cy.state()?.you.credits;
  const r2 = await sug(cy, songs.remix);
  check(`played: a remix ("${songs.remix.title}") of a song that played is refused as played`, r2?.ok === false && r2.reason === 'played', JSON.stringify(r2));
  await wait(300);
  check('played: ... and costs no credit', cy.state()?.you.credits === credits1, `${credits1} → ${cy.state()?.you.credits}`);
  await searchOn(ava, 'Blinding Lights remix The Weeknd');
  check('student: the remix result says "Played already"', Boolean(await until(async () => (await resultButton(ava, songs.remix.id).count())
    && (await resultButton(ava, songs.remix.id).textContent()).trim() === 'Played already', { timeout: 20_000 })));

  // The record: the finished song is in it, songs only.
  const kv = await until(() => {
    const v = kvGet('recent');
    return v && JSON.parse(v).songs?.[songKey(songs.orig)] ? v : null;
  });
  check('record: the finished song is on the teacher\'s record', Boolean(kv));
  check('record: songs only (no nickname, device or room id)', kv && !['Ava', '"Cy"', 'reptest-device', roomId, '"by"', '"device"'].some((x) => kv.includes(x)));

  // Host: 😴 Resting songs, Wake now.
  await host.page.click(await reveal(host.page, '#favBtn'));
  await host.page.waitForSelector('#favDlg[open]');
  check('host: the Resting songs list shows the resting songs', Boolean(await until(async () => (await host.page.locator('#restList li[data-key]').count()) === 3)),
    String(await host.page.locator('#restList li[data-key]').count()));
  await host.page.click(`#restList li[data-key="${songKey(songs.rest1)}"] button[data-act="wake"]`);
  check('wake: the song leaves the list', Boolean(await until(async () => (await host.page.locator('#restList li[data-key]').count()) === 2)));
  check('wake: students get the new list', Boolean(await until(() => {
    const m = cy.last('repeats');
    return m && !m.resting.some(([k]) => k === songKey(songs.rest1)) ? m : null;
  })));
  check('wake: the song can be suggested now', (await sug(cy, songs.rest1))?.ok === true);
  await host.page.click('#favDlg button[value="done"]');

  // Cooldown off: every song is available at once.
  check('still resting before the switch', (await sug(cy, songs.rest2))?.reason === 'resting');
  await hostSettings(host, { cooldown: 'off' });
  await hostState(host, (s) => s.settings.cooldownDays === null);
  check('off: students get an empty resting list', Boolean(await until(() => cy.last('repeats')?.resting.length === 0)));
  check('off: the resting song can be suggested', (await sug(cy, songs.rest2))?.ok === true);
  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));

  // A second room (new, default settings: cooldown 1 day): the song that played in the first rests.
  await host.page.click(await reveal(host.page, '#closeBtn'));
  await host.page.waitForSelector('#confirm[open]');
  await host.page.click('#confirm button[value="ok"]');
  await until(() => visible(host, '#closedScreen'));
  const code2 = `repeats second room ${10 + Math.floor(Math.random() * 89)}`;
  const opened = await (await api('/api/teacher/rooms', { method: 'POST', body: JSON.stringify({ code: code2, until: Date.now() + 30 * 60_000 }) })).json();
  check('second room: opens with the cooldown on (1 day)', Boolean(opened.room));
  const host2 = await rawSocket(opened.room, { role: 'host', token: opened.hostToken });
  raws.push(host2);
  host2.send({ t: 'service', service: 'preview' });
  host2.send({ t: 'settings', settings: { aiCheck: false, maxSongMinutes: null, backToWork: false } }); // no AI call
  await apiJoin(code2, 'reptest-device-dee-001');
  const dee = await rawSocket(opened.room, { role: 'student', device: 'reptest-device-dee-001', nick: 'Dee' });
  raws.push(dee);
  await until(() => dee.state());
  check('second room: settings say 1 day', dee.state()?.settings.cooldownDays === 1);
  const r3 = await sug(dee, songs.orig);
  check('second room: the song that finished in the first room is resting', r3?.reason === 'resting' && r3.until > Date.now() + DAY - 10 * 60_000, JSON.stringify(r3));
  const r4 = await sug(dee, songs.remix);
  check('second room: ... and so is its remix', r4?.reason === 'resting', JSON.stringify(r4));
  check('second room: the woken song is not resting', (await sug(dee, songs.rest1))?.reason !== 'resting');
  host2.send({ t: 'close' });
} catch (e) {
  failures++;
  console.log(`FAIL repeats stopped: ${e?.stack ?? e}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  for (const r of raws) r.ws.close();
  try {
    if (savedSettings) kvPut('settings', savedSettings);
    else kvDelete('settings');
    if (savedRecent) kvPut('recent', savedRecent);
    else kvDelete('recent');
  } catch (e) {
    console.log(`FAIL could not put the local KV back: ${e.message}`);
  }
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
