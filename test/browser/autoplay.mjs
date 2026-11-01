// Browser test of 🎲 Autoplay (shared/autoplay.js): one host page in installed Chrome (playwright-core)
// plus a plain host WebSocket, against a LOCAL wrangler dev only.
//   npm run dev, then in another shell: npm run test:autoplay
// Covers: the saved choice reaches a new room; Settings shows the switch and a tick box per list
// (no Gospel box while that list is off); nothing autoplays before Start; Start with an empty queue
// adds a ✓ Checked song by 🎲 RoomDJ that plays; off keeps an empty room quiet. The teacher's saved
// settings are put back at the end.

import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

async function openPage(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.addInitScript(() => { if (!localStorage.getItem('cq.theme')) localStorage.setItem('cq.theme', 'system'); }); // emulateMedia decides (default is Dark)
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
const visible = (p, sel) => p.page.locator(sel).isVisible();
const text = async (p, sel) => (await p.page.locator(sel).textContent()) ?? '';
const shot = (p, label) => p.page.screenshot({ path: `${OUT}autoplay-${label}-${p.name}.png` }).catch(() => {});
async function stateOf(p, pred, timeout = 10_000) {
  return until(() => {
    const s = lastState(p);
    return s && pred(s) ? s : null;
  }, { timeout });
}

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

let searches = 0;
async function findSong(roomId, q) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    const probe = ['focustest-device-probe1', 'focustest-device-probe2'][searches++ % 2];
    const r = await fetch(new URL(`api/rooms/${roomId}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': probe } });
    const data = await r.json();
    if (data.results?.[0]) return data.results[0];
    last = `${r.status} ${JSON.stringify(data).slice(0, 300)}`;
    await wait(2000);
  }
  throw new Error(`no search result for ${q}: ${last}`);
}
async function apiJoin(code, device) {
  const r = await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  return r.status;
}

/**
 * 📐 Where the back-to-work card sits (page scrolled to the top): the title bar's bottom, the card's
 * top and bottom, the footer's top, and any element between the title bar and the card taller than
 * 120 px (an empty block pushing the card down).
 */
const restGap = (page) => page.evaluate(() => {
  window.scrollTo(0, 0);
  const header = document.querySelector('header.titlebar').getBoundingClientRect();
  const card = document.querySelector('#restScreen').getBoundingClientRect();
  const footer = document.querySelector('footer.footer').getBoundingClientRect();
  const bigEmpty = [];
  for (const el of document.querySelectorAll('#main *')) {
    const r = el.getBoundingClientRect();
    if (r.height > 120 && r.top >= header.bottom - 1 && r.bottom <= card.top + 1) bigEmpty.push(`${el.tagName.toLowerCase()}#${el.id} ${Math.round(r.height)}px`);
  }
  const px = (n) => Math.round(n);
  return { headerBottom: px(header.bottom), cardTop: px(card.top), cardBottom: px(card.bottom), footerTop: px(Math.min(footer.top, innerHeight)), bigEmpty };
});

/** The student page's view: 'rest' (the back-to-work card), 'room' (search + queue), or another. */
const view = (p) => p.page.evaluate(() => {
  const shown = (sel) => { const el = document.querySelector(sel); return Boolean(el && !el.hidden && el.offsetParent !== null); };
  if (shown('#restScreen') && !shown('#q') && !shown('#queue')) return 'rest';
  if (!shown('#restScreen') && shown('#q')) return 'room';
  return `other(rest ${shown('#restScreen')}, q ${shown('#q')}, queue ${shown('#queue')})`;
});


const savedDefaults = await (await api('/api/teacher/settings')).json();
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, autoplay: true, autoplayShelves: ['pop', 'rock'] }) });
const pages = [];
const raws = [];
try {
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.check('input[name="openEnd"][value="day"]');
  await host.page.fill('#openCleanup', '');
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { room: roomId, token } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const first = await stateOf(host, () => true);
  check('a new room carries the saved autoplay choice', first.settings.autoplay === true && first.settings.autoplayShelves.join() === 'pop,rock', JSON.stringify(first.settings.autoplayShelves));

  // By Background music: the 🎲 Autoplay button opens its panel, a tick box per list (Gospel hidden while its switch is off).
  check('the button says Autoplay is on', (await host.page.textContent('#autoplayEdit'))?.includes('On'));
  await host.page.click('#autoplayEdit');
  check('panel: 🎲 Autoplay is on, its lists show, Pop and Rock ticked', await host.page.isChecked('#setAutoplay')
    && (await visible(host, '#autoplayLists')) && await host.page.isChecked('#autoplayLists input[value="pop"]')
    && await host.page.isChecked('#autoplayLists input[value="rock"]') && !(await host.page.isChecked('#autoplayLists input[value="country"]')));
  check('panel: no Gospel box while the Gospel list is off', !(await visible(host, '#autoplayLists [data-shelf="gospel"]')));
  // A tick saves at once: the room and the teacher's saved settings both get Country.
  await host.page.check('#autoplayLists input[value="country"]');
  const ticked = await stateOf(host, (s) => s.settings.autoplayShelves.includes('country'));
  check('a tick saves to the room at once', Boolean(ticked), JSON.stringify(lastState(host)?.settings?.autoplayShelves));
  let saved = null;
  for (let i = 0; i < 20 && !saved?.autoplayShelves?.includes('country'); i++) {
    await host.page.waitForTimeout(250);
    saved = await (await api('/api/teacher/settings')).json();
  }
  check('and to the saved settings for the next room', saved?.autoplayShelves?.includes('country'), JSON.stringify(saved?.autoplayShelves));
  await host.page.click('#autoplayDone');
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  await host.page.setChecked(await reveal(host.page, '#setAi'), false);
  await host.page.click('#applySettings');
  await stateOf(host, (s) => !s.settings.aiCheck);
  check('saving Settings keeps Autoplay as it was', lastState(host)?.settings?.autoplay === true && lastState(host).settings.autoplayShelves.includes('country'));
  const hostWs = await rawSocket(roomId, { role: 'host', token });
  raws.push(hostWs);
  hostWs.send({ t: 'settings', settings: { blockUnknownSongs: false, cooldownDays: null, maxSongMinutes: null, autoplay: true, autoplayShelves: ['pop', 'rock'] } });
  await stateOf(host, (s) => s.settings.blockUnknownSongs === false);

  // Start music with an empty queue: autoplay adds a song, by 🎲 RoomDJ, and it plays.
  check('before Start: nothing autoplays (the music is not started)', !(await stateOf(host, (s) => s.queue.length || s.nowPlaying, 3000)));
  await host.page.click('#startBtn');
  const picked = await stateOf(host, (s) => [s.nowPlaying, ...s.queue].some((q) => q?.autoplay), 30_000);
  const item = picked && [picked.nowPlaying, ...picked.queue].find((q) => q?.autoplay);
  check('Start with an empty queue: autoplay adds a song by RoomDJ', item?.by === 'RoomDJ' && item.teacher === true, JSON.stringify(item ?? lastState(host)));
  check('the teacher hears which song', Boolean(await until(async () => (await text(host, '#toasts')).includes('🎲 Autoplay:'))), await text(host, '#toasts'));
  check('it is from a ticked list and plays', Boolean(await stateOf(host, (s) => s.nowPlaying?.autoplay === true, 20_000)));
  check('the page labels it 🎲 RoomDJ', Boolean(await until(async () => (await text(host, '#hostScreen')).includes('🎲 RoomDJ'))));
  await shot(host, 'playing');

  // Off: an empty room stays quiet.
  hostWs.send({ t: 'settings', settings: { blockUnknownSongs: false, cooldownDays: null, maxSongMinutes: null, autoplay: false } });
  await stateOf(host, (s) => s.settings.autoplay === false);
  hostWs.send({ t: 'next', from: lastState(host).nowPlaying?.id ?? null });
  check('autoplay off: the room stays empty after the song', Boolean(await stateOf(host, (s) => !s.nowPlaying && s.queue.length === 0, 10_000))
    && !(await stateOf(host, (s) => s.nowPlaying || s.queue.length, 4000)));

  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
  hostWs.send({ t: 'close' });
  await wait(500);
} catch (e) {
  failures++;
  console.log(`FAIL autoplay stopped: ${e?.stack ?? e}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  for (const r of raws) r.ws.close();
  const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) });
  if (!r.ok) console.log('FAIL could not put the saved teacher settings back');
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
