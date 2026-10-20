// Browser test of the teacher's ⏫ Play next / ⏬ Undo and ▶ Play now (shared/protocol.js TEACHER
// PUSH). One host page, one student page, a board page, plus raw host and board sockets, in
// installed Chrome (playwright-core), against a LOCAL wrangler dev only.
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:teacher-push         (or: node test/browser/teacher-push.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override. No Workers
// AI call (the AI check is off). The repeat cooldown is off while it runs (the saved settings go back
// at the end). Searches hit the real iTunes API through the host page; music is iTunes previews.
// Covers: ⏫ on the bottom song → first, the "⏫ Teacher pick · plays next" tag on the host, the
// student page and the board; ⏬ Undo → the old order; pushed again, it plays next when the song
// playing ends; ▶ Play now (confirm) → plays at once, the song before counted as skipped, no double
// advance (a late Play now with an old `from` is ignored); the board socket cannot push; big screen
// hides the buttons.

import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PUSH_TAG } from '../../shared/protocol.js';
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

const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function openPage(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  // The preview player's <audio> is not in the page: keep a handle so the test can end a song.
  await page.addInitScript(() => {
    const Native = window.Audio;
    window.__audios = [];
    window.Audio = function Audio(...args) {
      const a = new Native(...args);
      window.__audios.push(a);
      return a;
    };
  });
  const p = { name, ctx, page, msgs: [], errors: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') p.errors.push(m.text()); });
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
const visible = (p, sel) => p.page.locator(sel).isVisible();
const text = (p, sel) => p.page.locator(sel).textContent().catch(() => '');
const shot = (p, label) => p.page.screenshot({ path: `${OUT}teacher-push-${label}-${p.name}.png` }).catch(() => {});
const ids = (s) => s.queue.map((q) => q.id);

async function hostState(host, pred, timeout = 10_000) {
  return until(() => {
    const s = lastState(host);
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
  s.ask = async (msg, pred, timeout = 30_000) => {
    const n = s.msgs.length;
    ws.send(JSON.stringify(msg));
    return until(() => s.msgs.slice(n).find(pred), { timeout });
  };
  return s;
}

const savedDefaults = await (await api('/api/teacher/settings')).json();
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false }) });
const pages = [];
let rawHost = null;
let rawBoard = null;
try {
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const saved = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const { classCode: code, room: roomId } = saved;
  // AI check off, credits off (a push is free either way).
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  await host.page.setChecked(await reveal(host.page, '#setAi'), false);
  await host.page.setChecked(await reveal(host.page, '#setCreditsOn'), false);
  await host.page.click('#applySettings');
  await hostState(host, (s) => !s.settings.aiCheck && s.settings.startingCredits === null);

  rawHost = await rawSocket(roomId, { role: 'host', token: saved.token });
  const link = await rawHost.ask({ t: 'boardLink' }, (m) => m.t === 'boardLink');
  const ava = await openPage('ava', `?code=${code}`);
  const board = await openPage('board', `board/#${roomId}.${link.token}`);
  pages.push(ava, board);
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');

  // Four songs (teacher picks through the room's own search: no student limit to think about).
  for (const q of ['Lovely Day Bill Withers', 'Walking on Sunshine Katrina and the Waves', 'Here Comes the Sun Beatles', 'Dancing Queen ABBA']) {
    const res = await rawHost.ask({ t: 'search', q }, (m) => m.t === 'searchResults' && m.q === q);
    const song = res?.results?.find((r) => r.previewUrl);
    if (!song) throw new Error(`no result for ${q}: ${JSON.stringify(res)?.slice(0, 200)}`);
    const ok = await rawHost.ask({ t: 'suggest', song: song.id }, (m) => m.t === 'suggested' && m.song === song.id);
    if (!ok?.ok) throw new Error(`suggest ${q} failed: ${JSON.stringify(ok)}`);
  }
  const s0 = await hostState(host, (s) => s.queue.length === 4, 30_000);
  check('four songs wait', Boolean(s0));

  // Start the music: the top song plays.
  await host.page.click('#startBtn');
  const sPlay = await hostState(host, (s) => s.nowPlaying && s.queue.length === 3);
  const first = sPlay.nowPlaying;
  check('a song plays', Boolean(first));
  check('the preview is playing (progress moves)', Boolean(await until(async () => parseFloat(await host.page.$eval('#progressBar', (e) => e.style.width || '0')) > 0, { timeout: 15_000 })));
  check('host rows have ⏫ and ▶ (no ⏬ yet)', (await host.page.locator('#queue button[data-act="push"]').count()) === 3
    && (await host.page.locator('#queue button[data-act="playNow"]').count()) === 3
    && (await host.page.locator('#queue button[data-act="unpush"]').count()) === 0);
  check('the song playing has no ⏫ (not in the queue list)', (await host.page.locator('#nowPlaying button[data-act="push"]').count()) === 0);
  await shot(host, 'rows');

  // ⏫ the bottom song: first everywhere, tagged.
  const before = ids(lastState(host));
  const bottom = before.at(-1);
  await host.page.click(await reveal(host.page, `#queue li[data-id="${bottom}"] button[data-act="push"]`));
  const sPushed = await hostState(host, (s) => s.queue[0]?.id === bottom);
  check('⏫: the bottom song is first', Boolean(sPushed), JSON.stringify(ids(lastState(host))));
  check('⏫: pushed.at in the snapshot', Number.isFinite(sPushed?.queue[0].pushed?.at));
  check('⏫: host row shows the tag and ⏬', Boolean(await until(async () => (await text(host, `#queue li[data-id="${bottom}"]`)).includes(PUSH_TAG)))
    && (await host.page.locator(`#queue li[data-id="${bottom}"] button[data-act="unpush"]`).count()) === 1);
  check('⏫: student page shows the tag, first in the list', Boolean(await until(async () => (await text(ava, `#queue li[data-id="${bottom}"]`)).includes(PUSH_TAG)
    && (await ava.page.$eval('#queue li', (li) => li.dataset.id)) === bottom)));
  check('⏫: board shows the tag', Boolean(await until(async () => (await text(board, '#queue')).includes(PUSH_TAG), { timeout: 15_000 })));
  await shot(host, 'pushed');
  await shot(ava, 'pushed');
  await shot(board, 'pushed');

  // ⏬ Undo: back to the old order, the tag gone.
  await host.page.click(await reveal(host.page, `#queue li[data-id="${bottom}"] button[data-act="unpush"]`));
  check('⏬: the old order is back', Boolean(await hostState(host, (s) => ids(s).join() === before.join())), JSON.stringify(ids(lastState(host))));
  check('⏬: the student tag is gone', Boolean(await until(async () => !(await text(ava, '#queue')).includes(PUSH_TAG))));
  check('⏬: the board tag is gone', Boolean(await until(async () => !(await text(board, '#queue')).includes(PUSH_TAG), { timeout: 15_000 })));

  // Pushed again: it plays next when the song playing ends.
  await host.page.click(await reveal(host.page, `#queue li[data-id="${bottom}"] button[data-act="push"]`));
  await hostState(host, (s) => s.queue[0]?.id === bottom);
  await host.page.evaluate(() => {
    const a = window.__audios.find((x) => x.src && !x.paused);
    a.currentTime = Math.max(0, (a.duration || 30) - 0.3);
  });
  const sNext = await hostState(host, (s) => s.nowPlaying?.id !== first.id, 15_000);
  check('the pushed song plays next when the song ends', sNext?.nowPlaying?.id === bottom, JSON.stringify(sNext?.nowPlaying?.song?.title));
  check('a playing song has no push tag', sNext?.nowPlaying?.pushed === null);
  check('the new song really plays', Boolean(await until(async () => host.page.evaluate(() => window.__audios.some((a) => a.src && !a.paused && a.currentTime > 0.2)), { timeout: 15_000 })));

  // ▶ Play now on the bottom song: confirm, it plays at once; the one before counts as skipped.
  const target = ids(lastState(host)).at(-1);
  const left = lastState(host).queue.length;
  const nowIds = new Set();
  const n0 = host.msgs.length;
  await host.page.click(await reveal(host.page, `#queue li[data-id="${target}"] button[data-act="playNow"]`));
  check('▶: a quick confirm names both songs', Boolean(await until(async () => (await visible(host, '#confirm')) && (await text(host, '#confirm')).includes('Stop "'))), await text(host, '#confirm'));
  await host.page.click('#confirm button[value="ok"]');
  const sNow = await hostState(host, (s) => s.nowPlaying?.id === target);
  check('▶: the chosen song plays at once', Boolean(sNow));
  check('▶: one song left the queue', sNow?.queue.length === left - 1, String(sNow?.queue.length));
  await new Promise((r) => setTimeout(r, 1500));
  for (const m of host.msgs.slice(n0)) if (m.t === 'state' && m.state.nowPlaying) nowIds.add(m.state.nowPlaying.id);
  check('▶: no double advance (only the chosen song started)', nowIds.size === 1 && nowIds.has(target) && lastState(host).nowPlaying?.id === target, JSON.stringify([...nowIds]));
  check('▶: the new song really plays', Boolean(await until(async () => host.page.evaluate(() => window.__audios.some((a) => a.src && !a.paused && a.currentTime > 0.2)), { timeout: 15_000 })));
  const recap = (await rawHost.ask({ t: 'recap' }, (m) => m.t === 'recap'))?.recap;
  const statusOf = (id) => recap?.songs.find((x) => x.song.id === [sNext.nowPlaying, first].find((i) => i.id === id)?.song.id)?.status;
  check('▶: the song it stopped counts as skipped', statusOf(bottom) === 'skipped', JSON.stringify(recap?.songs?.map((x) => [x.song.title, x.status])));
  check('the first song counts as finished', statusOf(first.id) === 'finished');

  // A late Play now with an old `from` is ignored (the Skip guard).
  const other = lastState(host).queue[0]?.id;
  rawHost.ws.send(JSON.stringify({ t: 'playNow', id: other, from: bottom }));
  await new Promise((r) => setTimeout(r, 1000));
  check('a late Play now (old from) changes nothing', lastState(host).nowPlaying?.id === target && lastState(host).queue.some((q) => q.id === other));
  const playingErr = await rawHost.ask({ t: 'push', id: target, on: true }, (m) => m.t === 'error');
  check('push on the song playing: refused (playing)', playingErr?.error === 'playing', JSON.stringify(playingErr));

  // The board's socket cannot push or play now.
  rawBoard = await rawSocket(roomId, { role: 'board' });
  await rawBoard.ask({ t: 'board', token: link.token }, (m) => m.t === 'state');
  const bp = await rawBoard.ask({ t: 'push', id: other, on: true }, (m) => m.t === 'error');
  const bn = await rawBoard.ask({ t: 'playNow', id: other, from: target }, (m) => m.t === 'error');
  check('board: push refused', bp?.error === 'bad_message', JSON.stringify(bp));
  check('board: play now refused', bn?.error === 'bad_message', JSON.stringify(bn));
  check('board: nothing changed', !lastState(host).queue.find((q) => q.id === other)?.pushed && lastState(host).nowPlaying?.id === target);
  check('the board page has no ⏫ or ▶ buttons', (await board.page.locator('#queue button').count()) === 0);
  check('the student page has no ⏫ or ▶ buttons', (await ava.page.locator('#queue [data-act="push"], #queue [data-act="playNow"]').count()) === 0);

  // Big screen hides them.
  await host.page.click(await reveal(host.page, '#bigBtn'));
  check('big screen: no ⏫ / ▶', !(await host.page.locator('#queue button[data-act="push"]').first().isVisible().catch(() => false))
    && !(await host.page.locator('#queue button[data-act="playNow"]').first().isVisible().catch(() => false)));
  await host.page.click(await reveal(host.page, '#bigBtn'));

  await host.page.click(await reveal(host.page, '#closeBtn'));
  await host.page.click('#confirm button[value="ok"]');
  check('close: the room is gone', Boolean(await until(() => visible(host, '#closedScreen'))));
  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL teacher-push stopped: ${e?.stack ?? e}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  rawHost?.ws.close();
  rawBoard?.ws.close();
  const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) });
  if (!r.ok) console.log('FAIL could not put the saved teacher settings back');
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
