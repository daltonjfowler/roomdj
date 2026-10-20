// Browser test of the YouTube player on the host page (installed Chrome, playwright-core), against
// a LOCAL wrangler dev only. No real YouTube API key is needed or used:
//
//   With YouTube unconfigured (plain `npm run dev`):
//     node test/browser/youtube.mjs http://127.0.0.1:8792/
//     → the picker has no YouTube, and the endpoint answers youtube_off; the room still plays.
//
//   With the real IFrame player under the real CSP:
//     npm run build
//     npx wrangler dev --ip 127.0.0.1 --port 8792 --local-upstream 127.0.0.1:8792 \
//       --var YOUTUBE_API_KEY:local-test-not-a-key
//     node test/browser/youtube.mjs http://127.0.0.1:8792/
//   The fake key only makes /api/config offer YouTube. This script writes the songs' video ids
//   straight into the LOCAL KV cache (wrangler kv --local, yt:<trackId>: ytKey), so the server answers from
//   the cache and never calls Google. Nothing in the Worker knows about this: on the deployed site
//   there is no --var and no local KV, so it cannot be done there. Video dQw4w9WgXcQ is a public,
//   embeddable video (YT_VIDEO to pick another). Ads may play first; the checks wait for them.
// PERSIST_TO: the wrangler dev --persist-to directory, if the server uses one.
// Reads TEACHER_KEY from .dev.vars and never prints it. Screenshots go to test/browser/.out/.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ytKey } from '../../src/youtube.js';
import { T1, pickTeacher } from './teacher-pick.mjs';
import { reveal } from './ui.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = fileURLToPath(new URL('./.out/', import.meta.url));
const ROOT = new URL('../../', import.meta.url);
// YouTube's own IFrame API demo video. (dQw4w9WgXcQ answers error 150 in headless Chrome.)
const GOOD_VIDEO = process.env.YT_VIDEO || 'M7lc1UVf-VE';
const MISSING_VIDEO = 'zzzzzzzzzz0'; // no such video: the player answers error 100/150
mkdirSync(OUT, { recursive: true });

if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: this test writes to the local KV, so it runs only against a local dev server (not ${BASE})`);
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

async function until(fn, { timeout = 10_000, every = 200 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}

// ---- Local KV (never --remote) ----
const WRANGLER = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));
const PERSIST = process.env.PERSIST_TO ? ['--persist-to', process.env.PERSIST_TO] : [];
function localKv(...args) {
  const r = spawnSync(process.execPath, [WRANGLER, 'kv', ...args, '--binding', 'CLASS_KV', '--local', ...PERSIST],
    { cwd: fileURLToPath(ROOT), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler kv ${args[0]} ${args[1]} --local failed: ${r.stderr.slice(-300)}`);
  return r.stdout;
}
function localKvBulk(action, entries) {
  const file = `${OUT}yt-kv-${action}.json`;
  writeFileSync(file, JSON.stringify(entries));
  localKv('bulk', action, file, ...(action === 'delete' ? ['--force'] : []));
}
const localKvGet = (key) => {
  const out = localKv('key', 'get', key, '--text').trim();
  return out.startsWith('Value not found') ? null : out;
};

const api = (path, init = {}) => fetch(new URL(path, BASE), init);

// ---- Pages ----
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=document-user-activation-required'],
});

async function openPage(name, path, { music } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  if (music) await ctx.addInitScript((m) => { try { localStorage.setItem('cq.music', m); } catch { /* blocked */ } }, music);
  // CSP violations of OUR page (the YouTube iframe has its own policy and its own console noise).
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  const p = { name, ctx, page, msgs: [], errors: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => {
    if (process.env.YT_DEBUG && m.type() !== 'error') console.log(`  [${name} console.${m.type()}] ${m.text().slice(0, 200)}`);
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) p.errors.push(m.text());
  });
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    try { p.msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ }
  }));
  await page.goto(new URL(path, BASE).href);
  return p;
}

const lastState = (p) => [...p.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const hostState = (host, pred, timeout = 10_000) => until(() => {
  const s = lastState(host);
  return s && pred(s) ? s : null;
}, { timeout });
const text = (p, sel) => p.page.locator(sel).textContent();
const progress = (p) => p.page.$eval('#progressBar', (e) => parseFloat(e.style.width || '0'));

async function openRoom(host) {
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const saved = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  // code: the class code students type; path: the room id the API takes.
  return { code: saved.classCode, token: saved.token, path: saved.room };
}

async function aiOff(host) {
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  await host.page.fill(await reveal(host.page, '#setMax'), '5');
  await host.page.setChecked(await reveal(host.page, '#setAi'), false);
  await host.page.selectOption(await reveal(host.page, '#setBackToWork'), 'off'); // students act many times in a row here
  await host.page.click('#applySettings');
  await hostState(host, (s) => !s.settings.aiCheck);
}

async function firstResult(code, room, q) {
  // The room's own search, as a device admitted with the class code.
  const headers = { 'x-device': 'youtube-test-device-01' };
  await api('api/join', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const r = await api(`api/rooms/${room}/search?q=${encodeURIComponent(q)}`, { headers });
  const id = (await r.json()).results?.[0]?.id;
  if (!id) throw new Error(`no search result for ${q}`);
  return id;
}

async function suggestAs(student, code, trackId, q) {
  await student.page.fill('#q', q);
  await student.page.press('#q', 'Enter');
  await student.page.waitForSelector(`#results li[data-id="${trackId}"] button[data-act="suggest"]`, { timeout: 15_000 });
  const n = student.msgs.length;
  await student.page.click(`#results li[data-id="${trackId}"] button[data-act="suggest"]`);
  return until(() => student.msgs.slice(n).find((m) => m.t === 'suggested' && m.song === trackId), { timeout: 20_000 });
}

const ytApi = (room, query, token) => api(`api/rooms/${room}/youtube?${query}`, { headers: token ? { 'x-host-token': token } : {} });

const pages = [];
let seeded = [];
const config = await (await api('api/config')).json();
const configured = config?.services?.youtube === true;
console.log(`YouTube is ${configured ? 'configured (fake key, cache only)' : 'not configured'} on ${BASE}`);

try {
  const host = await openPage('host', 'host/', { music: 'youtube' });
  pages.push(host);
  const { code, token, path } = await openRoom(host);
  check('host opens a room', /^[a-z]+(-[a-z0-9]+){2,}$/.test(code ?? '') && /^[0-9a-f]{32}$/.test(path ?? ''), code);
  await aiOff(host);
  const options = await host.page.$$eval('#service option', (os) => os.map((o) => o.value));

  const Q = {
    skip: 'Together Forever Rick Astley', // first candidate is missing: the player must move on
    good: 'Never Gonna Give You Up Rick Astley',
    none: 'Here Comes the Sun Beatles', // no video: the preview plays instead
  };
  const t = {};
  for (const [k, q] of Object.entries(Q)) t[k] = await firstResult(code, path, q);

  if (!configured) {
    check('unconfigured: the picker does not offer YouTube', !options.includes('youtube'), options.join(','));
  } else {
    check('configured: the picker offers YouTube and the saved choice is used', options.includes('youtube')
      && (await host.page.$eval('#service', (s) => s.value)) === 'youtube');
    check('configured: the YouTube note shows', await host.page.locator('#ytNote').isVisible());
    const now = Date.now();
    seeded = Object.values(t).map((id) => ytKey(id));
    localKvBulk('put', [
      { key: ytKey(t.skip), value: JSON.stringify({ ranked: [MISSING_VIDEO, GOOD_VIDEO], bad: [], at: now }) },
      { key: ytKey(t.good), value: JSON.stringify({ ranked: [GOOD_VIDEO], bad: [], at: now }) },
      { key: ytKey(t.none), value: JSON.stringify({ ranked: [], bad: [], at: now }) },
    ]);
  }

  const ava = await openPage('ava', `?code=${code}`);
  pages.push(ava);
  await ava.page.fill('#code', code);
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');
  const order = configured ? ['skip', 'good', 'none'] : ['good'];
  for (const k of order) {
    const m = await suggestAs(ava, code, t[k], Q[k]);
    check(`suggest ${k}`, m?.ok === true, JSON.stringify(m));
  }
  await hostState(host, (s) => s.queue.length === order.length);

  // The endpoint is for the host only.
  const noToken = await ytApi(path, `song=${t.good}`);
  check('youtube endpoint: no host token → 403', noToken.status === 403, String(noToken.status));
  const badToken = await ytApi(path, `song=${t.good}`, 'not-the-host-token');
  check('youtube endpoint: wrong host token → 403', badToken.status === 403, String(badToken.status));
  const notQueued = await ytApi(path, 'song=it:1', token);
  check('youtube endpoint: a song not in the room → 404 no_item', notQueued.status === 404 && (await notQueued.json()).error === 'no_item');
  const badSkip = await ytApi(path, `song=${t.good}&skip=${encodeURIComponent('<script>')}`, token);
  check('youtube endpoint: a bad skip id → 400', badSkip.status === 400, String(badSkip.status));
  const studentTry = await api(`api/rooms/${path}/youtube?song=${t.good}`, { headers: { 'x-device': 'youtube-test-device-01' } });
  check('youtube endpoint: a student device header is not enough → 403', studentTry.status === 403);

  if (!configured) {
    const off = await ytApi(path, `song=${t.good}`, token);
    const body = await off.json();
    check('unconfigured: the host gets youtube_off', off.status === 503 && body.error === 'youtube_off', JSON.stringify(body));
    await host.page.click('#startBtn');
    await hostState(host, (s) => s.nowPlaying);
    check('unconfigured: previews still play (progress moves)', Boolean(await until(async () => (await progress(host)) > 0, { timeout: 15_000 })));
    check('unconfigured: no YouTube player on the page', await host.page.locator('#ytBox').isHidden());
  } else {
    // Song 1: its first video does not exist. The player reports an error, the host asks for the
    // next one with &skip=, and the good video plays.
    const asked = [];
    host.page.on('request', (r) => { if (r.url().includes('/youtube?')) asked.push(r.url()); });
    await host.page.click('#startBtn');
    const s1 = await hostState(host, (s) => s.nowPlaying?.song.id === t.skip);
    check('start: song 1 is now playing', Boolean(s1));
    const frame = await until(() => host.page.$eval('#ytBox iframe', (f) => f.src).catch(() => null), { timeout: 20_000 });
    check('player: a youtube-nocookie.com embed iframe', /^https:\/\/www\.youtube-nocookie\.com\/embed\//.test(frame ?? ''), frame);
    const skipped = await until(() => asked.some((u) => u.includes(`skip=${MISSING_VIDEO}`)), { timeout: 30_000 });
    check('player error on the missing video → asks the server for the next one (&skip=)', Boolean(skipped), asked.join(' '));
    const box = await host.page.$eval('#ytBox', (b) => ({ w: b.offsetWidth, h: b.offsetHeight, hidden: b.hidden }));
    check('player: visible, at least 200 x 200 px', !box.hidden && box.w >= 200 && box.h >= 200, JSON.stringify(box));
    // Progress with the YouTube player still showing (not the preview fallback).
    const playing1 = await until(async () => (await progress(host)) > 0 && (await host.page.locator('#ytBox').isVisible()), { timeout: 60_000 });
    check('player: the next video really plays under the CSP (progress moves; ads waited out)', Boolean(playing1));
    if (!playing1) await host.page.screenshot({ path: `${OUT}youtube-not-playing.png` });
    const cached = JSON.parse(localKvGet(ytKey(t.skip)) ?? '{}');
    check('server remembers the bad video id in KV (and only that one)', JSON.stringify(cached.bad) === JSON.stringify([MISSING_VIDEO]), JSON.stringify(cached) + ' asked: ' + asked.join(' '));
    const again = await (await ytApi(path, `song=${t.skip}`, token)).json();
    check('server never picks the bad video again', again.videoId === GOOD_VIDEO, JSON.stringify(again));

    // Pause and resume.
    await host.page.click('#playBtn');
    await new Promise((r) => setTimeout(r, 1500));
    const pausedAt = await progress(host);
    await new Promise((r) => setTimeout(r, 1500));
    check('pause: progress stops', (await progress(host)) === pausedAt);
    await host.page.click('#playBtn');
    check('resume: progress moves again', Boolean(await until(async () => (await progress(host)) > pausedAt, { timeout: 15_000 })));

    // Song 2: straight from the cache.
    await host.page.click('#skipBtn');
    check('skip: song 2 is now playing', Boolean(await hostState(host, (s) => s.nowPlaying?.song.id === t.good)));
    await until(async () => (await progress(host)) < 5, { timeout: 10_000 });
    if (!check('song 2: plays in the YouTube player (progress moves)', Boolean(await until(async () => (await progress(host)) > 0.2
      && (await host.page.locator('#ytBox').isVisible()), { timeout: 60_000 })))) {
      await host.page.screenshot({ path: `${OUT}youtube-song2.png` });
    }

    // Song 3: no YouTube match → its 30-second preview, with a notice.
    await host.page.click('#skipBtn');
    check('skip: song 3 is now playing', Boolean(await hostState(host, (s) => s.nowPlaying?.song.id === t.none)));
    check('no match: the host is told the preview plays instead', Boolean(await until(async () => (await text(host, '#toasts')).includes('Playing its 30-second preview instead.'))));
    check('no match: the YouTube player is hidden', Boolean(await until(() => host.page.locator('#ytBox').isHidden())));
    await until(async () => (await progress(host)) < 5, { timeout: 10_000 });
    check('no match: the preview plays (progress moves)', Boolean(await until(async () => (await progress(host)) > 1, { timeout: 20_000 })));

    // Back to previews from the picker: the YouTube player goes away.
    await host.page.selectOption('#service', 'preview');
    check('picker back to previews: no YouTube player, no note', Boolean(await until(async () => (await host.page.locator('#ytBox').isHidden())
      && (await host.page.locator('#ytNote').isHidden()) && (await host.page.$$('#ytBox iframe')).length === 0)));
  }

  await host.page.click(await reveal(host.page, '#closeBtn'));
  await host.page.waitForSelector('#confirm[open]');
  await host.page.click('#confirm button[value="ok"]');
  check('room closes', Boolean(await until(() => host.page.locator('#closedScreen').isVisible())));

  for (const p of pages) {
    const csp = await p.page.evaluate(() => window.__csp).catch(() => []);
    check(`no CSP violations on ${p.name}`, csp.length === 0, csp.join(' | '));
    check(`no page errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
  }
} catch (e) {
  failures++;
  console.log(`FAIL youtube test stopped: ${e?.stack ?? e}`);
  for (const p of pages) await p.page.screenshot({ path: `${OUT}youtube-crash-${p.name}.png` }).catch(() => {});
} finally {
  try {
    if (seeded.length) localKvBulk('delete', seeded);
  } catch (e) {
    console.log(`FAIL could not clean the seeded local KV keys: ${e.message}`);
  }
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
