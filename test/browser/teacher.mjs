// Browser test of the teacher's shortcuts, preferences and background music on the host page
// (installed Chrome, playwright-core), against a LOCAL wrangler dev only:
//   npm run build, then wrangler dev (e.g. npm run dev), then:
//   node test/browser/teacher.mjs [http://127.0.0.1:8792/]
// It checks:
//   1. Shortcuts: the "Press ? for shortcuts" hint and dialog, B / L / M / arrows / S / F / Space, never
//      while typing in a box, with a dialog open, or with Ctrl or Alt held; screen reader announcements.
//   2. Changing a key: a duplicate is refused, a new key works and the old one does not, it is kept
//      on this computer (cq.keys) after a reload, Reset brings the usual keys back.
//   3. Teacher preferences: class period (periodMinutes) saved by "Save as my default" with every
//      other setting kept; big screen text size, who suggested, album art, start in big screen
//      (cq.display) kept after a reload.
//   4. Background music from YouTube (the real IFrame player, video M7lc1UVf-VE like test:youtube;
//      no API key needed): G plays it in a visible player at least 200 x 200; a student's song
//      (song previews) pauses it; when the queue is empty it plays again; closing the room stops it.
//   5. Background music from Spotify through a FAKE SDK and Web API (like test:spotify): the
//      playlist starts with context_uri on the RoomDJ device; a queue song replaces it; late
//      background music states do not end the queue song; a real end moves on and the playlist
//      comes back where it was (offset + position).
// Reads TEACHER_KEY from .dev.vars and never prints it. Searches hit the real iTunes API (through
// the host page). The teacher settings saved in local KV are put back at the end.

import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T1, pickTeacher } from './teacher-pick.mjs';
import { reveal } from './ui.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = fileURLToPath(new URL('./.out/', import.meta.url));
const ROOT = new URL('../../', import.meta.url);
const VIDEO = process.env.YT_VIDEO || 'M7lc1UVf-VE';
const PLAYLIST = '37i9dQZF1DXcBWIGoYBM5M';
mkdirSync(OUT, { recursive: true });

if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: run against a local dev server only (not ${BASE})`);
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

function devVar(name) {
  const line = readFileSync(new URL('.dev.vars', ROOT), 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^"(.*)"$/, '$1') : null;
}
const KEY = devVar('TEACHER_KEY');
if (!KEY) throw new Error('TEACHER_KEY is not in .dev.vars');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
  return ok;
}
async function until(fn, { timeout = 10_000, every = 150 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=document-user-activation-required'],
  ignoreDefaultArgs: ['--disable-component-update'],
});
const HOST = new URL('host/', BASE).href;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

async function newHost({ init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  const p = { ctx, page, errors: [], msgs: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    try { p.msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ }
  }));
  return p;
}
const lastState = (p) => p.msgs.findLast((m) => m.t === 'state')?.state ?? null;
const hostState = (p, pred, timeout = 10_000) => until(() => { const s = lastState(p); return s && pred(s) ? s : null; }, { timeout });
const isBig = (p) => p.page.evaluate(() => document.body.classList.contains('big'));
const announced = (p) => p.page.locator('#announce').textContent();
const press = async (p, key) => { await p.page.keyboard.press(key); await p.page.waitForTimeout(120); };

async function openRoom(p) {
  await p.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(p.page, KEY);
  await p.page.click('#openBtn');
  // A fresh wrangler dev can take a while for its first room.
  await p.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 40_000 });
  await hostState(p, () => true);
  // Let a page click (not a key) give the page its user activation, like a teacher would.
  await p.page.click('#nowLabel');
  return p.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
}
async function closeRoom(p) {
  if (!(await p.page.locator('#roomMenuBtn').isVisible())) return;
  if (await isBig(p)) await p.page.click(await reveal(p.page, '#bigBtn'));
  await p.page.click(await reveal(p.page, '#closeBtn'));
  await p.page.click('#confirm button[value="ok"]');
  await until(() => p.page.locator('#closedScreen').isVisible());
}

/** A student in the room (WebSocket), admitted with the class code. */
const wsBase = BASE.replace(/^http/, 'ws');
async function student(room, device, nick) {
  await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code: room.classCode }) });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}api/rooms/${room.room}/ws?${new URLSearchParams({ role: 'student', device, nick })}`);
    ws.msgs = [];
    ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
  });
}
async function findSong(room, device, q) {
  const r = await fetch(new URL(`api/rooms/${room.room}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': device } });
  return (await r.json()).results?.[0];
}
/** AI check off for this room (no AI calls in this test), through the Settings dialog. */
async function quietRoom(p) {
  await p.page.click('#settingsBtn');
  await p.page.uncheck(await reveal(p.page, '#setAi'));
  await p.page.uncheck(await reveal(p.page, '#setUnknown'));
  await p.page.selectOption(await reveal(p.page, '#setCooldown'), 'off'); // songs replay across runs: no repeat cooldown
  await p.page.selectOption(await reveal(p.page, '#setBackToWork'), 'off'); // students act many times in a row here (back to work off)
  await p.page.selectOption(await reveal(p.page, '#setBackToWork'), 'off'); // students act many times in a row here
  await p.page.click('#applySettings');
  await hostState(p, (s) => !s.settings.aiCheck && s.settings.cooldownDays === null);
}

const teacherSettings = async (init = {}) => (await fetch(new URL('api/teacher/settings', BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...(init.headers ?? {}) } })).json();
const savedBefore = await teacherSettings();

try {
  // ---- 1. Shortcuts ----
  {
    const p = await newHost();
    await p.page.goto(HOST);
    await openRoom(p);
    const hint = p.page.locator('#keysHint');
    check('hint: "Press ? for shortcuts" shows', (await hint.isVisible()) && /Press \? for shortcuts/.test(await hint.textContent()), await hint.textContent());

    await press(p, '?');
    check('? opens the shortcuts dialog', await p.page.locator('#keysDlg').evaluate((d) => d.open));
    const rows = await p.page.$$eval('#keysList tr', (trs) => trs.map((tr) => tr.textContent.replace(/\s+/g, ' ').trim()));
    check('dialog lists every shortcut', rows.length === 13 && rows.some((r) => /^Space Play/.test(r)) && rows.some((r) => /^G Background music/.test(r)), rows.join(' | '));
    await press(p, 'Escape');
    check('Esc closes it', !(await p.page.locator('#keysDlg').evaluate((d) => d.open)));

    await press(p, 'b');
    check('B: big screen on', await isBig(p));
    check('B: announced', /Big screen on/.test(await until(async () => (/Big/.test(await announced(p)) ? announced(p) : null)) ?? ''));
    await press(p, 'b');
    check('B again: big screen off', !(await isBig(p)));
    await press(p, 'Control+b');
    await press(p, 'Alt+b');
    check('Ctrl+B / Alt+B: nothing', !(await isBig(p)));

    // Never while typing.
    await p.page.click('#fillerEdit');
    await p.page.focus('#fillerLink');
    await p.page.keyboard.type('bmls n?');
    check('typing in a box: no shortcut fires', !(await isBig(p)) && !(await p.page.locator('#keysDlg').evaluate((d) => d.open))
      && (await p.page.inputValue('#fillerLink')) === 'bmls n?' && !lastState(p).locked);
    await p.page.click('#fillerCancel');

    await press(p, 'l');
    check('L: suggestions locked', Boolean(await hostState(p, (s) => s.locked)));
    check('L: announced', /Suggestions locked/.test(await until(async () => (/locked/.test(await announced(p)) ? announced(p) : null)) ?? ''));
    await press(p, 'l');
    check('L again: unlocked', Boolean(await hostState(p, (s) => !s.locked)));

    await press(p, 'm');
    check('M: muted (volume 0)', (await p.page.inputValue('#volume')) === '0');
    await press(p, 'm');
    check('M again: volume back', (await p.page.inputValue('#volume')) === '1');
    await press(p, 'ArrowDown');
    await press(p, 'ArrowDown');
    check('↓ twice: volume 0.8', (await p.page.inputValue('#volume')) === '0.8', await p.page.inputValue('#volume'));
    await press(p, 'ArrowUp');
    check('↑: volume 0.9', (await p.page.inputValue('#volume')) === '0.9');
    check('volume announced', /Volume 90 percent/.test(await until(async () => (/90/.test(await announced(p)) ? announced(p) : null)) ?? ''));

    await press(p, 's');
    check('S: Settings opens', await p.page.locator('#settingsDlg').evaluate((d) => d.open));
    await press(p, 'b');
    check('a dialog open: shortcuts do not fire', !(await isBig(p)));
    await press(p, 'Escape');

    await press(p, 'f');
    const full = await until(() => p.page.evaluate(() => Boolean(document.fullscreenElement)), { timeout: 3000 });
    check('F: full screen, with big screen', Boolean(full) && (await isBig(p)));
    await press(p, 'f');
    const left = await until(() => p.page.evaluate(() => !document.fullscreenElement), { timeout: 3000 });
    const bigOff = await until(async () => !(await isBig(p)), { timeout: 2000 });
    check('F again: full screen and big screen off', Boolean(left) && Boolean(bigOff));

    // Space with nothing queued and no background music link: Start music.
    check('before Space: Start music shows', await p.page.locator('#startBtn').isVisible());
    await press(p, ' ');
    check('Space: music started (Pause shows)', await until(() => p.page.locator('#playBtn').isVisible(), { timeout: 3000 }));

    // ---- 2. Change a key ----
    await press(p, '?');
    await p.page.click('#keysList tr[data-id="skip"] button');
    check('Change: waits for a key', /Press a key/.test(await p.page.locator('#keysList tr[data-id="skip"] button').textContent()));
    await press(p, 'b');
    check('a key another action has: refused, says which', /already does "Big screen/.test(await p.page.locator('#keysMsg').textContent()), await p.page.locator('#keysMsg').textContent());
    await press(p, 'k');
    check('new key shown', (await p.page.locator('#keysList tr[data-id="skip"] kbd').textContent()) === 'K');
    check('kept on this computer (cq.keys)', (await p.page.evaluate(() => localStorage.getItem('cq.keys:teacher-1'))) === '{"skip":"k"}');
    await p.page.click('#keysDlg button[value="done"]');
    await p.page.reload();
    await p.page.waitForFunction(() => !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
    await press(p, '?');
    check('after a reload: still K', (await p.page.locator('#keysList tr[data-id="skip"] kbd').textContent()) === 'K');
    await p.page.click('#keysReset');
    check('Reset: N again, nothing saved', (await p.page.locator('#keysList tr[data-id="skip"] kbd').textContent()) === 'N'
      && (await p.page.evaluate(() => localStorage.getItem('cq.keys:teacher-1'))) === null);
    // Change the help key itself, and the hint follows.
    await p.page.click('#keysList tr[data-id="help"] button');
    await press(p, 'h');
    check('hint follows the help key', /Press H for shortcuts/.test(await p.page.locator('#keysHint').textContent()));
    await p.page.click('#keysReset');
    await p.page.click('#keysDlg button[value="done"]');

    // ---- 3. Teacher preferences ----
    await p.page.click('#settingsBtn');
    check('Settings: class period shows 70 (the default) or the saved one', (await p.page.inputValue('#setPeriod')) === String(savedBefore.periodMinutes ?? 70));
    await p.page.fill(await reveal(p.page, '#setPeriod'), '5');
    await p.page.click('#saveDefault');
    check('period 5: refused on the page', /class period/i.test(await p.page.locator('#settingsMsg').textContent()));
    await p.page.fill(await reveal(p.page, '#setPeriod'), '55');
    await p.page.click('#saveDefault');
    await until(async () => !(await p.page.locator('#settingsDlg').evaluate((d) => d.open)));
    const saved = await teacherSettings();
    const roomSettings = lastState(p).settings;
    check('Save as my default: periodMinutes saved', saved.periodMinutes === 55, JSON.stringify(saved));
    const missing = Object.keys(roomSettings).filter((k) => !(k in saved));
    check('Save as my default: every setting is saved', missing.length === 0, missing.join(','));
    check('this room uses it too', Boolean(await hostState(p, (s) => s.settings.periodMinutes === 55)));

    await p.page.click('#settingsBtn');
    await p.page.selectOption(await reveal(p.page, '#prefSize'), 'l');
    await p.page.uncheck(await reveal(p.page, '#prefWho'));
    await p.page.uncheck(await reveal(p.page, '#prefArt'));
    await p.page.check(await reveal(p.page, '#prefStartBig'));
    const classes = await p.page.evaluate(() => document.body.className);
    check('display prefs apply right away', /big-size-l/.test(classes) && /big-no-who/.test(classes) && /big-no-art/.test(classes), classes);
    await p.page.click('#cancelSettings');
    check('display prefs kept on this computer', JSON.stringify(await p.page.evaluate(() => JSON.parse(localStorage.getItem('cq.display:teacher-1'))))
      === JSON.stringify({ size: 'l', who: false, art: false, startBig: true }));
    await press(p, 'b');
    const large = await p.page.$eval('#bigCode', (e) => parseFloat(getComputedStyle(e).fontSize));
    await press(p, 'b');
    await p.page.reload();
    await p.page.waitForFunction(() => !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
    check('start in big screen: big after a reload', await isBig(p));
    check('prefs after a reload', /big-size-l/.test(await p.page.evaluate(() => document.body.className)));
    await p.page.click(await reveal(p.page, '#bigBtn'));
    await p.page.click('#settingsBtn');
    check('Settings shows the saved prefs', (await p.page.inputValue('#prefSize')) === 'l' && !(await p.page.isChecked('#prefWho')) && (await p.page.isChecked('#prefStartBig')));
    await p.page.selectOption(await reveal(p.page, '#prefSize'), 's');
    await p.page.check(await reveal(p.page, '#prefWho'));
    await p.page.check(await reveal(p.page, '#prefArt'));
    await p.page.uncheck(await reveal(p.page, '#prefStartBig'));
    await p.page.click('#cancelSettings');
    await press(p, 'b');
    const small = await p.page.$eval('#bigCode', (e) => parseFloat(getComputedStyle(e).fontSize));
    check('big screen text: Larger is bigger than Smaller', large > small * 1.2, `${large} vs ${small}`);
    await press(p, 'b');
    check('no CSP violations (shortcuts, prefs)', (await p.page.evaluate(() => window.__csp)).length === 0, (await p.page.evaluate(() => window.__csp)).join(' | '));
    check('no page errors (shortcuts, prefs)', p.errors.length === 0, p.errors.join(' | '));
    await closeRoom(p);
    await p.ctx.close();
  }

  // ---- 4. Background music from YouTube, song previews as the queue player ----
  {
    const p = await newHost({ init: { fn: () => localStorage.setItem('cq.music', 'preview') } });
    await p.page.goto(HOST);
    const room = await openRoom(p);
    await quietRoom(p);
    // No link yet: G opens the link box.
    await press(p, 'g');
    check('G with no link: the link box opens', await p.page.locator('#fillerForm').isVisible());
    await p.page.fill('#fillerLink', 'https://open.spotify.com/track/37i9dQZF1DXcBWIGoYBM5M');
    await p.page.click('#fillerSave');
    check('a Spotify song link: refused with a reason', /one Spotify song/.test(await p.page.locator('#fillerMsg').textContent()));
    await p.page.fill('#fillerLink', `https://www.youtube.com/watch?v=${VIDEO}`);
    await p.page.click('#fillerSave');
    check('link saved on this computer', (await p.page.evaluate(() => JSON.parse(localStorage.getItem('cq.filler:teacher-1'))))?.link === `https://www.youtube.com/watch?v=${VIDEO}`);
    await p.page.click('#nowLabel');
    await press(p, 'g');
    const box = p.page.locator('#fillerBox');
    const ytPlaying = () => until(async () => (await box.getAttribute('data-state')) === '1', { timeout: 45_000, every: 300 });
    check('G: background music plays (YouTube player state 1)', Boolean(await ytPlaying()), await box.getAttribute('data-state'));
    const size = await box.boundingBox();
    check('the YouTube player is on screen, at least 200 x 200', (await box.isVisible()) && size?.width >= 200 && size?.height >= 200, JSON.stringify(size));
    check('button says it is on', (await p.page.getAttribute('#fillerBtn', 'aria-pressed')) === 'true');

    // A student's song starts: the background music pauses.
    const dev = 'teacher-test-device-01';
    const s1 = await student(room, dev, 'Bea');
    const song = await findSong(room, dev, 'Happy Pharrell Williams');
    s1.send(JSON.stringify({ t: 'suggest', song: song.id }));
    const nowPlaying = await hostState(p, (s) => s.nowPlaying?.song?.id === song.id, 20_000);
    check('the student song plays (the room started with the background music)', Boolean(nowPlaying));
    const held = await until(async () => (await box.getAttribute('data-state')) === '2', { timeout: 10_000 });
    check('queue song: background music paused', Boolean(held), await box.getAttribute('data-state'));
    check('queue song: the note says it comes back', /paused for a song/.test(await p.page.locator('#fillerNow').textContent()));
    const moving = await until(async () => parseFloat(await p.page.$eval('#progressBar', (e) => e.style.width || '0')) > 0, { timeout: 15_000 });
    check('queue song: the preview plays', Boolean(moving));

    // Skip it: nothing plays and the queue is empty → the background music comes back.
    await press(p, 'n');
    check('N: skipped', Boolean(await hostState(p, (s) => !s.nowPlaying && s.queue.length === 0)));
    check('queue empty: background music plays again', Boolean(await ytPlaying()));
    check('never both at once: the preview is not playing', await p.page.evaluate(() => [...document.querySelectorAll('audio')].every((a) => a.paused)));

    // G pauses it; Space with nothing queued runs it too.
    await press(p, 'g');
    check('G: paused by the teacher', Boolean(await until(async () => (await box.getAttribute('data-state')) === '2')));
    await press(p, ' ');
    check('Space with nothing queued: background music on again', Boolean(await ytPlaying()));

    // Closing the room stops it.
    await closeRoom(p);
    const stopped = await until(async () => ['2', '5', '-1', '0'].includes(await box.getAttribute('data-state')) || !(await box.isVisible()), { timeout: 5000 });
    check('room closed: background music stops', Boolean(stopped), await box.getAttribute('data-state'));
    check('room closed: button off', (await p.page.getAttribute('#fillerBtn', 'aria-pressed')) === 'false');
    check('no CSP violations (YouTube background music)', (await p.page.evaluate(() => window.__csp)).length === 0, (await p.page.evaluate(() => window.__csp)).join(' | '));
    check('no page errors (YouTube background music)', p.errors.length === 0, p.errors.join(' | '));
    if (failures) await p.page.screenshot({ path: `${OUT}teacher-youtube.png` }).catch(() => {});
    s1.close();
    await p.ctx.close();
  }

  // ---- 5. Background music from Spotify (fake SDK + fake Web API) ----
  {
    const config = await (await fetch(new URL('api/config', BASE))).json();
    const CLIENT_ID = config.services?.spotify?.clientId;
    if (!check('/api/config offers Spotify (for the Spotify part)', Boolean(CLIENT_ID))) throw new Error('no Spotify');
    const p = await newHost({
      init: {
        fn: ([clientId, playlist]) => {
          localStorage.setItem('cq.spotify', JSON.stringify({ access: 'AT', refresh: 'RT', expiresAt: Date.now() + 3_600_000, clientId }));
          localStorage.setItem('cq.music', 'spotify');
          localStorage.setItem('cq.filler', JSON.stringify({ link: `https://open.spotify.com/playlist/${playlist}`, resume: true }));
        },
        arg: [CLIENT_ID, PLAYLIST],
      },
    });
    const plays = [];
    await p.page.route('https://sdk.scdn.co/spotify-player.js', (r) => r.fulfill({
      contentType: 'text/javascript',
      body: `window.Spotify = { Player: class {
        constructor(o) { this.o = o; this.l = {}; window.__fake = this; }
        addListener(e, f) { this.l[e] = f; return true; }
        connect() { setTimeout(() => this.l.ready?.({ device_id: 'DEV1' }), 50); return Promise.resolve(true); }
        activateElement() { return Promise.resolve(); }
        getCurrentState() { return Promise.resolve(window.__state || null); }
        pause() { window.__pauses = (window.__pauses || 0) + 1; return Promise.resolve(); }
        resume() { window.__resumes = (window.__resumes || 0) + 1; return Promise.resolve(); }
        setVolume() { return Promise.resolve(); }
        disconnect() {}
        emit(s) { window.__state = s; this.l.player_state_changed?.(s); }
      } };
      window.onSpotifyWebPlaybackSDKReady?.();`,
    }));
    await p.page.route('https://api.spotify.com/**', async (r) => {
      const req = r.request();
      if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
      const url = new URL(req.url());
      if (url.pathname === '/v1/search') {
        const q = url.searchParams.get('q');
        const title = (q.match(/track:"([^"]*)"/) ?? [])[1] ?? q;
        const artist = (q.match(/artist:"([^"]*)"/) ?? [])[1] ?? '';
        return r.fulfill({ headers: CORS, json: { tracks: { items: [{ uri: `spotify:track:${title.replace(/\W+/g, '').toLowerCase()}`, name: title, artists: [{ name: artist }], duration_ms: 0, explicit: false }] } } });
      }
      if (url.pathname === '/v1/me/player/play') {
        plays.push({ device: url.searchParams.get('device_id'), body: JSON.parse(req.postData() || '{}') });
        return r.fulfill({ status: 204, headers: CORS });
      }
      return r.fulfill({ status: 404, headers: CORS, json: {} });
    });
    await p.page.goto(HOST);
    const room = await openRoom(p);
    await quietRoom(p);
    check('Spotify: the saved playlist shows', /Spotify playlist/.test(await p.page.locator('#fillerNow').textContent()));
    await p.page.click('#fillerBtn');
    const first = await until(() => plays[0], { timeout: 10_000 });
    const CTX = `spotify:playlist:${PLAYLIST}`;
    check('Spotify background music: context_uri on the RoomDJ device', first?.device === 'DEV1' && first.body.context_uri === CTX && !first.body.uris, JSON.stringify(first));
    check('Spotify: no YouTube box', !(await p.page.locator('#fillerBox').isVisible()));
    const lofi = (position, paused = false) => ({ paused, position, duration: 180_000, context: { uri: CTX },
      track_window: { current_track: { uri: 'spotify:track:lofi1', name: 'Rainy Study', artists: [{ name: 'Lofi Beats' }] }, previous_tracks: [] } });
    const emit = (st) => p.page.evaluate((x) => window.__fake.emit(x), st);
    await emit(lofi(42_000));

    // A student's song: it replaces the playlist on the same speaker.
    const dev = 'teacher-test-device-02';
    const s1 = await student(room, dev, 'Cal');
    const song = await findSong(room, dev, 'Shake It Off Taylor Swift');
    s1.send(JSON.stringify({ t: 'suggest', song: song.id }));
    const second = await until(() => plays[1], { timeout: 20_000 });
    check('queue song: started with its track (uris) on DEV1', second?.device === 'DEV1' && second.body.uris?.length === 1 && !second.body.context_uri, JSON.stringify(second));
    check('queue song: the background music shows as paused for it', /paused for a song/.test(await p.page.locator('#fillerNow').textContent()));
    const uri = second?.body.uris?.[0];
    const mine = (position, paused = false, prev = []) => ({ paused, position, duration: 200_000, context: { uri: '' },
      track_window: { current_track: { uri, name: song.title }, previous_tracks: prev } });
    await emit(mine(1000));
    await emit(mine(8000));
    // Late background music states (twice, more than 700 ms apart): the queue song must NOT end.
    await emit(lofi(43_000));
    await p.page.waitForTimeout(900);
    await emit(lofi(44_000));
    await p.page.waitForTimeout(1500);
    check('late background music states: the queue song keeps playing', lastState(p)?.nowPlaying?.song?.id === song.id);
    check('late background music states: no new play request', plays.length === 2, JSON.stringify(plays.slice(2)));
    await emit(mine(9000));

    // The real end: the room moves on, the queue is empty, the playlist comes back where it was.
    await emit(mine(197_000));
    await emit(mine(0, true, [{ uri }]));
    check('a real end moves the room on', Boolean(await hostState(p, (s) => !s.nowPlaying && s.queue.length === 0)));
    const third = await until(() => plays[2], { timeout: 10_000 });
    check('queue empty: the playlist comes back where it was (offset + position)', third?.body.context_uri === CTX
      && third.body.offset?.uri === 'spotify:track:lofi1' && third.body.position_ms === 42_000, JSON.stringify(third));

    // The teacher pauses it (G): the speaker pauses; G again resumes it on the speaker (no new request).
    await p.page.click('#nowLabel');
    const pausesBefore = await p.page.evaluate(() => window.__pauses || 0);
    await press(p, 'g');
    check('G: Spotify background music paused', (await p.page.evaluate(() => window.__pauses || 0)) > pausesBefore);
    await press(p, 'g');
    check('G again: resumed on the speaker', (await p.page.evaluate(() => window.__resumes || 0)) > 0 && plays.length === 3, JSON.stringify(plays.slice(3)));
    check('no CSP violations (Spotify background music)', (await p.page.evaluate(() => window.__csp)).length === 0, (await p.page.evaluate(() => window.__csp)).join(' | '));
    check('no page errors (Spotify background music)', p.errors.length === 0, p.errors.join(' | '));
    if (failures) await p.page.screenshot({ path: `${OUT}teacher-spotify.png` }).catch(() => {});
    await closeRoom(p);
    s1.close();
    await p.ctx.close();
  }
} catch (e) {
  failures++;
  console.log(`FAIL crashed: ${e?.stack || e}`);
} finally {
  // Put the teacher's saved settings back as they were.
  await teacherSettings({ method: 'PUT', body: JSON.stringify(savedBefore) }).catch(() => {});
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
