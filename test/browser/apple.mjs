// Browser test of Apple Music on the host page, with NO Apple Developer account: installed Chrome
// (playwright-core) against a LOCAL wrangler dev started with throwaway Apple secrets, e.g.
//   npm run build
//   npx wrangler dev --ip 127.0.0.1 --port 8796 --local-upstream 127.0.0.1:8796 --var APPLE_TEAM_ID:FAKETEAM01 \
//     --var APPLE_KEY_ID:FAKEKEY001 --var APPLE_PRIVATE_KEY:<base64 of a P-256 PKCS#8 key made just
//     for the test (node: crypto.subtle.generateKey + exportKey('pkcs8'))>
//   node test/browser/apple.mjs [http://127.0.0.1:8796/]
// It checks:
//   1. Apple not set up (/api/config answered by the test): no Apple Music in the picker.
//   2. The picker shows Apple Music with a Connect button; GET /api/apple/token gives the host its
//      developer token (ES256, kid, origin = this site) and refuses everyone else (403).
//   3. The real MusicKit JS loads under the page's CSP without violations; Connect Apple Music
//      opens Apple's login window (answered by the test), which keeps its opener (the host page's
//      COOP allows popups) so MusicKit waits for it; closing it ends in a plain message.
//   4. A room playing through a FAKE MusicKit: an explicit-only song is skipped with a notice, a
//      clean one goes into Apple's queue alone (setQueue with one song id), and its end moves the
//      room on.
// Reads TEACHER_KEY from .dev.vars and never prints it. Searches hit the real iTunes API.

import { readFileSync } from 'node:fs';
import { itunesTrackId } from '../../shared/catalog.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T1, pickTeacher } from './teacher-pick.mjs';
import { reveal } from './ui.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8796/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = new URL('../../', import.meta.url);

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
async function until(fn, { timeout = 10_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}
const decodeJwt = (t) => t.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));

const config = await (await fetch(new URL('api/config', BASE))).json();
if (!check('/api/config offers Apple Music (the APPLE_* secrets are set)', config.services?.apple === true, JSON.stringify(config))) process.exit(1);

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=document-user-activation-required'],
  ignoreDefaultArgs: ['--disable-component-update'],
});
const HOST = new URL('host/', BASE).href;

async function newHost({ init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  if (init) await ctx.addInitScript(init);
  // Every CSP violation on any page of this context, as the page saw it.
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  const p = { ctx, page, errors: [], csp: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => {
    if (/Content Security Policy|Permissions policy/i.test(m.text())) p.csp.push(m.text());
  });
  return p;
}
const toasts = (p) => p.page.locator('#toasts').textContent();
async function openRoom(p) {
  await pickTeacher(p.page, KEY);
  await p.page.click('#openBtn');
  return until(async () => (await p.page.locator('#bigCode').textContent())?.trim(), { timeout: 15_000 });
}
async function closeRoom(p) {
  if (!(await p.page.locator('#roomMenuBtn').isVisible())) return;
  await p.page.click(await reveal(p.page, '#closeBtn'));
  await p.page.click('#confirm button[value="ok"]');
  await until(() => p.page.locator('#closedScreen').isVisible());
}

try {
  // ---- 1. Not set up ----
  {
    const p = await newHost();
    await p.page.route('**/api/config', (r) => r.fulfill({ json: { services: { preview: true, spotify: { clientId: 'a'.repeat(32) }, youtube: false, apple: false } } }));
    await p.page.goto(HOST);
    await openRoom(p);
    await until(() => p.page.locator('#musicFrom').isVisible());
    const options = await p.page.$$eval('#service option', (els) => els.map((e) => e.value));
    check('not set up: no Apple Music in the picker', !options.includes('apple'), options.join(','));
    check('not set up: no Apple button', !(await p.page.locator('#appleBtn').isVisible()));
    await closeRoom(p);
    await p.ctx.close();
  }

  // ---- 2 + 3. Picker, token endpoint, the real MusicKit ----
  {
    const p = await newHost();
    await p.ctx.route('https://authorize.music.apple.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>Apple login (test stand-in)</p>' }));
    await p.page.goto(HOST);
    await openRoom(p);
    await until(() => p.page.locator('#musicFrom').isVisible());
    const options = await p.page.$$eval('#service option', (els) => els.map((e) => e.value));
    check('picker lists Apple Music', options.includes('apple'), options.join(','));
    check('no Apple button on previews', !(await p.page.locator('#appleBtn').isVisible()));

    const room = await p.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
    const tokenUrl = new URL(`api/apple/token?room=${room.room}`, BASE);
    const mine = await p.page.evaluate(async ({ url, token }) => {
      const r = await fetch(url, { headers: { 'x-host-token': token } });
      return { status: r.status, body: await r.json() };
    }, { url: tokenUrl.href, token: room.token });
    check('host gets the developer token', mine.status === 200 && typeof mine.body.token === 'string', JSON.stringify(mine.status));
    if (mine.status === 200) {
      const [header, claims] = decodeJwt(mine.body.token);
      check('token header: ES256 + kid', header.alg === 'ES256' && header.kid === 'FAKEKEY001', JSON.stringify(header));
      check('token claims: iss, iat, exp (25+ hours), origin = this site', claims.iss === 'FAKETEAM01' && claims.exp - claims.iat >= 25 * 3600
        && claims.exp - claims.iat <= 15_777_000 && JSON.stringify(claims.origin) === JSON.stringify([new URL(BASE).origin]), JSON.stringify(claims));
    }
    const none = await fetch(tokenUrl);
    check('no host token: 403', none.status === 403, String(none.status));
    const wrong = await fetch(tokenUrl, { headers: { 'x-host-token': 'x'.repeat(43) } });
    check('wrong host token: 403', wrong.status === 403, String(wrong.status));
    const noRoom = await fetch(new URL('api/apple/token?room=0123456789abcdef0123456789abcdef', BASE), { headers: { 'x-host-token': room.token } });
    check('host token of another room: refused', noRoom.status === 403 || noRoom.status === 404, String(noRoom.status));
    const post = await fetch(tokenUrl, { method: 'POST', headers: { 'x-host-token': room.token } });
    check('POST: 405', post.status === 405, String(post.status));

    await p.page.selectOption('#service', 'apple');
    check('Apple picked: Connect Apple Music shows', (await p.page.locator('#appleBtn').textContent()) === 'Connect Apple Music');
    check('Apple picked: subscription note shows', /Apple Music subscription/.test(await p.page.locator('#musicNote').textContent()));
    check('choice remembered on this computer', (await p.page.evaluate(() => localStorage.getItem('cq.music:teacher-1'))) === 'apple');
    const loaded = await until(() => p.page.evaluate(() => Boolean(window.MusicKit?.configure)), { timeout: 20_000 });
    check('the real MusicKit JS loads under the CSP', Boolean(loaded));
    console.log(`  MusicKit ${await p.page.evaluate(() => window.MusicKit?.version ?? '?')}`);
    // Start music before connecting: a plain message, no sound, no crash.
    await p.page.click('#startBtn');
    await p.page.waitForTimeout(3000);
    const popupP = p.ctx.waitForEvent('page', { timeout: 20_000 }).catch(() => null);
    await p.page.click('#appleBtn');
    const popup = await popupP;
    await popup?.waitForURL(/authorize\.music\.apple\.com/, { timeout: 10_000 }).catch(() => {});
    check('Connect opens the Apple login window', Boolean(popup) && /^https:\/\/authorize\.music\.apple\.com\//.test(popup.url()), popup?.url());
    if (popup) {
      await popup.waitForLoadState().catch(() => {});
      check('the login window keeps its opener (host page COOP same-origin-allow-popups)', await popup.evaluate(() => Boolean(window.opener)).catch(() => false));
      await p.page.waitForTimeout(2000);
      check('login still waiting while the window is open', !/Apple Music (did not accept|was not connected)/.test(await toasts(p)), await toasts(p));
      await popup.close();
    }
    const said = await until(async () => /Apple Music (did not accept|was not connected)/.test(await toasts(p)), { timeout: 30_000 });
    check('fake token: Connect Apple Music ends with a clear message', Boolean(said), await toasts(p));
    console.log(`  host page said: ${(await toasts(p)).replace(/\s+/g, ' ').trim()}`);
    check('still Connect Apple Music afterwards', (await p.page.locator('#appleBtn').textContent()) === 'Connect Apple Music');
    const violations = await p.page.evaluate(() => window.__csp);
    check('no CSP violations with MusicKit', violations.length === 0 && p.csp.length === 0, [...violations, ...p.csp].join(' | '));
    check('no page errors', p.errors.length === 0, p.errors.join(' | '));
    await closeRoom(p);
    await p.ctx.close();
  }

  // ---- 4. A room through a fake MusicKit ----
  {
    const p = await newHost({
      init: () => {
        localStorage.setItem('cq.music', 'apple');
        // A stand-in for MusicKit JS v3: just the parts players/apple.js uses.
        const PS = { none: 0, loading: 1, playing: 2, paused: 3, stopped: 4, ended: 5, seeking: 6, waiting: 8, stalled: 9, completed: 10 };
        const fake = {
          isAuthorized: false, volume: 1, storefrontId: 'us', currentPlaybackTime: 0, currentPlaybackDuration: 0,
          l: {}, queued: [], plays: 0, explicitIds: new Set(), configured: null,
          addEventListener(e, f) { (this.l[e] ??= []).push(f); },
          removeEventListener(e, f) { this.l[e] = (this.l[e] ?? []).filter((x) => x !== f); },
          emit(e, d) { for (const f of this.l[e] ?? []) f(d); },
          async authorize() { this.isAuthorized = true; this.emit('authorizationStatusDidChange', {}); return 'user-token'; },
          async unauthorize() { this.isAuthorized = false; this.emit('authorizationStatusDidChange', {}); },
          async setQueue(o) { this.queued.push(o); },
          async play() { this.plays++; this.emit('playbackStateDidChange', { state: PS.playing }); },
          pause() {}, async stop() { this.emit('playbackStateDidChange', { state: PS.stopped }); },
          api: {
            music: async (path, params) => {
              const id = path.match(/\/songs\/(\d+)$/)?.[1];
              const song = (sid, name, artistName, explicit) => ({ id: sid, type: 'songs', attributes: { name, artistName, playParams: { id: sid }, ...(explicit ? { contentRating: 'explicit' } : {}) } });
              const info = window.__songs ?? {};
              if (id) {
                const s = info[id];
                if (!s) throw Object.assign(new Error('not found'), { errorCode: 'NOT_FOUND' });
                return { data: { data: [song(id, s.title, s.artist, fake.explicitIds.has(id))] } };
              }
              // Search: only the explicit version again (so the explicit song has no clean one).
              const hits = Object.entries(info).filter(([, s]) => params.term.includes(s.title)).map(([sid, s]) => song(sid, s.title, s.artist, fake.explicitIds.has(sid)));
              return { data: { results: { songs: { data: hits } } } };
            },
          },
        };
        window.__fakeKit = fake;
        window.MusicKit = { PlaybackStates: PS, configure: async (o) => { fake.configured = o; return fake; }, getInstance: () => fake };
      },
    });
    let sdkAsked = false;
    await p.page.route('https://js-cdn.music.apple.com/**', (r) => { sdkAsked = true; return r.abort(); });
    await p.page.goto(HOST);
    await openRoom(p);
    await until(() => p.page.locator('#musicFrom').isVisible());
    check('room test: Apple Music remembered', (await p.page.inputValue('#service')) === 'apple');
    check('room test: the real MusicKit script is not fetched again', !sdkAsked);
    await p.page.click('#appleBtn');
    await until(async () => (await p.page.locator('#appleBtn').textContent()) === 'Disconnect Apple Music');
    check('Connect: the button says Disconnect Apple Music', (await p.page.locator('#appleBtn').textContent()) === 'Disconnect Apple Music');
    await until(() => p.page.evaluate(() => Boolean(window.__fakeKit.configured)), { timeout: 10_000 });
    const conf = await p.page.evaluate(() => window.__fakeKit.configured);
    check('configure: the developer token from this server, app name RoomDJ', conf?.app?.name === 'RoomDJ'
      && decodeJwt(conf.developerToken)[0].kid === 'FAKEKEY001', JSON.stringify(conf?.app));
    check('autoplay is off (Apple never picks songs)', (await p.page.evaluate(() => window.__fakeKit.autoplayEnabled)) === false);

    const room = await p.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
    const id = room.room;
    await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': 'apple-test-device-0001', 'content-type': 'application/json' }, body: JSON.stringify({ code: room.classCode }) });
    const wsBase = BASE.replace(/^http/, 'ws');
    const sock = (params) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}api/rooms/${id}/ws?${new URLSearchParams(params)}`);
      ws.msgs = [];
      ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
      ws.onopen = () => resolve(ws);
      ws.onerror = reject;
    });
    const host = await sock({ role: 'host', token: room.token });
    host.send(JSON.stringify({ t: 'settings', settings: { maxWaitingPerStudent: 2, removeAtScore: -3, blockUnknownSongs: false, aiCheck: false, blocklist: [], backToWork: false } }));
    await until(() => host.msgs.find((m) => m.t === 'state' && !m.state.settings.aiCheck));
    const find = async (q) => {
      const r = await fetch(new URL(`api/rooms/${id}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': 'apple-test-device-0001' } });
      return (await r.json()).results[0];
    };
    const songA = await find('Happy Pharrell Williams');
    const songB = await find('Shake It Off Taylor Swift');
    // The fake MusicKit is asked for the iTunes trackId (the Apple Music song id).
    await p.page.evaluate(({ a, b }) => {
      window.__songs = { [a.n]: { title: a.title, artist: a.artist }, [b.n]: { title: b.title, artist: b.artist } };
      window.__fakeKit.explicitIds.add(String(a.n));
    }, { a: { ...songA, n: itunesTrackId(songA.id) }, b: { ...songB, n: itunesTrackId(songB.id) } });
    const s1 = await sock({ role: 'student', device: 'apple-test-device-0001', nick: 'Ann' });
    s1.send(JSON.stringify({ t: 'suggest', song: songA.id }));
    await until(() => s1.msgs.find((m) => m.t === 'suggested'), { timeout: 20_000 });
    s1.send(JSON.stringify({ t: 'suggest', song: songB.id }));
    await until(() => s1.msgs.filter((m) => m.t === 'suggested').length >= 2, { timeout: 20_000 });
    check('room test: two songs queued', s1.msgs.filter((m) => m.t === 'suggested' && m.ok).length === 2, JSON.stringify(s1.msgs.filter((m) => m.t === 'suggested')));

    await p.page.click('#startBtn');
    const skipped = await until(async () => /explicit version/.test(await toasts(p)), { timeout: 15_000 });
    check('explicit-only song skipped with a notice', Boolean(skipped), await toasts(p));
    const queued = await until(() => p.page.evaluate(() => window.__fakeKit.queued.length && window.__fakeKit.queued), { timeout: 15_000 });
    check('clean song goes into Apple\'s queue alone, by its id', queued?.length === 1 && queued[0].song === String(itunesTrackId(songB.id)), JSON.stringify(queued));
    check('the explicit song never went into Apple\'s queue', !(queued ?? []).some((q) => q.song === String(itunesTrackId(songA.id))));
    await p.page.evaluate(() => {
      const k = window.__fakeKit;
      k.currentPlaybackTime = 100; k.currentPlaybackDuration = 200;
      k.emit('playbackTimeDidChange', {});
    });
    await p.page.waitForTimeout(200);
    const width = await p.page.$eval('#progressBar', (e) => e.style.width);
    check('progress bar follows MusicKit', /^50/.test(width), width);
    await p.page.evaluate(() => window.__fakeKit.emit('playbackStateDidChange', { state: 10 }));
    const moved = await until(() => { const s = host.msgs.findLast((m) => m.t === 'state')?.state; return s && !s.nowPlaying && s.queue.length === 0; }, { timeout: 10_000 });
    check('end of the Apple Music song moves the room on', Boolean(moved));
    await p.page.click('#appleBtn');
    await until(async () => (await p.page.locator('#appleBtn').textContent()) === 'Connect Apple Music');
    check('Disconnect: unauthorized, Connect Apple Music again', (await p.page.evaluate(() => window.__fakeKit.isAuthorized)) === false
      && (await p.page.locator('#appleBtn').textContent()) === 'Connect Apple Music');
    check('no page errors (fake MusicKit room)', p.errors.length === 0, p.errors.join(' | '));
    host.close();
    s1.close();
    await closeRoom(p);
    await p.ctx.close();
  }
} catch (e) {
  failures++;
  console.log(`FAIL test crashed: ${e?.stack || e}`);
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
