// Browser test of the song search from Spotify's catalog (src/spotify-catalog.js), with NO real
// Spotify secret: this script runs a FAKE Spotify (token + Web API) on 127.0.0.1, and a LOCAL
// wrangler dev is started with a throwaway secret and SPOTIFY_TEST_BASE pointing at it:
//   npm run build
//   npx wrangler dev --ip 127.0.0.1 --port 8797 --local-upstream 127.0.0.1:8797 \
//     --var SPOTIFY_CLIENT_SECRET:local-test-not-a-secret --var SPOTIFY_TEST_BASE:http://127.0.0.1:8798
//   node test/browser/catalog.mjs [http://127.0.0.1:8797/]      (FAKE_SPOTIFY_PORT to move the fake)
// The Worker takes SPOTIFY_TEST_BASE only as a loopback http address, so this cannot be done to the
// deployed site. It checks:
//   1. /api/config says the Spotify catalog is on (and never shows the secret).
//   2. A host page playing through Spotify tells its room ('service'), and the student page's
//      search comes from Spotify: two pages of 10, sp: ids, the Spotify credit, and every song
//      linking back to Spotify (a 44 px target, new tab). The fake saw the app's Basic auth.
//   3. Suggest a Spotify song: it joins the queue (sp: id) with the Spotify mark on both pages.
//   4. An explicit song comes back as its clean version (the extra track:/artist: search).
//   5. AI check on: a Spotify song is never sent to the AI; it waits in Needs a look, and the
//      host page says why.
//   6. A suggestion of a Spotify id the room never searched is looked up (GET /v1/tracks/{id}).
//   7. The host switches to Song previews: searches are iTunes again, a Spotify id is refused,
//      and the queued Spotify song is skipped on the host with a notice.
//   8. Spotify busy (a long Retry-After): the room search falls back to iTunes. Last, since the
//      Worker then backs off Spotify for a minute (and keeps spotify:backoff in local KV that long):
//      wait a minute, or restart wrangler dev, before running it again.
// Reads TEACHER_KEY from .dev.vars and never prints it. Searches in step 7 and 8 hit the real
// iTunes API. Screenshots of failures go to test/browser/.out/.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T1, pickTeacher } from './teacher-pick.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8797/';
const FAKE_PORT = Number(process.env.FAKE_SPOTIFY_PORT || 8798);
const SECRET = 'local-test-not-a-secret'; // pragma: allowlist secret (made-up test value)
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

// ---- The fake Spotify -------------------------------------------------------------------------

// Words and ids carry a run id: the Worker caches searches (a day), tracks (a week) and its token in KV.
const RUN = `r${Date.now().toString(36)}`;
const tid = (name) => createHash('md5').update(name).digest('hex').slice(0, 22);
const tracks = new Map(); // id → track object, for GET /v1/tracks/{id}
function makeTrack(name, { artist = 'Fake Artist', explicit = false, ms = 200_000 } = {}) {
  const id = tid(`${name}|${artist}|${explicit}`);
  const t = {
    type: 'track', id, uri: `spotify:track:${id}`, name, artists: [{ type: 'artist', id: tid(artist), name: artist }],
    album: { name: `${name} (Single)`, images: [
      { url: `https://i.scdn.co/image/${tid(`${name}640`)}`, width: 640, height: 640 },
      { url: `https://i.scdn.co/image/${tid(`${name}300`)}`, width: 300, height: 300 },
    ] },
    duration_ms: ms, explicit, is_local: false, is_playable: true,
  };
  tracks.set(id, t);
  return t;
}
const LOOKUP_ONLY = makeTrack(`Lookup Only Song ${RUN}`, { artist: 'Hidden Band' });
const seen = { token: 0, basicOk: 0, search: [], lookups: [] };

function searchAnswer(q, offset) {
  if (q === `busy song ${RUN}`) return { status: 429, headers: { 'retry-after': '31' }, body: { error: { status: 429, message: 'API rate limit exceeded' } } };
  let items;
  if (q === `track:"swear song ${RUN}" artist:"test band"`) items = [makeTrack(`Swear Song ${RUN}`, { artist: 'Test Band', ms: 201_000 })];
  else if (q === `swear song ${RUN}`) items = [makeTrack(`Swear Song ${RUN}`, { artist: 'Test Band', explicit: true })];
  else items = Array.from({ length: 13 }, (_, i) => makeTrack(`${q} ${i + 1}`)).slice(offset, offset + 10);
  const total = q === `swear song ${RUN}` || q.startsWith('track:') ? items.length : 13;
  return { status: 200, body: { tracks: { items, limit: 10, offset, total, next: offset + 10 < total ? 'next-page' : null, previous: null } } };
}

const fake = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${FAKE_PORT}`);
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && url.pathname === '/api/token') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.token++;
      const basic = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
      if (basic.endsWith(`:${SECRET}`) && body === 'grant_type=client_credentials') seen.basicOk++;
      else return send(400, { error: 'invalid_client' });
      send(200, { access_token: 'fake-app-token', token_type: 'Bearer', expires_in: 3600 });
    });
    return;
  }
  if (req.headers.authorization !== 'Bearer fake-app-token') return send(401, { error: { status: 401, message: 'No token provided' } });
  if (url.pathname === '/v1/search') {
    const q = url.searchParams.get('q');
    seen.search.push({ q, offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit'), market: url.searchParams.get('market') });
    const a = searchAnswer(q, Number(url.searchParams.get('offset') || 0));
    return send(a.status, a.body, a.headers);
  }
  const m = url.pathname.match(/^\/v1\/tracks\/([0-9A-Za-z]{22})$/);
  if (m) {
    seen.lookups.push(m[1]);
    return tracks.has(m[1]) ? send(200, tracks.get(m[1])) : send(404, { error: { status: 404, message: 'Not found' } });
  }
  send(404, { error: { status: 404 } });
});
await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

// ---- Pages --------------------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=document-user-activation-required'] });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

async function openPage(name, path, { init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (init) await ctx.addInitScript(init);
  // Album art of the fake tracks: a 1 px picture instead of Spotify's CDN.
  await ctx.route('https://i.scdn.co/**', (r) => r.fulfill({ contentType: 'image/png', body: PNG }));
  // The host's Spotify player script: a stand-in (no login here, so it never plays).
  await ctx.route('https://sdk.scdn.co/**', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.onSpotifyWebPlaybackSDKReady?.();' }));
  const page = await ctx.newPage();
  const p = { name, ctx, page, msgs: [], errors: [], csp: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) p.csp.push(m.text());
    else if (m.type() === 'error') p.errors.push(m.text());
  });
  page.on('websocket', (ws) => ws.on('framereceived', (f) => { try { p.msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ } }));
  await page.goto(new URL(path, BASE).href);
  return p;
}
const lastState = (p) => [...p.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const text = (p, sel) => p.page.locator(sel).textContent();

async function studentSearch(p, q) {
  const before = await text(p, '#searchMsg');
  await p.page.fill('#q', q);
  await p.page.press('#q', 'Enter');
  await until(async () => {
    const t = await text(p, '#searchMsg');
    return t !== 'Searching…' && (t !== before || /found/.test(t)) && /found|not|Wait/.test(t);
  }, { timeout: 15_000 });
  return p.page.$$eval('#results li[data-id]', (els) => els.map((e) => e.dataset.id));
}
async function suggestOnPage(p, id) {
  const n = p.msgs.length;
  await p.page.click(`#results li[data-id="${id}"] button[data-act="suggest"]`);
  return until(() => p.msgs.slice(n).find((m) => m.t === 'suggested' && m.song === id), { timeout: 20_000 });
}

const pages = [];
let hostWs = null;
try {
  // ---- 1. config ----
  const configText = await (await fetch(new URL('api/config', BASE))).text();
  const config = JSON.parse(configText);
  check('config: Spotify catalog on', config.services?.spotify?.catalog === true, configText);
  check('config: the secret is never sent', !configText.includes(SECRET));

  // ---- 2. host plays through Spotify; the student's search comes from Spotify ----
  const host = await openPage('host', 'host/', { init: () => { try { localStorage.setItem('cq.music', 'spotify'); } catch { /* blocked */ } } });
  pages.push(host);
  await pickTeacher(host.page, KEY);
  await host.page.click('#openBtn');
  const opened = await until(async () => (await host.page.locator('#bigCode').textContent())?.trim(), { timeout: 15_000 });
  check('host: room open, Music from Spotify', Boolean(opened) && (await until(async () => (await host.page.inputValue('#service')) === 'spotify')));
  const room = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const wsBase = BASE.replace(/^http/, 'ws');
  hostWs = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}api/rooms/${room.room}/ws?${new URLSearchParams({ role: 'host', token: room.token })}`);
    ws.msgs = [];
    ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
  });
  const hostSettings = (settings) => hostWs.send(JSON.stringify({ t: 'settings', settings }));
  hostSettings({ aiCheck: false, maxWaitingPerStudent: 5, backToWork: false });
  await until(() => hostWs.msgs.find((m) => m.t === 'state' && !m.state.settings.aiCheck));

  const ann = await openPage('student', '');
  pages.push(ann);
  await ann.page.fill('#code', room.classCode);
  await ann.page.fill('#nick', 'Ann');
  await ann.page.click('#joinBtn');
  await until(() => ann.page.locator('#roomScreen').isVisible(), { timeout: 15_000 });

  const ids = await studentSearch(ann, `fake tune ${RUN}`);
  check('search: Spotify songs (sp: ids), two pages of 10 → 13', ids.length === 13 && ids.every((id) => /^sp:[0-9a-f]{22}$/.test(id)), JSON.stringify(ids));
  const pagesAsked = seen.search.filter((s) => s.q === `fake tune ${RUN}`);
  check('search: limit 10, market US, offsets 0 and 10', pagesAsked.length === 2 && pagesAsked.every((s) => s.limit === '10' && s.market === 'US')
    && pagesAsked.map((s) => s.offset).sort().join() === '0,10', JSON.stringify(pagesAsked));
  // At most once: a token from an earlier run may still be in the local KV.
  check('token: Client Credentials with the app\'s Basic auth, asked at most once', seen.token <= 1 && seen.basicOk === seen.token, JSON.stringify(seen.token));
  check('search: the Spotify credit shows', await ann.page.locator('#searchCredit').isVisible() && /Spotify/.test(await text(ann, '#searchCredit')));
  const link = await ann.page.$eval('#results li .sp-link', (a) => ({ href: a.href, target: a.target, rel: a.rel, ...a.getBoundingClientRect().toJSON() }));
  check('search: each song links back to Spotify (new tab, 44 px)', link.href === `https://open.spotify.com/track/${ids[0].slice(3)}`
    && link.target === '_blank' && /noopener/.test(link.rel) && link.width >= 44 && link.height >= 44, JSON.stringify(link));
  check('search: every row has its link', (await ann.page.locator('#results li .sp-link').count()) === ids.length);

  // ---- 3. suggest a Spotify song ----
  const ok = await suggestOnPage(ann, ids[0]);
  check('suggest: a Spotify song joins the queue', ok?.ok === true, JSON.stringify(ok));
  const queued = await until(() => lastState(host)?.queue.find((q) => q.song.id === ids[0]));
  check('suggest: the room has it under its sp: id, with no preview and the server\'s own details', Boolean(queued)
    && queued.song.previewUrl === '' && queued.song.title === `fake tune ${RUN} 1` && queued.song.artist === 'Fake Artist', JSON.stringify(queued?.song));
  check('suggest: no lookup needed (the room kept its search results)', seen.lookups.length === 0, JSON.stringify(seen.lookups));
  check('host: queue shows the Spotify mark', await until(() => host.page.locator('#queue .sp-link').count()) > 0);
  check('student: queue shows the Spotify mark', await until(() => ann.page.locator('#queue .sp-link').count()) > 0);

  // ---- 4. explicit → clean ----
  const swear = await studentSearch(ann, `swear song ${RUN}`);
  const cleanId = `sp:${tid(`Swear Song ${RUN}|Test Band|false`)}`;
  check('clean swap: the explicit track comes back as its clean version', swear.length === 1 && swear[0] === cleanId, JSON.stringify(swear));
  check('clean swap: one extra search by base title and main artist', seen.search.some((s) => s.q === `track:"swear song ${RUN}" artist:"test band"`));

  // ---- 5. AI on: Spotify songs never go to the AI ----
  hostSettings({ aiCheck: true, blockUnknownSongs: true });
  await until(() => hostWs.msgs.findLast((m) => m.t === 'state')?.state.settings.aiCheck);
  await studentSearch(ann, `fake tune ${RUN}`);
  const review = await suggestOnPage(ann, ids[1]);
  check('AI on: the Spotify song waits for the teacher (never sent to the AI)', review?.reason === 'review', JSON.stringify(review));
  check('AI on: the host\'s AI status stays ok', lastState(host)?.aiStatus === 'ok');
  check('host: Needs a look says why', await until(() => host.page.locator('#reviewSpotify').isVisible()));
  const rid = lastState(host)?.review.find((x) => x.song.id === ids[1])?.id;
  hostWs.send(JSON.stringify({ t: 'veto', id: rid }));
  hostSettings({ aiCheck: false });
  await until(() => !hostWs.msgs.findLast((m) => m.t === 'state')?.state.settings.aiCheck);

  // ---- 6. lookup of an id the room never searched ----
  const sock = await new Promise((resolve, reject) => {
    const device = 'catalog-test-device-01';
    fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code: room.classCode }) })
      .then(() => {
        const ws = new WebSocket(`${wsBase}api/rooms/${room.room}/ws?${new URLSearchParams({ role: 'student', device, nick: 'Bo' })}`);
        ws.msgs = [];
        ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
        ws.onopen = () => resolve(ws);
        ws.onerror = reject;
      }, reject);
  });
  sock.send(JSON.stringify({ t: 'suggest', song: `sp:${LOOKUP_ONLY.id}` }));
  const looked = await until(() => sock.msgs.find((m) => m.t === 'suggested'), { timeout: 15_000 });
  check('lookup: an unsearched Spotify id is fetched by GET /v1/tracks/{id}', looked?.ok === true && seen.lookups.includes(LOOKUP_ONLY.id), JSON.stringify(looked));
  sock.send(JSON.stringify({ t: 'suggest', song: `sp:${'0'.repeat(22)}` }));
  const missing = await until(() => sock.msgs.filter((m) => m.t === 'suggested')[1], { timeout: 15_000 });
  check('lookup: an id Spotify does not have is "not found"', missing?.ok === false && missing.reason === 'unavailable', JSON.stringify(missing));

  // ---- 7. the host switches to previews ----
  await host.page.selectOption('#service', 'preview');
  const itunes = await until(async () => {
    const r = await fetch(new URL(`api/rooms/${room.room}/search?q=${encodeURIComponent('Happy Pharrell Williams')}`, BASE), { headers: { 'x-device': 'catalog-test-device-01' } });
    const body = await r.json();
    return body.catalog === 'itunes' ? body : null;
  });
  check('previews: the room search is iTunes again', Boolean(itunes) && itunes.results.every((s) => s.id.startsWith('it:')), JSON.stringify(itunes)?.slice(0, 200));
  sock.send(JSON.stringify({ t: 'suggest', song: ids[2] }));
  const refused = await until(() => sock.msgs.filter((m) => m.t === 'suggested')[2], { timeout: 15_000 });
  check('previews: a Spotify id is refused, with a plain reason', refused?.ok === false && /changed where the music comes from/.test(refused.message), JSON.stringify(refused));
  await host.page.click('#startBtn');
  const skipped = await until(async () => /came from Spotify, so only Spotify can play it/.test(await text(host, '#toasts')), { timeout: 15_000 });
  check('previews: the queued Spotify song is skipped on the host with a notice', Boolean(skipped), await text(host, '#toasts'));

  // ---- 8. Spotify busy → iTunes ----
  await host.page.selectOption('#service', 'spotify');
  await host.page.waitForTimeout(500);
  const busy = await (await fetch(new URL(`api/rooms/${room.room}/search?q=${encodeURIComponent(`busy song ${RUN}`)}`, BASE), { headers: { 'x-device': 'catalog-test-device-01' } })).json();
  check('busy: Spotify answered 429, the search came from iTunes', busy.catalog === 'itunes' && seen.search.some((s) => s.q === `busy song ${RUN}`), JSON.stringify(busy).slice(0, 200));

  for (const p of pages) {
    check(`no page errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
    check(`no CSP errors on ${p.name}`, p.csp.length === 0, p.csp.join(' | '));
  }
  sock.close();
} catch (e) {
  failures++;
  console.log(`FAIL crashed: ${e?.stack || e}`);
  for (const p of pages) await p.page.screenshot({ path: `${OUT}catalog-${p.name}.png` }).catch(() => {});
} finally {
  try { hostWs?.send(JSON.stringify({ t: 'close' })); } catch { /* gone */ }
  await new Promise((r) => setTimeout(r, 300));
  hostWs?.close();
  await browser.close();
  fake.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
