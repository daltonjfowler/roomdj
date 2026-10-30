// Browser test of Spotify on the host page, with NO real Spotify login: installed Chrome
// (playwright-core) against a LOCAL wrangler dev that has SPOTIFY_CLIENT_ID set.
//   npm run dev, then:  node test/browser/spotify.mjs [http://127.0.0.1:8792/]
// It checks:
//   1. Spotify not set up (/api/config answered by the test): no picker, previews only.
//   2. The picker, and Connect Spotify going to Spotify's login page with correct PKCE parameters
//      (the request to accounts.spotify.com is caught and never sent).
//   3. The way back: a wrong state is refused; the right state swaps the code for tokens (token
//      endpoint answered by the test), the code leaves the address bar, Disconnect clears them.
//   4. The real Web Playback SDK loads under the page's CSP (a fake token, so Spotify refuses it).
//   5. A room playing through a FAKE SDK and a fake Web API: an explicit-only song is skipped with
//      a notice, a clean one starts on the RoomDJ device, and its end moves the room on.
//   6. Songs that must NOT end early (Dalton's "starts, skips in seconds"): a relinked uri 3 s in
//      (same name), buffering (paused at 0 at the start, our uri in previous_tracks from an earlier
//      play), a one-off state of another song; then a real end that does move on. The Spotify
//      details link + dialog show what the player saw.
// Reads TEACHER_KEY from .dev.vars and never prints it. Searches hit the real iTunes API.

import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pkceChallenge } from '../../shared/spotify.js';
import { T1, pickTeacher } from './teacher-pick.mjs';
import { reveal } from './ui.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = fileURLToPath(new URL('./.out/', import.meta.url));
const ROOT = new URL('../../', import.meta.url);
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
async function until(fn, { timeout = 10_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}

const config = await (await fetch(new URL('api/config', BASE))).json();
const CLIENT_ID = config.services?.spotify?.clientId;
if (!check('/api/config offers Spotify (SPOTIFY_CLIENT_ID is set)', Boolean(CLIENT_ID), JSON.stringify(config))) process.exit(1);

// Playwright turns off Chrome's component updates, which also turns off Widevine (the DRM the
// Spotify player needs): keep it on.
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
  const page = await ctx.newPage();
  const p = { ctx, page, errors: [], csp: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => {
    if (/Content Security Policy|Permissions policy/i.test(m.text())) p.csp.push(m.text());
  });
  return p;
}
const toasts = (p) => p.page.locator('#toasts').textContent();
/** Open a room on the host page (the picker lives on the room screen) with its suggested class code. */
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
    await p.page.route('**/api/config', (r) => r.fulfill({ json: { services: { preview: true, spotify: false, youtube: false, apple: false }, teacherKey: true } }));
    await p.page.goto(HOST);
    await openRoom(p);
    await p.page.waitForTimeout(500);
    check('not set up: no Music from picker', !(await p.page.locator('#musicFrom').isVisible()));
    check('not set up: previews', /30-second|previews/i.test(await p.page.locator('#playerNote').textContent()));
    await closeRoom(p);
    await p.ctx.close();
  }

  // ---- 2. Picker + Connect builds the authorize URL ----
  let pending;
  {
    const p = await newHost();
    await p.page.goto(HOST);
    await openRoom(p);
    await until(() => p.page.locator('#musicFrom').isVisible());
    const options = await p.page.$$eval('#service option', (els) => els.map((e) => e.value));
    check('picker lists previews and Spotify', options.includes('preview') && options.includes('spotify'), options.join(','));
    check('picker starts on previews', (await p.page.inputValue('#service')) === 'preview');
    check('no Spotify button on previews', !(await p.page.locator('#spotifyBtn').isVisible()));
    await p.page.selectOption('#service', 'spotify');
    check('Spotify picked: Connect Spotify shows', (await p.page.locator('#spotifyBtn').textContent()) === 'Connect Spotify');
    check('Spotify picked: Premium note shows', /Premium/.test(await p.page.locator('#musicNote').textContent()));
    check('choice remembered on this computer', (await p.page.evaluate(() => localStorage.getItem('cq.music:teacher-1'))) === 'spotify');

    let authUrl = null;
    await p.page.route('https://accounts.spotify.com/**', (r) => {
      authUrl = r.request().url();
      return r.fulfill({ status: 200, contentType: 'text/html', body: '<p>Spotify login (test stand-in)</p>' });
    });
    await p.page.click('#spotifyBtn');
    await until(() => authUrl);
    const u = new URL(authUrl);
    const q = Object.fromEntries(u.searchParams);
    check('Connect goes to accounts.spotify.com/authorize', `${u.origin}${u.pathname}` === 'https://accounts.spotify.com/authorize', authUrl);
    check('authorize: client_id', q.client_id === CLIENT_ID);
    check('authorize: response_type=code, S256', q.response_type === 'code' && q.code_challenge_method === 'S256');
    check('authorize: redirect_uri is <origin>/host/', q.redirect_uri === HOST, q.redirect_uri);
    check('authorize: scopes', q.scope === 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-modify-private', q.scope); // playlist-modify-private: ⭐ RoomDJ Favs
    await p.page.goBack().catch(() => {});
    await p.page.waitForURL(/\/host\//).catch(() => {});
    pending = await p.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.spotifyLogin')));
    check('verifier + state kept in sessionStorage', pending && pending.state === q.state && /^[\w-]{43,128}$/.test(pending.verifier));
    check('code_challenge = S256(verifier)', pending && q.code_challenge === await pkceChallenge(pending.verifier));
    check('no secret in the authorize URL', !/secret/i.test(authUrl));
    check('no CSP errors (picker + login)', p.csp.length === 0, p.csp.join(' | '));

    // ---- 3. The way back ----
    let tokenBody = null;
    await p.page.unroute('https://accounts.spotify.com/**');
    await p.page.route('https://accounts.spotify.com/api/token', (r) => {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
      tokenBody = r.request().postData();
      return r.fulfill({ status: 200, headers: CORS, json: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, token_type: 'Bearer' } });
    });
    // A wrong state first (as if someone sent the teacher a crafted link).
    await p.page.goto(`${HOST}?code=evil&state=wrong`);
    await until(async () => /did not come from this page/.test(await toasts(p)));
    check('wrong state: refused', /did not come from this page/.test(await toasts(p)));
    check('wrong state: no token request', tokenBody === null);
    check('wrong state: code removed from the address bar', !/code=/.test(p.page.url()), p.page.url());
    // The real way back (the pending login is gone after a refused try, so put it back).
    await p.page.evaluate((v) => sessionStorage.setItem('cq.spotifyLogin', JSON.stringify(v)), pending);
    await p.page.goto(`${HOST}?code=CODE123&state=${encodeURIComponent(pending.state)}`);
    await until(async () => /Spotify is connected/.test(await toasts(p)));
    check('room rejoined after the login', await until(() => p.page.locator('#bigCode').isVisible()));
    check('right state: connected', /Spotify is connected/.test(await toasts(p)));
    const body = Object.fromEntries(new URLSearchParams(tokenBody ?? ''));
    check('token swap: code + verifier + redirect_uri, no secret', body.grant_type === 'authorization_code' && body.code === 'CODE123'
      && body.code_verifier === pending.verifier && body.redirect_uri === HOST && body.client_id === CLIENT_ID && !('client_secret' in body), tokenBody);
    check('code removed from the address bar', !/code=|state=/.test(p.page.url()), p.page.url());
    const saved = await p.page.evaluate(() => JSON.parse(localStorage.getItem('cq.spotify')));
    check('tokens saved on this computer only', saved?.access === 'AT1' && saved?.refresh === 'RT1' && saved?.clientId === CLIENT_ID);
    check('Spotify picked after login', (await p.page.inputValue('#service')) === 'spotify');
    check('button says Disconnect Spotify', (await p.page.locator('#spotifyBtn').textContent()) === 'Disconnect Spotify');
    await p.page.click('#spotifyBtn');
    check('Disconnect clears the tokens', (await p.page.evaluate(() => localStorage.getItem('cq.spotify'))) === null);
    check('after Disconnect: Connect Spotify again', (await p.page.locator('#spotifyBtn').textContent()) === 'Connect Spotify');
    check('no page errors (login)', p.errors.length === 0, p.errors.join(' | '));

    // ---- 4. The real SDK under the page's CSP ----
    const sdk = await p.page.evaluate(() => new Promise((resolve) => {
      const done = (what) => resolve({ what, frames: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src, allow: f.allow })) });
      document.addEventListener('securitypolicyviolation', (e) => done(`csp ${e.violatedDirective} ${e.blockedURI}`));
      const go = () => {
        const player = new window.Spotify.Player({ name: 'CSP test', getOAuthToken: (cb) => cb('not-a-real-token') });
        for (const ev of ['ready', 'initialization_error', 'authentication_error', 'account_error']) player.addListener(ev, () => done(ev));
        player.connect();
      };
      // The page's own Spotify player may have loaded the SDK already (while the fake login was on).
      if (window.Spotify?.Player) return go();
      window.onSpotifyWebPlaybackSDKReady = go;
      const s = document.createElement('script');
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      s.onerror = () => done('script blocked');
      document.head.append(s);
      setTimeout(() => done('timeout'), 20_000);
    }));
    check('real SDK loads and talks to Spotify under the CSP (fake token → authentication_error)', sdk.what === 'authentication_error', JSON.stringify(sdk));
    check('no CSP or permissions-policy console errors with the SDK', p.csp.length === 0, p.csp.join(' | '));
    console.log(`  SDK iframes: ${JSON.stringify(sdk.frames)}`);
    await closeRoom(p);
    await p.ctx.close();
  }

  // ---- 5. A room through a fake SDK and a fake Web API ----
  {
    const p = await newHost({
      init: {
        fn: (clientId) => {
          if (!localStorage.getItem('cq.spotify')) {
            localStorage.setItem('cq.spotify', JSON.stringify({ access: 'AT', refresh: 'RT', expiresAt: Date.now() + 3_600_000, clientId }));
            localStorage.setItem('cq.music', 'spotify');
          }
        },
        arg: CLIENT_ID,
      },
    });
    const plays = [];
    let explicitTitle = '';
    await p.page.route('https://sdk.scdn.co/spotify-player.js', (r) => r.fulfill({
      contentType: 'text/javascript',
      body: `window.Spotify = { Player: class {
        constructor(o) { this.o = o; this.l = {}; window.__fake = this; }
        addListener(e, f) { this.l[e] = f; return true; }
        connect() { setTimeout(() => this.l.ready?.({ device_id: 'DEV1' }), 50); return Promise.resolve(true); }
        activateElement() { window.__activated = (window.__activated || 0) + 1; return Promise.resolve(); }
        getCurrentState() { return Promise.resolve(window.__state || null); }
        pause() { window.__pauses = (window.__pauses || 0) + 1; return Promise.resolve(); }
        resume() { return Promise.resolve(); }
        setVolume() { return Promise.resolve(); }
        disconnect() {}
        emit(s) { window.__state = s; this.l.player_state_changed?.(s); }
      } };
      window.onSpotifyWebPlaybackSDKReady?.();`,
    }));
    const favs = { made: [], added: [] };
    // A passing 403 (Dalton, 2026-10-29: "says connect a premium Spotify account and refuse to play"):
    // the next N play requests are refused with Spotify's non-Premium reason; transfers are recorded.
    const refuse = { left: 0, seen: 0 };
    const transfers = [];
    await p.page.route('https://api.spotify.com/**', async (r) => {
      const req = r.request();
      if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
      const url = new URL(req.url());
      if (url.pathname === '/v1/search') {
        const q = url.searchParams.get('q');
        const title = (q.match(/track:"([^"]*)"/) ?? [])[1] ?? q;
        const artist = (q.match(/artist:"([^"]*)"/) ?? [])[1] ?? '';
        const id = title.replace(/\W+/g, '').toLowerCase();
        const explicit = explicitTitle && title.toLowerCase().includes(explicitTitle.toLowerCase());
        return r.fulfill({ headers: CORS, json: { tracks: { items: [{ uri: `spotify:track:${id}`, name: title, artists: [{ name: artist }], duration_ms: 0, explicit }] } } });
      }
      if (url.pathname === '/v1/me/player/play' && refuse.left > 0) {
        refuse.left--;
        refuse.seen++;
        return r.fulfill({ status: 403, headers: CORS, json: { error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'UNKNOWN' } } });
      }
      if (url.pathname === '/v1/me/player' && req.method() === 'PUT') {
        transfers.push(JSON.parse(req.postData() || '{}'));
        return r.fulfill({ status: 204, headers: CORS });
      }
      if (url.pathname === '/v1/me/player/play') {
        plays.push({ device: url.searchParams.get('device_id'), body: JSON.parse(req.postData() || '{}') });
        return r.fulfill({ status: 204, headers: CORS });
      }
      // ⭐ RoomDJ Favs (players/spotify.js saveToFavs): who am I, make the playlist, add to it.
      if (url.pathname === '/v1/me' && req.method() === 'GET') return r.fulfill({ headers: CORS, json: { id: 'teacher-one', product: 'premium' } });
      if (url.pathname === '/v1/me/playlists' && req.method() === 'POST') {
        favs.made.push(JSON.parse(req.postData() || '{}'));
        return r.fulfill({ status: 201, headers: CORS, json: { id: 'PLFAVS' } });
      }
      if (url.pathname === '/v1/playlists/PLFAVS/items' && req.method() === 'POST') {
        favs.added.push(...(JSON.parse(req.postData() || '{}').uris ?? []));
        return r.fulfill({ status: 201, headers: CORS, json: { snapshot_id: 'x' } });
      }
      return r.fulfill({ status: 404, headers: CORS, json: {} });
    });

    await p.page.goto(HOST);
    await openRoom(p);
    await until(() => p.page.locator('#musicFrom').isVisible());
    check('room test: Spotify remembered', (await p.page.inputValue('#service')) === 'spotify');
    const room = await p.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
    const id = room.room;
    // The test's student device joins with the class code first (only admitted devices get in).
    await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': 'spotify-test-device-01', 'content-type': 'application/json' }, body: JSON.stringify({ code: room.classCode }) });
    const wsBase = BASE.replace(/^http/, 'ws');
    const sock = (params) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}api/rooms/${id}/ws?${new URLSearchParams(params)}`);
      ws.msgs = [];
      ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
      ws.onopen = () => resolve(ws);
      ws.onerror = reject;
    });
    const host = await sock({ role: 'host', token: room.token });
    host.send(JSON.stringify({ t: 'settings', settings: { maxWaitingPerStudent: 2, removeAtScore: -3, blockUnknownSongs: false, aiCheck: false, blocklist: [], cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false } }));
    await until(() => host.msgs.find((m) => m.t === 'state' && !m.state.settings.aiCheck));

    const find = async (q) => {
      const r = await fetch(new URL(`api/rooms/${id}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': 'spotify-test-device-01' } });
      return (await r.json()).results[0];
    };
    const songA = await find('Happy Pharrell Williams');
    const songB = await find('Shake It Off Taylor Swift');
    const songC = await find('Firework Katy Perry');
    explicitTitle = songA.title.split(' (')[0];
    const s1 = await sock({ role: 'student', device: 'spotify-test-device-01', nick: 'Ann' });
    s1.send(JSON.stringify({ t: 'suggest', song: songA.id }));
    await until(() => s1.msgs.find((m) => m.t === 'suggested'), { timeout: 20_000 });
    s1.send(JSON.stringify({ t: 'suggest', song: songB.id }));
    await until(() => s1.msgs.filter((m) => m.t === 'suggested').length >= 2, { timeout: 20_000 });
    check('room test: two songs queued', s1.msgs.filter((m) => m.t === 'suggested' && m.ok).length === 2, JSON.stringify(s1.msgs.filter((m) => m.t === 'suggested')));

    // ⭐ Save to RoomDJ Favs from a waiting song's ⋯ menu (2026-10-20), not only the song playing.
    const rowB = await until(() => host.msgs.findLast((m) => m.t === 'state')?.state.queue.find((q) => q.song.id === songB.id)?.id);
    const favItem = `#queue [data-id="${rowB}"] button[data-act="favs"]`;
    await reveal(p.page, favItem);
    await p.page.click(favItem);
    const saved = await until(async () => /Saved .* to RoomDJ Favs/.test(await toasts(p)), { timeout: 10_000 });
    check('queue ⋯ menu: ⭐ Save to RoomDJ Favs adds that waiting song', Boolean(saved) && favs.made.length === 1 && favs.made[0].public === false
      && favs.added.length === 1 && favs.added[0].includes(songB.title.split(' (')[0].replace(/\W+/g, '').toLowerCase()), JSON.stringify({ favs, t: await toasts(p) }));
    await reveal(p.page, favItem);
    await p.page.click(favItem);
    const again = await until(async () => /already in RoomDJ Favs/.test(await toasts(p)), { timeout: 10_000 });
    check('the same song again: "already in RoomDJ Favs", not added twice', Boolean(again) && favs.added.length === 1);

    await p.page.click('#startBtn');
    const skipped = await until(async () => /explicit version/.test(await toasts(p)), { timeout: 15_000 });
    check('explicit-only song skipped with a notice', Boolean(skipped), await toasts(p));
    const started = await until(() => plays.length > 0, { timeout: 15_000 });
    check('clean song started on the RoomDJ device, one track, no Spotify queue', started && plays[0].device === 'DEV1'
      && plays[0].body.uris?.length === 1 && plays.length === 1, JSON.stringify(plays));
    check('no explicit track was ever started', !plays.some((x) => x.body.uris?.some((u) => u.includes(explicitTitle.replace(/\W+/g, '').toLowerCase()))));
    check('activateElement called on the Start music click', (await p.page.evaluate(() => window.__activated || 0)) > 0);
    const uri = plays[0]?.body.uris?.[0];
    const state = (over) => ({ paused: false, position: 1000, duration: 200_000, track_window: { current_track: { uri, name: songB.title }, previous_tracks: [] }, ...over });
    await p.page.evaluate((s) => window.__fake.emit(s), state({}));
    await p.page.evaluate((s) => window.__fake.emit(s), state({ position: 100_000 }));
    await p.page.waitForTimeout(300);
    const width = await p.page.$eval('#progressBar', (e) => e.style.width);
    check('progress bar follows the Spotify state', /^4\d|^5\d/.test(width), width);
    check('still on the clean song mid-way', Boolean(host.msgs.findLast((m) => m.t === 'state')?.state.nowPlaying));
    // Another device takes the music (the SDK says: no state), then Start music brings it back.
    await p.page.evaluate(() => window.__fake.emit(null));
    const movedNote = await until(async () => {
      const w = p.page.locator('#playerWarn');
      return (await w.isVisible()) && /moved to another device/.test(await w.textContent());
    }, { timeout: 5_000 });
    check('another device took over: notice on the host', Boolean(movedNote));
    check('another device took over: Start music shows again', await p.page.locator('#startBtn').isVisible());
    check('another device took over: the room keeps the song', Boolean(host.msgs.findLast((m) => m.t === 'state')?.state.nowPlaying));
    await p.page.click('#startBtn');
    const back = await until(() => plays.length === 2, { timeout: 10_000 });
    check('Start music starts it here again, where it was', back && plays[1].device === 'DEV1' && plays[1].body.uris?.[0] === uri
      && plays[1].body.position_ms === 100_000, JSON.stringify(plays.at(-1)));
    await p.page.evaluate((s) => window.__fake.emit(s), state({ position: 100_500 }));
    await until(async () => !(await p.page.locator('#playerWarn').isVisible()), { timeout: 3_000 });
    check('notice goes away when the music is back', !(await p.page.locator('#playerWarn').isVisible()));
    await p.page.evaluate((s) => window.__fake.emit(s), state({ position: 198_500 }));
    await p.page.evaluate((s) => window.__fake.emit(s), state({ paused: true, position: 0, track_window: { current_track: { uri, name: songB.title }, previous_tracks: [{ uri }] } }));
    const moved = await until(() => { const s = host.msgs.findLast((m) => m.t === 'state')?.state; return s && !s.nowPlaying && s.queue.length === 0; }, { timeout: 10_000 });
    check('end of the Spotify track moves the room on', Boolean(moved));

    // ---- 6. Never end early ----
    const nowId = () => host.msgs.findLast((m) => m.t === 'state')?.state.nowPlaying?.song?.id;
    refuse.left = 1; // Spotify refuses the third song once, for a reason that is not Premium
    s1.send(JSON.stringify({ t: 'suggest', song: songC.id }));
    await until(() => s1.msgs.filter((m) => m.t === 'suggested').length >= 3, { timeout: 20_000 });
    const playing = await until(() => nowId() === songC.id && plays.length === 3, { timeout: 15_000 });
    check('third song (relink test) starts', Boolean(playing), JSON.stringify({ now: nowId(), plays: plays.length }));
    check('a passing 403: a new speaker, playback moved to it, the song plays', refuse.seen === 1 && transfers.length === 1 && transfers[0].device_ids?.[0] === 'DEV1', JSON.stringify({ refuse, transfers }));
    check('a passing 403: never "needs Premium"', !/Premium/.test(await toasts(p)) && !/Premium/.test(await p.page.locator('#playerWarn').textContent().catch(() => '')), await toasts(p));
    const uriC = plays[2]?.body.uris?.[0];
    const stC = (over, tw = {}) => ({ paused: false, position: 1000, duration: 200_000,
      track_window: { current_track: { uri: uriC, name: songC.title }, previous_tracks: [], ...tw }, ...over });
    const emit = (st) => p.page.evaluate((x) => window.__fake.emit(x), st);
    const relinked = 'spotify:track:relinkedcopy';
    // Buffering at the start, with our uri left in previous_tracks from an earlier play.
    await emit(stC({ position: 200 }));
    await emit(stC({ paused: true, position: 0 }, { previous_tracks: [{ uri: uriC }] }));
    await p.page.waitForTimeout(1200); // polls see the same paused-at-0 state
    await emit(stC({ position: 1500 }, { previous_tracks: [{ uri: uriC }] }));
    // 3 s in, Spotify reports a relinked uri for the same song, and keeps it.
    await p.page.waitForTimeout(1500);
    await emit(stC({ position: 3000 }, { current_track: { uri: relinked, name: songC.title } }));
    await p.page.waitForTimeout(2500);
    await emit(stC({ position: 5500 }, { current_track: { uri: relinked, name: songC.title } }));
    // A single stray state of another song, then ours again.
    await emit(stC({ position: 6000 }, { current_track: { uri: 'spotify:track:stray', name: 'Some Other Song' } }));
    await emit(stC({ position: 6100 }, { current_track: { uri: relinked, name: songC.title } }));
    await p.page.waitForTimeout(2000);
    check('relink + buffering + stray state: the room does NOT move on', nowId() === songC.id, `now ${nowId()}`);
    check('relink: no skip message', !(await toasts(p)).includes(songC.title), await toasts(p));
    check('relink: no extra play request', plays.length === 3, JSON.stringify(plays.slice(3)));

    // Spotify details: the link is there with Spotify, and the dialog shows the decisions.
    check('Spotify details link shows with the Spotify player', await p.page.locator('#spotifyDetailsBtn').isVisible());
    await p.page.click('#spotifyDetailsBtn');
    const details = await p.page.inputValue('#spotifyDetailsText');
    check('details: relink and the ignored states are logged', /relink/.test(details) && /early-paused-0/.test(details) && /maybe-other/.test(details), details);
    check('details: no token in the text', !/Bearer|access_token|refresh/i.test(details), details);
    await p.page.click('#spotifyDetailsDlg button[value="done"]');

    // The real end, on the relinked uri: near the end, then paused at 0.
    await emit(stC({ position: 197_000 }, { current_track: { uri: relinked, name: songC.title } }));
    await emit(stC({ paused: true, position: 0 }, { current_track: { uri: relinked, name: songC.title }, previous_tracks: [{ uri: relinked }] }));
    const done = await until(() => { const s = host.msgs.findLast((m) => m.t === 'state')?.state; return s && !s.nowPlaying; }, { timeout: 10_000 });
    check('a real end after the relink moves the room on', Boolean(done));

    check('no CSP errors (room)', p.csp.length === 0, p.csp.join(' | '));
    check('no page errors (room)', p.errors.length === 0, p.errors.join(' | '));
    if (failures) await p.page.screenshot({ path: `${OUT}spotify-room.png` }).catch(() => {});
    host.send(JSON.stringify({ t: 'close' }));
    await new Promise((r) => setTimeout(r, 300));
    for (const ws of [host, s1]) ws.close();
    await p.ctx.close();
  }
} catch (e) {
  failures++;
  console.log(`FAIL crashed: ${e?.stack || e}`);
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
