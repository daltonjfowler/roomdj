// Browser test of ▶ Play again (protocol.js 'replay'; Dalton 2026-11-16: "if something happens like a glitch or
// accidental skip I want to ... select an already played song, and replay it"). One host page plus a raw host
// socket, in installed Chrome (playwright-core), against a LOCAL wrangler dev only.
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:replay               (or: node test/browser/replay.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. No Workers AI call (the AI check is off). The repeat
// cooldown is ON (1 day) while it runs, so a finished song is both played and resting; Teacher 1's saved
// settings and KV `recent` go back at the end. Searches hit the real iTunes API; music is iTunes previews.
// Covers: a finished song is refused as played (and rests); 😴 Resting songs → 🔁 Played in this class lists it
// with ▶ Play again; Play again puts it first in the queue (pushed) and the row says it is back; the room's
// played list and rest record let it in; a song that never played is refused (no_item).

import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { songKey } from '../../shared/repeats.js';
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
async function until(fn, { timeout = 10_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}
const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  const Native = window.Audio;
  window.__audios = [];
  window.Audio = function Audio(...args) {
    const a = new Native(...args);
    window.__audios.push(a);
    return a;
  };
});
const host = { page, msgs: [], errors: [] };
page.on('pageerror', (e) => host.errors.push(String(e)));
page.on('websocket', (ws) => ws.on('framereceived', (f) => { try { host.msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ } }));
const lastState = () => [...host.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const hostState = (pred, timeout = 10_000) => until(() => { const s = lastState(); return s && pred(s) ? s : null; }, { timeout });

async function rawSocket(roomId, params) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}api/rooms/${roomId}/ws?${new URLSearchParams(params)}`);
  const s = { ws, msgs: [] };
  ws.addEventListener('message', (e) => { try { s.msgs.push(JSON.parse(e.data)); } catch { /* not JSON */ } });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  s.ask = async (msg, pred, timeout = 30_000) => {
    const n = s.msgs.length;
    ws.send(JSON.stringify(msg));
    return until(() => s.msgs.slice(n).find(pred), { timeout });
  };
  return s;
}

const savedDefaults = await (await api('/api/teacher/settings')).json();
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: 1, backToWork: false }) });
let rawHost = null;
try {
  await page.goto(new URL('host/', BASE).href);
  await page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(page, KEY);
  await page.click('#openBtn');
  await page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsDlg[open]');
  const ai = await reveal(page, '#setAi').catch(() => null);
  if (ai) await page.setChecked(ai, false);
  await page.click('#applySettings');
  await hostState((s) => !s.settings.aiCheck);

  rawHost = await rawSocket(saved.room, { role: 'host', token: saved.token });
  const songs = [];
  for (const q of ['Lovely Day Bill Withers', 'Here Comes the Sun Beatles']) {
    const res = await rawHost.ask({ t: 'search', q }, (m) => m.t === 'searchResults' && m.q === q);
    const song = res?.results?.find((r) => r.previewUrl);
    if (!song) throw new Error(`no result for ${q}`);
    // a song resting from an earlier run is woken first
    await rawHost.ask({ t: 'wake', key: songKey(song) }, (m) => m.t === 'restingAll', 5_000);
    const ok = await rawHost.ask({ t: 'suggest', song: song.id }, (m) => m.t === 'suggested' && m.song === song.id);
    if (!ok?.ok && ok?.reason === 'resting') throw new Error(`${q} is resting from an earlier run: clear Teacher 1's local KV recent`);
    if (!ok?.ok) throw new Error(`suggest ${q} failed: ${JSON.stringify(ok)}`);
    songs.push(song);
  }
  await hostState((s) => s.queue.length === 2, 30_000);
  await page.click('#startBtn');
  const sPlay = await hostState((s) => s.nowPlaying && s.queue.length === 1);
  const first = sPlay.nowPlaying;
  await until(() => page.evaluate(() => window.__audios.some((a) => a.src && !a.paused && a.duration > 0)), { timeout: 15_000 });
  await page.evaluate(() => { const a = window.__audios.find((x) => x.src && !x.paused); a.currentTime = Math.max(0, (a.duration || 30) - 0.3); });
  check('the first song finishes and the next plays', Boolean(await hostState((s) => s.nowPlaying && s.nowPlaying.id !== first.id, 15_000)));

  const again = await rawHost.ask({ t: 'suggest', song: first.song.id }, (m) => m.t === 'suggested' && m.song === first.song.id);
  check('suggesting it again: refused as played', again?.ok === false && again.reason === 'played', JSON.stringify(again));

  // the dialog: 📋 Lists → 😴 Resting songs → 🔁 Played in this class
  await page.click(await reveal(page, '#restBtn'));
  await page.waitForSelector('#favDlg[open]');
  const row = `#replayList li[data-id="${first.song.id}"]`;
  check('🔁 lists the finished song with ▶ Play again', Boolean(await until(() => page.locator(`${row} button[data-act="replay"]`).count())));
  check('the resting list shows it too (cooldown 1 day)', Boolean(await until(async () => (await page.textContent('#restList')).includes(first.song.title))));
  await page.screenshot({ path: `${OUT}replay-dialog.png` });
  await page.click(`${row} button[data-act="replay"]`);
  const sBack = await hostState((s) => s.queue[0]?.song.id === first.song.id, 20_000);
  check('▶ Play again: the song is first in the queue', Boolean(sBack), JSON.stringify(lastState()?.queue.map((q) => q.song.title)));
  check('▶ Play again: it is pushed (plays next)', Number.isFinite(sBack?.queue[0].pushed?.at));
  check('the row now says it is back in the queue', Boolean(await until(async () => (await page.textContent(row)).includes('back in the queue') && (await page.locator(`${row} button`).count()) === 0)));
  await page.screenshot({ path: `${OUT}replay-after.png` });

  const nope = await rawHost.ask({ t: 'replay', id: 'it:1' }, (m) => m.t === 'error');
  check('a song that never played: refused', nope?.error === 'no_item', JSON.stringify(nope));
  await page.keyboard.press('Escape');

  // ⛔ Ban from search (protocol.js 'banSearch'): Teacher 1's local ban list is put back afterwards.
  const KVX = new URL('cdn-cgi/local/explorer/api/storage/kv/namespaces/04009b6989154b8797be4834bc16b64d/', BASE).href;
  const bannedBefore = await (await fetch(`${KVX}values/banned`)).text().catch(() => '');
  try {
    await page.click('#suggestBtn');
    await page.waitForSelector('#suggestDlg[open]');
    await page.fill('#tq', 'Dancing Queen ABBA');
    await page.press('#tq', 'Enter');
    const banBtn = '#tResults li button[data-act="tban"]';
    check('search results have ⛔ Ban', Boolean(await until(() => page.locator(banBtn).count(), { timeout: 20_000 })));
    const abba = page.locator('#tResults li').filter({ has: page.locator('.song-artist', { hasText: /^\s*ABBA\s*$/ }) }).first();
    const target = await abba.getAttribute('data-id');
    await abba.locator('button[data-act="tban"]').click();
    await page.click('#confirm button[value="ok"]');
    check('⛔ Ban: the row leaves the results', Boolean(await until(async () => (await page.locator(`#tResults li[data-id="${target}"]`).count()) === 0)));
    const left = await page.$$eval('#tResults li', (els) => els.map((li) => `${li.querySelector('.song-title')?.textContent}|${li.querySelector('.song-artist')?.textContent}`));
    check('⛔ Ban: no other version of it stays in the results', !left.some((x) => /^Dancing Queen/i.test(x) && /\|\s*ABBA\s*$/i.test(x)), JSON.stringify(left.slice(0, 6)));
    const list = await until(async () => { const t = await (await fetch(`${KVX}values/banned`)).text(); return t.includes(target.replace('it:', '')) || t.includes(target) ? t : null; });
    check('⛔ Ban: it is on the ban list', Boolean(list));
    const refused = await rawHost.ask({ t: 'suggest', song: target }, (m) => m.t === 'suggested' && m.song === target);
    check('⛔ Ban: suggesting it now is refused as banned', refused?.ok === false && refused.reason === 'banned', JSON.stringify(refused));
    await page.screenshot({ path: `${OUT}ban-search.png` });
  } finally {
    if (bannedBefore && !bannedBefore.includes('"success":false')) await fetch(`${KVX}values/banned`, { method: 'PUT', body: bannedBefore });
    else await fetch(`${KVX}values/banned`, { method: 'DELETE' });
  }
  check('no page errors', host.errors.length === 0, host.errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack ?? e}`);
} finally {
  try { rawHost?.ws.close(); } catch { /* closed */ }
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) }).catch(() => {});
  await page.evaluate(() => document.querySelector('#closeRoomBtn')?.click()).catch(() => {});
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
