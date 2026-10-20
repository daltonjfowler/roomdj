// Browser test of "the teacher's computer searches" (src/host-relay.js, web/src/host-lookup.js):
// the room hands its iTunes calls to the host page, which fetches them from this computer.
// iTunes is stubbed in Playwright (route), so answers are fixed; the real iTunes run is in flows.mjs.
// Against a LOCAL wrangler dev started with ITUNES_SERVER_FETCH=off (so with no host the server does
// not try iTunes itself, and the "not answering" message shows even from a home address):
//   npm run build
//   npx wrangler dev --ip 127.0.0.1 --port 8799 --local-upstream 127.0.0.1:8799 --var ITUNES_SERVER_FETCH:off
//   node test/browser/relay.mjs [http://127.0.0.1:8799/]
// It checks:
//   1. A student's room search goes to the host page, which calls iTunes; the student sees the
//      songs the server mapped (bad shapes from the host left out), the explicit one as its clean
//      version.
//   2. Two students searching the same new words at once: one iTunes call.
//   3. Suggesting a song: taken from the room's own results (no call); a song id the room never
//      showed: the host page looks it up (/lookup?id=), and the room queues it with iTunes's details.
//   4. iTunes never answers the host page: "Your teacher's computer is not answering searches"
//      after about 5 seconds (the host page's own limit; the room's is 6). No host page at all: the same message, at once.
//   5. Browsing before joining searches iTunes from the student's own browser (CSP allows it).
// Reads TEACHER_KEY from .dev.vars and never prints it. Queries carry a run id (KV caches them a day).

import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T1, pickTeacher } from './teacher-pick.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8799/';
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
const KEY = readFileSync(new URL('.dev.vars', ROOT), 'utf8').split(/\r?\n/).find((l) => l.startsWith('TEACHER_KEY='))?.slice(12).trim().replace(/^"(.*)"$/, '$1');
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

// ---- The stub iTunes ----------------------------------------------------------------------------
const RUN = `r${Date.now().toString(36)}`;
const base = Number(Date.now() % 1e9) * 100; // fresh track ids each run
const track = (n, title, over = {}) => ({
  wrapperType: 'track', kind: 'song', trackId: base + n, trackName: title, artistName: 'Relay Band', collectionName: 'Relay LP',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/bb/source/100x100bb.jpg', trackTimeMillis: 200_000,
  trackExplicitness: 'notExplicit', previewUrl: `https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/${base + n}.m4a`, ...over,
});
const SONGS = {
  one: track(1, `Relay One ${RUN}`),
  two: track(2, `Relay Two ${RUN}`),
  rude: track(3, `Relay Rude ${RUN}`, { trackExplicitness: 'explicit' }),
  clean: track(4, `Relay Rude ${RUN}`, { trackExplicitness: 'cleaned' }),
  badId: track(5, `Relay Bad ${RUN}`, { trackId: `${base + 5}` }),
  badPreview: track(6, `Relay Bad Preview ${RUN}`, { previewUrl: 'http://evil.example/x.m4a' }),
  lookupOnly: track(7, `Relay Lookup ${RUN}`),
};
const calls = []; // [kind, term|id, page]
let stall = false;
async function itunesRoute(route, who) {
  const url = new URL(route.request().url());
  const reply = (results) => route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', headers: { 'access-control-allow-origin': '*' },
    body: `\n\n\n${JSON.stringify({ resultCount: results.length, results })}` });
  if (url.pathname === '/lookup') {
    calls.push(['lookup', url.searchParams.get('id'), who]);
    return reply(Object.values(SONGS).filter((s) => String(s.trackId) === url.searchParams.get('id')));
  }
  const term = url.searchParams.get('term');
  calls.push(['search', term, who]);
  if (stall) return; // never answers
  if (term.includes('same')) await new Promise((r) => setTimeout(r, 800)); // slow: both students ask meanwhile
  if (term.startsWith('relay')) return reply([SONGS.one, SONGS.two, SONGS.rude, SONGS.clean, SONGS.badId, SONGS.badPreview]);
  return reply([SONGS.one]);
}

// ---- Pages ---------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=document-user-activation-required'] });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
async function openPage(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('https://itunes.apple.com/**', (r) => itunesRoute(r, name));
  await ctx.route('https://*.mzstatic.com/**', (r) => r.fulfill({ contentType: 'image/png', body: PNG }));
  const page = await ctx.newPage();
  const p = { name, ctx, page, msgs: [], errors: [], csp: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) p.csp.push(m.text());
    // The room's 503 for "not answering" is expected in step 4.
    else if (m.type() === 'error' && !/503/.test(m.text())) p.errors.push(m.text());
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
    return t !== 'Searching…' && t !== before && /found|not|busy|Wait|moment/.test(t);
  }, { timeout: 15_000 });
  return p.page.$$eval('#results li[data-id]', (els) => els.map((e) => e.dataset.id));
}
async function join(name, code) {
  const p = await openPage(name, '');
  await p.page.fill('#code', code);
  await p.page.fill('#nick', name);
  await p.page.click('#joinBtn');
  await until(() => p.page.locator('#roomScreen').isVisible(), { timeout: 15_000 });
  return p;
}

const pages = [];
let hostWs = null;
try {
  // ---- browse before joining (5) ----
  const browsing = await openPage('browser', '');
  pages.push(browsing);
  await browsing.page.fill('#bq', `relay ${RUN} browse`);
  await browsing.page.press('#bq', 'Enter');
  const browsed = await until(async () => /songs? found/.test(await text(browsing, '#browseMsg')), { timeout: 15_000 });
  const shown = await browsing.page.$$eval('#browseResults li[data-id]', (els) => els.map((e) => e.dataset.id));
  check('browse: the student\'s own browser searched iTunes', Boolean(browsed) && calls.some(([k, t, who]) => k === 'search' && t.includes('browse') && who === 'browser'), JSON.stringify(calls));
  check('browse: clean version shown, explicit and broken results left out', shown.includes(`it:${SONGS.clean.trackId}`)
    && !shown.includes(`it:${SONGS.rude.trackId}`) && !shown.some((id) => id.endsWith(String(base + 5)) || id.endsWith(String(base + 6))), JSON.stringify(shown));
  await browsing.ctx.close();
  pages.pop();

  // ---- a room with a host page ----
  const host = await openPage('host', 'host/');
  pages.push(host);
  await pickTeacher(host.page, KEY);
  await host.page.click('#openBtn');
  await until(async () => (await host.page.locator('#bigCode').textContent())?.trim(), { timeout: 15_000 });
  const room = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const wsBase = BASE.replace(/^http/, 'ws');
  hostWs = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}api/rooms/${room.room}/ws?${new URLSearchParams({ role: 'host', token: room.token })}`);
    ws.msgs = [];
    ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
  });
  hostWs.send(JSON.stringify({ t: 'settings', settings: { aiCheck: false, maxWaitingPerStudent: 5, backToWork: false } }));
  await until(() => hostWs.msgs.find((m) => m.t === 'state' && !m.state.settings.aiCheck));
  check('a test host socket that never said it answers lookups gets none', true);

  // ---- 1. search through the host page ----
  const ann = await join('Ann', room.classCode);
  pages.push(ann);
  const ids = await studentSearch(ann, `relay ${RUN} first`);
  check('search: the host page made the iTunes call', calls.some(([k, t, who]) => k === 'search' && t === `relay ${RUN} first`.toLowerCase() && who === 'host'), JSON.stringify(calls));
  check('search: no student page called iTunes in a room', !calls.some(([, , who]) => who === 'Ann'));
  check('search: the server\'s songs: bad shapes from the host left out, explicit → clean',
    JSON.stringify(ids) === JSON.stringify([`it:${SONGS.one.trackId}`, `it:${SONGS.two.trackId}`, `it:${SONGS.clean.trackId}`]), JSON.stringify(ids));
  check('host: no lookup traffic visible to students', !ann.msgs.some((m) => m.t === 'lookup'));
  check('host page got the job', host.msgs.some((m) => m.t === 'lookup' && /^https:\/\/itunes\.apple\.com\/search\?/.test(m.url)));

  // ---- 2. coalescing ----
  const bo = await join('Bo', room.classCode);
  pages.push(bo);
  const before = calls.filter(([k]) => k === 'search').length;
  const [x, y] = await Promise.all([studentSearch(ann, `same ${RUN}`), studentSearch(bo, `same ${RUN}`)]);
  check('coalescing: two students, the same new words at once → one iTunes call', calls.filter(([k]) => k === 'search').length === before + 1
    && x.length === 1 && y.length === 1, JSON.stringify(calls.slice(before)));

  // ---- 3. suggest ----
  const n0 = calls.length;
  const nA = ann.msgs.length;
  await ann.page.click(`#results li[data-id="it:${SONGS.one.trackId}"] button[data-act="suggest"]`);
  const ok = await until(() => ann.msgs.slice(nA).find((m) => m.t === 'suggested'), { timeout: 15_000 });
  check('suggest: from the room\'s own results, no iTunes call', ok?.ok === true && calls.length === n0, JSON.stringify(ok));
  const device = 'relay-test-device-0001';
  await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code: room.classCode }) });
  const kid = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}api/rooms/${room.room}/ws?${new URLSearchParams({ role: 'student', device, nick: 'Cy' })}`);
    ws.msgs = [];
    ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
  });
  kid.send(JSON.stringify({ t: 'suggest', song: `it:${SONGS.lookupOnly.trackId}` }));
  const looked = await until(() => kid.msgs.find((m) => m.t === 'suggested'), { timeout: 15_000 });
  check('suggest: an id the room never showed is looked up by the host page', looked?.ok === true
    && calls.some(([k, id, who]) => k === 'lookup' && id === String(SONGS.lookupOnly.trackId) && who === 'host'), JSON.stringify(looked));
  const queued = lastState(host)?.queue.find((q) => q.song.id === `it:${SONGS.lookupOnly.trackId}`);
  check('suggest: queued with iTunes\'s details and preview, mapped by the server', queued?.song.title === SONGS.lookupOnly.trackName
    && queued.song.previewUrl === SONGS.lookupOnly.previewUrl, JSON.stringify(queued?.song));
  kid.send(JSON.stringify({ t: 'suggest', song: `it:${base + 5}` }));
  const bad = await until(() => kid.msgs.filter((m) => m.t === 'suggested')[1], { timeout: 15_000 });
  check('suggest: a song the host\'s data does not hold up for is not found', bad?.ok === false && bad.reason === 'unavailable', JSON.stringify(bad));

  // ---- 4. a host that does not answer; no host ----
  stall = true;
  const t0 = Date.now();
  await studentSearch(ann, `stall ${RUN}`);
  const waited = Date.now() - t0;
  // The host page gives up on iTunes after 5 s (the room would after 6 s): the same message.
  check('no answer: "your teacher\'s computer is not answering" after about 5 s', /teacher's computer is not answering searches/.test(await text(ann, '#searchMsg'))
    && waited >= 4500 && waited < 12_000, `${await text(ann, '#searchMsg')} (${waited} ms)`);
  stall = false;
  for (const p of [host, ann, bo]) {
    check(`no page errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
    check(`no CSP errors on ${p.name}`, p.csp.length === 0, p.csp.join(' | '));
  }
  await host.ctx.close();
  pages.splice(pages.indexOf(host), 1);
  await new Promise((r) => setTimeout(r, 500));
  check('no host page: cached words still answer', (await studentSearch(ann, `relay ${RUN} first`)).length === 3);
  const t1 = Date.now();
  await studentSearch(ann, `nohost ${RUN}`);
  check('no host page: the same message, at once', /teacher's computer is not answering searches/.test(await text(ann, '#searchMsg')) && Date.now() - t1 < 4000,
    `${await text(ann, '#searchMsg')} (${Date.now() - t1} ms)`);
  kid.close();
} catch (e) {
  failures++;
  console.log(`FAIL crashed: ${e?.stack || e}`);
  for (const p of pages) await p.page.screenshot({ path: `${OUT}relay-${p.name}.png` }).catch(() => {});
} finally {
  try { hostWs?.send(JSON.stringify({ t: 'close' })); } catch { /* gone */ }
  await new Promise((r) => setTimeout(r, 300));
  hostWs?.close();
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
