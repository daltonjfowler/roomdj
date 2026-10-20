// Browser test of Top 5, the end-of-class recap (+ fun stats and the "▶ Play recap" show), the
// ⭐ Class favorites and the 🎨 artist switches (protocol.js TOP 5 + RECAP, FAVORITES): one host
// page and one student page in installed Chrome (playwright-core), plus plain WebSocket students,
// against a LOCAL wrangler dev only.
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:favorites            (or: node test/browser/favorites.mjs http://127.0.0.1:8792/)
// A dev server started with --persist-to <dir>: set CQ_PERSIST=<dir> so the KV seeding reaches it.
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// No Workers AI call (the room's AI check is off). Searches hit the real iTunes API through the
// host page; songs "finish" by an 'ended' event on the preview player's <audio> (no 30 s waits).
// It replaces the LOCAL KV `favorites` with a seeded list (a real song, a song with a blocked word,
// an explicit one) and puts the old value back at the end, like the saved teacher settings.
// Covers: 👍 on the song playing (student card, host page, live Top 5; a 👎 refused); finish / skip; Top 5 order + 👑 (host dialog, student
// card, board under the cleanup banner); a finish at +2 joins the favorites; the student's
// ⭐ Class favorites leave out blocked and explicit songs, mark played ones, and Suggest goes
// through the server (a credit is spent); pin and remove reach the student; no back-to-back
// artist (the queue shows the pick, and it plays); one song per artist (same_artist, 🎨 why,
// nothing charged; the page's "Artist waiting"); the recap (versus card, fun stats, More stats,
// Copy recap text); the show (title card, auto-advance, ← →, Space pauses, the reveal, confetti,
// the versus finale, Esc; reduced motion: no confetti); 🎵 the recap music (the room music pauses,
// the #1 song's preview plays in #recapMusic, the room music comes back after Esc); the recap the room sends as it closes;
// the KV favorites hold songs only (no nickname, no device id).

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mainArtist } from '../../shared/filter.js';
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Local KV (wrangler kv --local; never --remote) -------------------------------------------
const WRANGLER = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));
function localKv(...args) {
  const persist = process.env.CQ_PERSIST ? ['--persist-to', process.env.CQ_PERSIST] : [];
  const r = spawnSync(process.execPath, [WRANGLER, 'kv', ...args, '--binding', 'CLASS_KV', '--local', ...persist],
    { cwd: fileURLToPath(ROOT), encoding: 'utf8' });
  return r;
}
function kvGet(key) {
  const r = localKv('key', 'get', key, '--text');
  if (r.status !== 0 || /Value not found/i.test(r.stdout + r.stderr)) return null;
  return r.stdout.trim() || null;
}
function kvPut(key, value) {
  const file = `${OUT}favorites-kv.json`;
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
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
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
const shot = (p, label) => p.page.screenshot({ path: `${OUT}favorites-${label}-${p.name}.png` }).catch(() => {});
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
let searches = 0;
/** A song from the room's own search (three probe devices take turns: 15 searches a minute each). */
async function findSong(roomId, q, _device, pred = () => true) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    const probe = ['favtest-device-probe01', 'favtest-device-probe02', 'favtest-device-probe03'][searches++ % 3];
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
  s.ask = async (msg, pred, timeout = 15_000) => {
    const n = s.msgs.length;
    ws.send(JSON.stringify(msg));
    return until(() => s.msgs.slice(n).find(pred), { timeout });
  };
  s.send = (msg) => ws.send(JSON.stringify(msg));
  s.state = () => [...s.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
  return s;
}

async function hostSettings(host, set) {
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  if (set.ai !== undefined) await host.page.setChecked(await reveal(host.page, '#setAi'), set.ai);
  if (set.counts !== undefined) await host.page.setChecked(await reveal(host.page, '#setHideCounts'), !set.counts);
  if (set.max !== undefined) await host.page.fill(await reveal(host.page, '#setMax'), String(set.max));
  if (set.words !== undefined) await host.page.fill(await reveal(host.page, '#setWords'), set.words);
  if (set.credits !== undefined) {
    await host.page.setChecked(await reveal(host.page, '#setCreditsOn'), set.credits !== null);
    if (set.credits !== null) await host.page.fill(await reveal(host.page, '#setCredits'), String(set.credits));
  }
  if (set.maxLen !== undefined) await host.page.setChecked(await reveal(host.page, '#setMaxLenOn'), set.maxLen);
  if (set.showFav !== undefined) await host.page.setChecked(await reveal(host.page, '#setShowFav'), set.showFav);
  if (set.backToBack !== undefined) await host.page.setChecked(await reveal(host.page, '#setBackToBack'), set.backToBack);
  if (set.onePerArtist !== undefined) await host.page.setChecked(await reveal(host.page, '#setOnePerArtist'), set.onePerArtist);
  await host.page.click('#applySettings');
}

/** The preview player's song ends (as if the 30 s ran out). */
async function finishSong(host) {
  const before = lastState(host)?.nowPlaying?.id ?? null;
  await host.page.evaluate(() => window.__audios.forEach((a) => a.dispatchEvent(new Event('ended'))));
  return hostState(host, (s) => (s.nowPlaying?.id ?? null) !== before);
}

// ---- The flow ----------------------------------------------------------------------------------
const savedDefaults = await (await api('/api/teacher/settings')).json();
// Songs replay across runs and rooms: no repeat cooldown while this test runs (the saved
// defaults, cooldown included, go back at the end).
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false }) });
const savedFavorites = kvGet('favorites');
const pages = [];
const raws = [];
try {
  kvDelete('favorites');
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  // "The end of today", no cleanup: works at any time of day (one period from now may be after midnight).
  await host.page.check('input[name="openEnd"][value="day"]');
  await host.page.fill('#openCleanup', '');
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { classCode: code, room: roomId, token } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const first = await hostState(host, () => true);
  check('settings: Class favorites on, artist switches off by default', first.settings.showFavorites === true
    && first.settings.noBackToBackArtist === false && first.settings.oneSongPerArtist === false, JSON.stringify(first.settings));
  check('state: top5 is empty in a new room', Array.isArray(first.top5) && first.top5.length === 0);

  // Students: three plain sockets, and Ava's page.
  const devices = { cy: 'favtest-device-cy-0001', dee: 'favtest-device-dee-001', eli: 'favtest-device-eli-001', probe: 'favtest-device-probe01', probe2: 'favtest-device-probe02', probe3: 'favtest-device-probe03' };
  for (const d of Object.values(devices)) await apiJoin(code, d);
  const songs = {};
  songs.a1 = await findSong(roomId, 'Here Comes the Sun Beatles', devices.probe);
  songs.a2 = await findSong(roomId, 'Dancing Queen ABBA', devices.probe);
  songs.b1 = await findSong(roomId, 'Uptown Funk Bruno Mars', devices.probe);
  songs.fav = await findSong(roomId, 'Mr. Blue Sky Electric Light Orchestra', devices.probe);
  const ts = (s) => mainArtist(s.artist) === 'coldplay';
  songs.ts1 = await findSong(roomId, 'Viva la Vida Coldplay', devices.probe, ts);
  songs.ts2 = await findSong(roomId, 'Yellow Coldplay', devices.probe, (s) => ts(s) && s.id !== songs.ts1.id);
  songs.ts3 = await findSong(roomId, 'Clocks Coldplay', devices.probe, (s) => ts(s) && ![songs.ts1.id, songs.ts2.id].includes(s.id));
  songs.mj = await findSong(roomId, 'Billie Jean Michael Jackson', devices.probe);

  // Seed the favorites (songs only): a real song, a blocked word, an explicit one.
  const now = Date.now();
  const entry = (song, net) => ({ song, top5: 0, net, plays: 1, pinned: false, firstAt: now, lastAt: now });
  kvPut('favorites', JSON.stringify({ v: 1, list: [
    entry(songs.fav, 6),
    entry({ ...songs.fav, id: 'it:999000001', title: 'Zebra Crossing Song' }, 9),
    entry({ ...songs.fav, id: 'it:999000002', title: 'Loud Song', explicit: 'explicit' }, 9),
  ] }));
  // Settings after the seeding (a settings change reads the favorites, and the room keeps them a minute).
  await hostSettings(host, { ai: false, counts: true, max: 6, credits: 5, words: 'zebra', maxLen: false });
  await hostState(host, (s) => !s.settings.aiCheck && s.settings.startingCredits === 5 && s.settings.blocklist.includes('zebra'));

  const cy = await rawSocket(roomId, { role: 'student', device: devices.cy, nick: 'Cy' });
  const dee = await rawSocket(roomId, { role: 'student', device: devices.dee, nick: 'Dee' });
  const eli = await rawSocket(roomId, { role: 'student', device: devices.eli, nick: 'Eli' });
  raws.push(cy, dee, eli);
  const ava = await openPage('ava', `?code=${code}`);
  pages.push(ava);
  await ava.page.fill('#code', code);
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');

  // ⭐ Class favorites on the student page: blocked and explicit songs are left out.
  const favMsg = await until(() => lastOf(ava, 'favorites'));
  check('favorites: the student gets the list on connect', Array.isArray(favMsg?.list));
  check('favorites: blocked-word and explicit songs never reach the page', favMsg.list.length === 1 && favMsg.list[0].song.id === songs.fav.id
    && !JSON.stringify(ava.msgs.filter((m) => m.t === 'favorites')).includes('Zebra'), JSON.stringify(favMsg.list.map((f) => f.song.title)));
  check('favorites: the Search / Class favorites switch shows', await visible(ava, '#findBy'));

  // Songs, votes, play.
  const sug = async (s, song) => s.ask({ t: 'suggest', song: song.id }, (m) => m.t === 'suggested' && m.song === song.id);
  check('suggest A1, A2 (Cy) and B1 (Dee)', (await sug(cy, songs.a1))?.ok && (await sug(cy, songs.a2))?.ok && (await sug(dee, songs.b1))?.ok);
  const q = await hostState(host, (s) => s.queue.length === 3);
  const item = (song) => q.queue.find((x) => x.song.id === song.id).id;
  dee.send({ t: 'vote', id: item(songs.a1), v: 1 });
  eli.send({ t: 'vote', id: item(songs.a1), v: 1 });
  eli.send({ t: 'vote', id: item(songs.a2), v: 1 });
  cy.send({ t: 'vote', id: item(songs.b1), v: -1 });
  await hostState(host, (s) => s.queue.find((x) => x.id === item(songs.a1))?.score === 2);
  await ava.page.click(`#queue li[data-id="${item(songs.a1)}"] button[data-act="up"]`);
  check('votes: A1 +3, A2 +1, B1 -1', Boolean(await hostState(host, (s) => s.queue[0]?.id === item(songs.a1) && s.queue[0].score === 3
    && s.queue[1].score === 1 && s.queue[2].score === -1)));

  await host.page.click('#startBtn');
  check('play: A1 plays first', Boolean(await hostState(host, (s) => s.nowPlaying?.song.id === songs.a1.id)));
  const top5a = lastState(host).top5;
  check('top 5: a song counts from when it starts playing (+3)', top5a.length === 1 && top5a[0].score === 3 && top5a[0].by === 'Cy', JSON.stringify(top5a));
  await finishSong(host); // A1 finished (+3): a favorite now
  check('play: A1 finished, A2 plays', lastState(host).nowPlaying?.song.id === songs.a2.id);
  // 👍 on the song playing (protocol.js VOTES): Ava's Now playing card; Eli's 👍 from the queue stays.
  const a2Id = item(songs.a2);
  const nowUpText = async (p, sel) => (await p.page.locator(sel).textContent().catch(() => '')).trim();
  check('playing 👍: the student card shows the count (1, from the queue)', Boolean(await until(async () => (await nowUpText(ava, '#nowUp .n')) === '1')));
  await ava.page.click('#nowUp');
  check('playing 👍: the host gets +2', Boolean(await hostState(host, (s) => s.nowPlaying?.id === a2Id && s.nowPlaying.up === 2 && s.nowPlaying.score === 2)));
  check('playing 👍: the student card shows 2, pressed', Boolean(await until(async () => (await nowUpText(ava, '#nowUp .n')) === '2'
    && (await ava.page.getAttribute('#nowUp', 'aria-pressed')) === 'true')), await nowUpText(ava, '#nowUp .n'));
  check('playing 👍: the host page shows 👍 2', Boolean(await until(async () => (await nowUpText(host, '#nowPlaying .now-votes .n')) === '2')));
  check('playing 👍: the Top 5 follows while it plays', lastState(host).top5.find((t) => t.id === a2Id)?.score === 2);
  const down = await cy.ask({ t: 'vote', id: a2Id, v: -1 }, (m) => m.t === 'error');
  check('playing 👎: refused with the message', down?.error === 'playing_down' && down.message === 'You can only give a 👍 to the song playing now.', JSON.stringify(down));
  await ava.page.click('#nowUp'); // votes are final (protocol.js VOTES ARE FINAL)
  check('playing 👍: a second click says votes are final and keeps the 👍', Boolean(await until(async () => (await ava.page.textContent('#toasts')).includes('Votes are final.')))
    && (await ava.page.getAttribute('#nowUp', 'aria-pressed')) === 'true' && Boolean(await hostState(host, (s) => s.nowPlaying?.up === 2)));
  await host.page.click('#skipBtn'); // A2 skipped
  check('play: Skip, B1 plays', Boolean(await hostState(host, (s) => s.nowPlaying?.song.id === songs.b1.id)));
  await finishSong(host);
  const afterPlays = await hostState(host, (s) => !s.nowPlaying && s.top5.length === 3);
  check('top 5: order by net score (A1, A2, B1)', afterPlays && afterPlays.top5.map((t) => t.song.id).join() === [songs.a1, songs.a2, songs.b1].map((s) => s.id).join(),
    JSON.stringify(lastState(host).top5.map((t) => [t.song.title, t.score])));
  const a2Top = afterPlays?.top5.find((t) => t.id === a2Id);
  check('top 5: A2 counts with its final votes (+2, the 👍 given while it played)', a2Top?.score === 2 && a2Top.up === 2, JSON.stringify(a2Top));

  await host.page.click(await reveal(host.page, '#top5Btn'));
  await host.page.waitForSelector('#top5Dlg[open]');
  const rows = await host.page.$$eval('#top5List li', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  check('host: the Top 5 dialog lists 3 songs with 👑 on #1', rows.length === 3 && rows[0].startsWith('👑') && rows[0].includes(songs.a1.title) && rows[1].startsWith('2'), rows.join(' | '));
  await host.page.click('#top5Dlg button[value="done"]');
  check('student: the "Top 5 so far" card shows 👑 on #1', Boolean(await until(async () => (await visible(ava, '#top5Card'))
    && (await text(ava, '#top5 li:first-child')).includes('👑') && (await text(ava, '#top5 li:first-child')).includes(songs.a1.title))));

  // A1 finished at +3: it is a favorite. The student's list marks it played.
  const favs2 = await until(() => {
    const m = lastOf(ava, 'favorites');
    return m?.list.some((f) => f.song.id === songs.a1.id) ? m : null;
  });
  check('favorites: a song that finished at +2 or more joins (students are told)', Boolean(favs2));
  await ava.page.click('#findFav');
  check('favorites: the tab shows the list, search hides', Boolean(await until(async () => (await visible(ava, '#favResults')) && !(await visible(ava, '#q')))));
  check('favorites: a played favorite says "Played already"', Boolean(await until(async () => (await text(ava, `#favResults li[data-id="${songs.a1.id}"] button`)) === 'Played already')));

  // Suggest from the favorites: the server path, a credit spent; it plays at once (music started, nothing playing).
  const credBefore = lastState(ava).you.credits;
  const n0 = ava.msgs.length;
  await ava.page.click(`#favResults li[data-id="${songs.fav.id}"] button[data-act="suggest"]`);
  const favSug = await until(() => ava.msgs.slice(n0).find((m) => m.t === 'suggested' && m.song === songs.fav.id), { timeout: 30_000 });
  check('favorites: Suggest goes through the server and the song joins', favSug?.ok === true, JSON.stringify(favSug));
  check('favorites: ... and costs a credit', Boolean(await until(() => lastState(ava)?.you.credits === credBefore - 1)), `${credBefore} → ${lastState(ava)?.you.credits}`);
  check('favorites: it plays', Boolean(await hostState(host, (s) => s.nowPlaying?.song.id === songs.fav.id)));

  // Host ⭐ Favorites: pin and remove reach the student.
  await host.page.click(await reveal(host.page, '#favBtn'));
  await host.page.waitForSelector('#favDlg[open]');
  check('host: the Favorites dialog lists every song (also the ones students do not see)', Boolean(await until(async () => (await host.page.locator('#favList li[data-id]').count()) === 4)));
  await host.page.click(`#favList li[data-id="${songs.fav.id}"] button[data-act="pin"]`);
  check('pin: the student list has it first with 📌', Boolean(await until(() => {
    const m = lastOf(ava, 'favorites');
    return m?.list[0]?.song.id === songs.fav.id && m.list[0].pinned;
  })) && Boolean(await until(async () => (await text(ava, '#favResults li:first-child')).includes('📌'))));
  await host.page.click(`#favList li[data-id="${songs.a1.id}"] button[data-act="remove"]`);
  await host.page.waitForSelector('#confirm[open]');
  await host.page.click('#confirm button[value="ok"]');
  check('remove: the song leaves the student list', Boolean(await until(() => lastOf(ava, 'favorites')?.list.every((f) => f.song.id !== songs.a1.id))));
  await host.page.click('#favDlg button[value="done"]');

  // 🎨 No back-to-back artist.
  await hostSettings(host, { backToBack: true });
  await hostState(host, (s) => s.settings.noBackToBackArtist);
  check('artist: TS1 joins', (await sug(dee, songs.ts1))?.ok === true);
  const qTs = await hostState(host, (s) => s.queue.length === 1);
  eli.send({ t: 'vote', id: qTs.queue[0].id, v: 1 });
  await hostState(host, (s) => s.queue[0]?.score === 1);
  await finishSong(host); // Mr. Blue Sky done → TS1 plays
  check('artist: TS1 plays', lastState(host).nowPlaying?.song.id === songs.ts1.id);
  check('artist: TS2 (Eli) and Billie Jean (Cy) join', (await sug(eli, songs.ts2))?.ok && (await sug(cy, songs.mj))?.ok);
  const qb = await hostState(host, (s) => s.queue.length === 2);
  const ts2Item = qb.queue.find((x) => x.song.id === songs.ts2.id).id;
  dee.send({ t: 'vote', id: ts2Item, v: 1 });
  cy.send({ t: 'vote', id: ts2Item, v: 1 });
  const shown = await hostState(host, (s) => s.queue.find((x) => x.id === ts2Item)?.score === 2);
  check('no back-to-back: the queue shows the other artist first, though TS2 has more votes', shown?.queue[0].song.id === songs.mj.id, JSON.stringify(shown?.queue.map((x) => [x.song.title, x.score])));
  await finishSong(host);
  check('no back-to-back: Billie Jean plays after Coldplay', lastState(host).nowPlaying?.song.id === songs.mj.id);

  // 🎨 One song per artist (TS2 is waiting): refused, nothing charged; the page says so too.
  await hostSettings(host, { onePerArtist: true });
  await hostState(host, (s) => s.settings.oneSongPerArtist);
  const cyBefore = lastState(host).students.find((x) => x.nick === 'Cy').credits;
  const same = await sug(cy, songs.ts3);
  check('one per artist: refused with same_artist and the 🎨 why', same?.ok === false && same.reason === 'same_artist'
    && same.why?.id === 'same_artist' && same.why.evidence === 'A song by Coldplay is already waiting.', JSON.stringify(same));
  await wait(300);
  check('one per artist: nothing charged', lastState(host).students.find((x) => x.nick === 'Cy').credits === cyBefore);
  await ava.page.click('#findSearch');
  await ava.page.fill('#q', 'Clocks Coldplay');
  await ava.page.press('#q', 'Enter');
  check('one per artist: the student page says "🎨 Artist waiting" with a Why?', Boolean(await until(async () => {
    const b = ava.page.locator(`#results li[data-id="${songs.ts3.id}"] button[data-act="suggest"]`);
    return (await b.count()) && (await b.textContent()) === '🎨 Artist waiting' && (await ava.page.locator(`#results li[data-id="${songs.ts3.id}"] button.why`).count()) === 1;
  }, { timeout: 15_000 })));

  // Cleanup mode: the Top 5 board under the banner, with a Play recap button.
  const hostWs = await rawSocket(roomId, { role: 'host', token });
  raws.push(hostWs);
  hostWs.send({ t: 'cleanup', on: true });
  check('cleanup: the Top 5 board shows under the banner with 👑', Boolean(await until(async () => (await visible(host, '#top5Board'))
    && (await text(host, '#top5BoardList li:first-child')).includes('👑'))) && (await visible(host, '#cleanupRecap')));
  await host.page.click(await reveal(host.page, '#bigBtn'));
  check('cleanup: on the big screen too', await visible(host, '#top5Board') && await visible(host, '#cleanupRecap'));
  await shot(host, 'cleanup-board');
  await host.page.click(await reveal(host.page, '#bigBtn'));
  hostWs.send({ t: 'cleanup', on: false });
  await hostState(host, (s) => !s.cleanup);

  // The recap card.
  await host.page.click(await reveal(host.page, '#top5Btn'));
  await host.page.click('#recapBtn');
  await host.page.waitForSelector('#recapDlg[open] .recap-vs', { timeout: 10_000 });
  const vs = (await text(host, '#recapDlg .recap-vs')).replace(/\s+/g, ' ');
  check('recap: the versus card (Top contributor Cy, 3 songs; Top voter Eli, 3 votes)', /Top contributor ?Cy ?3 songs suggested/.test(vs) && /Top voter ?Eli ?3 votes cast/.test(vs), vs);
  const funs = await host.page.locator('#recapDlg .recap-fun').count();
  check('recap: 3 or 4 fun stats', funs >= 3 && funs <= 4, String(funs));
  check('recap: Top 5 and songs in order', (await host.page.locator('#recapDlg .recap-top5 li').count()) === 5
    && (await host.page.locator('#recapDlg .recap-songs li').count()) === 6);
  const before = await host.page.$$eval('#recapDlg .recap-fun', (els) => els.map((e) => e.dataset.stat).join());
  let changed = false;
  for (let i = 0; i < 6 && !changed; i++) {
    await host.page.click('#recapMore');
    changed = (await host.page.$$eval('#recapDlg .recap-fun', (els) => els.map((e) => e.dataset.stat).join())) !== before;
  }
  check('recap: 🎲 More stats shows other ones', changed);
  await host.page.click('#recapCopy');
  const copied = await until(() => host.page.evaluate(() => navigator.clipboard.readText()).catch(() => ''));
  check('recap: Copy recap has the totals, Top 5, the versus line and the shown stats', /6 songs played/.test(copied) && /🏆 Top 5/.test(copied)
    && /🎤 Top contributor: Cy \(3 songs suggested\) vs 🗳 Top voter: Eli \(3 votes cast\)/.test(copied), copied.slice(0, 300));

  // ▶ Play recap: the show.
  const roomMusicBefore = await host.page.evaluate(() => window.__audios.some((a) => !a.paused && a.src));
  const recapMsg = lastOf(host, 'recap')?.recap;
  const firstPreview = recapMsg?.top5?.find((t) => t.previewUrl)?.previewUrl ?? '';
  check('recap: the host recap has the Top 5 previews (for the recap music)', recapMsg?.top5?.[0]?.previewUrl === firstPreview && /^https:\/\/[^/]*(itunes\.apple\.com|mzstatic\.com)\//.test(firstPreview), firstPreview);
  await host.page.click('#recapPlay');
  await host.page.waitForSelector('#showDlg[open]');
  // 🎵 Recap music (protocol.js RECAP MUSIC): the room music pauses, the #1 song's preview plays.
  const recapMusic = () => host.page.evaluate(() => ({
    state: document.querySelector('#recapMusic').dataset.state ?? '',
    playing: [...document.querySelectorAll('#recapMusic audio')].filter((a) => !a.paused).map((a) => a.src),
    room: window.__audios.filter((a) => !a.paused && a.src).length,
  }));
  check('recap music: the #1 song preview plays in #recapMusic', Boolean(await until(async () => {
    const m = await recapMusic();
    return m.state === 'playing' && m.playing.includes(firstPreview);
  }, { timeout: 10_000 })), JSON.stringify(await recapMusic()));
  check('recap music: the room music is paused during the show', (await recapMusic()).room === 0 && (await text(host, '#playBtn')).includes('Play'),
    JSON.stringify({ before: roomMusicBefore, now: await recapMusic() }));
  const kind = () => host.page.getAttribute('#showDlg', 'data-kind');
  const slide = async () => Number(await host.page.getAttribute('#showDlg', 'data-slide'));
  check('show: opens on the title card', (await kind()) === 'title' && (await text(host, '#showStage')).includes('Period recap!'));
  check('show: auto-advances to an award slide', Boolean(await until(async () => (await slide()) === 1, { timeout: 8000 })) && (await kind()) === 'stat');
  check('show: the reveal comes after a beat, with confetti', Boolean(await until(async () => (await host.page.getAttribute('#showDlg', 'data-revealed')) === '1', { timeout: 4000 }))
    && (await host.page.locator('#showStage .show-confetti i').count()) > 0);
  await host.page.keyboard.press('Space');
  check('show: Space pauses', (await host.page.getAttribute('#showDlg', 'data-paused')) === '1');
  await wait(6500);
  check('show: ... and it stays put while paused', (await slide()) === 1);
  await host.page.keyboard.press('Space');
  await host.page.keyboard.press('ArrowRight');
  check('show: → moves on', (await slide()) === 2);
  await host.page.keyboard.press('ArrowLeft');
  check('show: ← goes back', (await slide()) === 1);
  for (let i = 0; i < 20; i++) await host.page.keyboard.press('ArrowRight');
  check('show: the finale is the versus card', (await kind()) === 'versus' && /VS/.test(await text(host, '#showStage')));
  await host.page.keyboard.press('ArrowLeft');
  check('show: before the finale, the Top 5 #1 with 👑', (await kind()) === 'top5' && (await text(host, '#showStage')).includes('👑'));
  const top5Slides = [];
  for (let i = 0; i < 5; i++) {
    await host.page.keyboard.press('ArrowLeft');
    top5Slides.push(await host.page.getAttribute('#showDlg', 'data-kind'));
  }
  check('show: the Top 5 counts down over 5 slides', top5Slides.slice(0, 4).every((k) => k === 'top5') && top5Slides[4] === 'stat', top5Slides.join());
  await host.page.keyboard.press('Escape');
  check('show: Esc closes it', Boolean(await until(async () => !(await host.page.locator('#showDlg[open]').count()))));
  check('recap music: it fades out and stops after the show', Boolean(await until(async () => {
    const m = await recapMusic();
    return m.state === '' && m.playing.length === 0;
  }, { timeout: 5000 })), JSON.stringify(await recapMusic()));
  check('recap music: the room music was playing, and it comes back after the show', roomMusicBefore
    && Boolean(await until(async () => (await recapMusic()).room > 0, { timeout: 8000 })), JSON.stringify({ before: roomMusicBefore, now: await recapMusic() }));

  // Reduced motion: no confetti.
  await host.page.emulateMedia({ reducedMotion: 'reduce' });
  await host.page.click(await reveal(host.page, '#top5Btn'));
  await host.page.click('#playRecapBtn');
  await host.page.waitForSelector('#showDlg[open]');
  await host.page.keyboard.press('ArrowRight');
  await until(async () => (await host.page.getAttribute('#showDlg', 'data-revealed')) === '1', { timeout: 4000 });
  await wait(200);
  check('show (reduced motion): the reveal, but no confetti', (await host.page.getAttribute('#showDlg', 'data-revealed')) === '1'
    && (await host.page.locator('#showStage .show-confetti').count()) === 0);
  await shot(host, 'show');
  await host.page.click('#showClose');
  await host.page.emulateMedia({ reducedMotion: 'no-preference' });

  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));

  // Close: the recap comes to the host page; the period's Top 5 count once more in KV (songs only).
  await host.page.click(await reveal(host.page, '#closeBtn'));
  await host.page.waitForSelector('#confirm[open]');
  await host.page.click('#confirm button[value="ok"]');
  await until(() => visible(host, '#closedScreen'));
  check('close: the closed screen offers the Class recap', Boolean(await until(() => visible(host, '#closedRecap'))));
  await host.page.click('#closedRecap');
  check('close: ... and it shows', Boolean(await until(() => host.page.locator('#recapDlg[open] .recap-vs').count())));
  await wait(500);
  const kv = kvGet('favorites') ?? '';
  const a1 = JSON.parse(kv || '{}').list?.find((e) => e.song.id === songs.a1.id);
  check('close: A1 (Top 5, +3, finished) is back in the favorites with 1 Top 5', a1?.top5 === 1, JSON.stringify(a1));
  check('KV favorites: songs only (no nickname, no device id)', kv && !['Ava', '"Cy"', 'Dee', 'Eli', 'favtest-device', '"by"', '"device"'].some((x) => kv.includes(x)));
} catch (e) {
  failures++;
  console.log(`FAIL favorites stopped: ${e?.stack ?? e}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  for (const r of raws) r.ws.close();
  const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) });
  if (!r.ok) console.log('FAIL could not put the saved teacher settings back');
  try {
    if (savedFavorites) kvPut('favorites', savedFavorites);
    else kvDelete('favorites');
  } catch (e) {
    console.log(`FAIL could not put the local KV favorites back: ${e.message}`);
  }
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
