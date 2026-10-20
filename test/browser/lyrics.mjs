// Browser test of songs the AI does not know, judged from their lyrics (src/lyrics.js; CLAUDE.md
// invariant 17), with NO real LRCLIB: this script runs a FAKE LRCLIB on 127.0.0.1, and a LOCAL
// wrangler dev is started with LYRICS_TEST_BASE pointing at it:
//   npm run build
//   npx wrangler dev --ip 127.0.0.1 --port 8795 --local-upstream 127.0.0.1:8795 \
//     --var LYRICS_TEST_BASE:http://127.0.0.1:8796
//   npm run test:lyrics            (or: node test/browser/lyrics.mjs http://127.0.0.1:8795/; FAKE_LRCLIB_PORT moves the fake)
// The Worker takes LYRICS_TEST_BASE only as a loopback http address, so this cannot be done to the
// deployed site. Made-up songs are seeded in the LOCAL KV song cache with a cached UNKNOWN verdict
// (as if the AI did not know them), so the theme call is skipped; the two lyrics verdicts are REAL
// Workers AI calls (2 a run, about 100 neurons), the rest need no AI. Deleted at the end.
// Checks:
//   1. A clean song: judged from its lyrics, joins the queue (no Needs a look); LRCLIB got our
//      User-Agent and the title + main artist; the cached verdict says source 'lyrics' and holds
//      no lyrics.
//   2. A drinking song: refused with 🍺 and kid-safe evidence that quotes no lyrics; Blocked today
//      says "judged from lyrics".
//   3. LRCLIB lists it as instrumental: it joins with no AI call.
//   4. LRCLIB down (500) and LRCLIB too slow (past 4 s): the song waits in Needs a look as before,
//      with no lyrics note, and nothing is marked in KV (looked up again next time).
//   5. No lyric line reaches the student or the host page.
// Reads TEACHER_KEY from .dev.vars and never prints it. Screenshots of failures go to test/browser/.out/.

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { banKey, normalizeWords, verdictKey } from '../../shared/filter.js';
import { T1, pickTeacher } from './teacher-pick.mjs';
import { reveal } from './ui.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8795/';
const FAKE_PORT = Number(process.env.FAKE_LRCLIB_PORT || 8796);
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

// ---- The fake LRCLIB -------------------------------------------------------------------------------

const ARTIST = 'Lyrics Test Band';
const SONGS = {
  sunny: {
    title: 'Lyrics Test Sunny Song',
    lyrics: 'Sunshine on the playground, we are running free\nFriends around the table, laughing you and me\nSing it loud together, sing it all day long\nEverybody knows the words to our happy song',
  },
  party: {
    title: 'Lyrics Test Party Song',
    lyrics: 'Pour another round of whiskey, we are drinking till we drop\nTake another shot of tequila, never gonna stop\nGetting drunk on Friday, wasted every night\nBottles on the table, drink until the morning light',
  },
  quiet: { title: 'Lyrics Test Quiet Song', instrumental: true },
  down: { title: 'Lyrics Test Down Song', status: 500 },
  slow: { title: 'Lyrics Test Slow Song', delay: 5500 },
};
const lyricLines = Object.values(SONGS).flatMap((s) => (s.lyrics ?? '').split('\n')).filter(Boolean);
const requests = [];
const fake = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${FAKE_PORT}`);
  requests.push({ path: url.pathname, track: url.searchParams.get('track_name'), artist: url.searchParams.get('artist_name'), ua: req.headers['user-agent'] });
  const s = Object.values(SONGS).find((x) => x.title === url.searchParams.get('track_name'));
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname !== '/api/search' || !s) return send(200, []);
  if (s.status) return send(s.status, { name: 'UnknownError', statusCode: s.status });
  const record = {
    id: 1, name: s.title, trackName: s.title, artistName: ARTIST, albumName: 'Test', duration: 200.4,
    instrumental: Boolean(s.instrumental), plainLyrics: s.instrumental ? null : s.lyrics, syncedLyrics: null,
  };
  if (s.delay) return void setTimeout(() => send(200, [record]), s.delay);
  return send(200, [record, { ...record, id: 2, duration: 250 }]);
});
await new Promise((resolve) => fake.listen(FAKE_PORT, '127.0.0.1', resolve));

// ---- Local KV (wrangler kv --local; never --remote) -------------------------------------------

const WRANGLER = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));
function localKv(...args) {
  const persist = process.env.CQ_PERSIST ? ['--persist-to', process.env.CQ_PERSIST] : [];
  const r = spawnSync(process.execPath, [WRANGLER, 'kv', ...args, '--binding', 'CLASS_KV', '--local', ...persist],
    { cwd: fileURLToPath(ROOT), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler kv ${args[0]} ${args[1]} --local failed: ${r.stderr.slice(-300)}`);
  return r.stdout;
}
function localKvBulk(action, entries) {
  const file = `${OUT}lyrics-kv-${action}.json`;
  writeFileSync(file, JSON.stringify(entries));
  localKv('bulk', action, file, ...(action === 'delete' ? ['--force'] : []));
}
const localKvGet = (key) => {
  const out = localKv('key', 'get', key, '--text').trim();
  return out.startsWith('Value not found') ? null : out;
};

const seeded = [];
/** A made-up song in the LOCAL KV song cache, with a cached UNKNOWN verdict (the AI did not know it). */
function seedSong(kind) {
  const trackId = 970_000_000 + Math.floor(Math.random() * 9_000_000);
  const song = {
    id: `it:${trackId}`, title: SONGS[kind].title, artist: `${ARTIST} feat. Someone`, album: 'Test', artwork: '',
    durationMs: 200_000, explicit: 'notExplicit', previewUrl: 'https://audio-ssl.itunes.apple.com/test.m4a', genre: 'Pop',
  };
  const unknown = JSON.stringify({ verdict: 'unknown', category: 'other', evidence: '', instrumental: 'unknown' });
  const keys = [verdictKey(song.id), verdictKey(banKey(song))];
  localKvBulk('put', [{ key: `song:${trackId}`, value: JSON.stringify(song) }, ...keys.map((key) => ({ key, value: unknown }))]);
  seeded.push(`song:${trackId}`, ...keys);
  SONGS[kind].id = song.id;
  SONGS[kind].song = song;
  return song.id;
}

const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

async function apiJoin(code, device) {
  const r = await fetch(new URL('api/join', BASE), {
    method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  return r.status;
}

async function rawStudent(roomId, device, nick) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}api/rooms/${roomId}/ws?${new URLSearchParams({ role: 'student', device, nick })}`);
  const s = { ws, msgs: [], raw: [] };
  ws.addEventListener('message', (e) => {
    s.raw.push(String(e.data));
    try { s.msgs.push(JSON.parse(e.data)); } catch { /* not JSON */ }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  s.ask = async (msg, pred, timeout = 40_000) => {
    const n = s.msgs.length;
    ws.send(JSON.stringify(msg));
    return until(() => s.msgs.slice(n).find(pred), { timeout });
  };
  return s;
}

/** True when `text` repeats 4+ words in a row of any fake lyric. */
function quotes(text) {
  const words = normalizeWords(text).split(' ').filter(Boolean);
  const hay = lyricLines.map((l) => ` ${normalizeWords(l)} `).join('|');
  for (let i = 0; i + 4 <= words.length; i++) if (hay.includes(` ${words.slice(i, i + 4).join(' ')} `)) return true;
  return false;
}
const hasLyricLine = (text) => lyricLines.some((l) => String(text).includes(l));

// ---- The flow ----------------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const savedDefaults = await (await api('/api/teacher/settings')).json();
let host = null;
let raw = null;
const hostMsgs = [];
const errors = [];
try {
  // Songs replay across runs: no repeat cooldown; the AI check on and unknown songs held.
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({
    cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false, aiCheck: true, blockUnknownSongs: true, instrumentalsOnly: false, maxSongMinutes: null, startingCredits: null,
    maxWaitingPerStudent: 10, oneSongPerArtist: false,
  }) });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  host = await ctx.newPage();
  host.on('pageerror', (e) => errors.push(String(e)));
  host.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  host.on('websocket', (ws) => ws.on('framereceived', (f) => hostMsgs.push(String(f.payload))));
  await host.goto(new URL('host/', BASE).href);
  await host.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host, KEY);
  await host.click('#openBtn');
  await host.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { classCode: code, room: roomId } = await host.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const lastState = () => {
    for (let i = hostMsgs.length - 1; i >= 0; i--) {
      try {
        const m = JSON.parse(hostMsgs[i]);
        if (m.t === 'state') return m.state;
      } catch { /* not JSON */ }
    }
    return null;
  };
  const lastBlocked = () => {
    for (let i = hostMsgs.length - 1; i >= 0; i--) {
      try {
        const m = JSON.parse(hostMsgs[i]);
        if (m.t === 'blocked') return m.list;
      } catch { /* not JSON */ }
    }
    return null;
  };
  check('room: the AI check is on, unknown songs held', Boolean(await until(() => lastState()?.settings?.aiCheck && lastState().settings.blockUnknownSongs)));

  for (const kind of Object.keys(SONGS)) seedSong(kind);
  const device = `lyrics-test-device-${Math.random().toString(36).slice(2, 10)}`;
  check('student: joins', (await apiJoin(code, device)) === 200);
  raw = await rawStudent(roomId, device, 'Lia');
  const suggest = (kind) => raw.ask({ t: 'suggest', song: SONGS[kind].id }, (m) => m.t === 'suggested' && m.song === SONGS[kind].id);

  // 1. A clean song nobody knew: judged from its lyrics, straight into the queue.
  const sunny = await suggest('sunny');
  check('clean song: judged from lyrics, it joins the queue (no Needs a look)', sunny?.ok === true, JSON.stringify(sunny));
  const req = requests.find((r) => r.track === SONGS.sunny.title);
  check('LRCLIB: GET /api/search with the title and the MAIN artist', req?.path === '/api/search' && req.artist === ARTIST, JSON.stringify(req));
  check('LRCLIB: our User-Agent', req?.ua === 'RoomDJ (https://roomdj.com)', req?.ua);
  check('clean song: not in Needs a look', !(lastState()?.review ?? []).some((x) => x.song.id === SONGS.sunny.id));
  const vSunny = JSON.parse(localKvGet(verdictKey(SONGS.sunny.id)) ?? '{}');
  check('KV: the verdict is cached with source lyrics, under this prompt', vSunny.verdict === 'ok' && vSunny.source === 'lyrics' && vSunny.lyrics === 'found'
    && localKvGet(verdictKey(banKey(SONGS.sunny.song))) !== null, JSON.stringify(vSunny));
  check('KV: no lyrics stored', !hasLyricLine(JSON.stringify(vSunny)) && !quotes(vSunny.evidence ?? ''));

  // 2. A drinking song: refused, with kid-safe evidence that quotes nothing.
  const party = await suggest('party');
  check('drinking song: refused as 🍺 Alcohol or partying', party?.reason === 'theme' && party.why?.id === 'alcohol', JSON.stringify(party));
  check('drinking song: the evidence quotes no lyrics', party?.why?.evidence && !quotes(party.why.evidence), party?.why?.evidence);
  const bl = await until(() => (lastBlocked() ?? []).find((b) => b.song.id === SONGS.party.id));
  check('Blocked today: "judged from lyrics" for the teacher', /judged from lyrics/.test(bl?.detail ?? ''), bl?.detail);
  await host.click(await reveal(host, '#blockedBtn'));
  await host.waitForSelector('#blockedDlg[open]');
  check('Blocked today dialog: shows "judged from lyrics"', Boolean(await until(async () => /judged from lyrics/.test(await host.locator('#blockedList').textContent()))));
  await host.click('#blockedDlg button[value="done"]');
  const vParty = JSON.parse(localKvGet(verdictKey(SONGS.party.id)) ?? '{}');
  check('KV: the refusal is cached with source lyrics, no lyrics', vParty.verdict === 'inappropriate' && vParty.source === 'lyrics' && !hasLyricLine(JSON.stringify(vParty)), JSON.stringify(vParty));

  // 3. LRCLIB lists it as instrumental: no words to judge.
  const quiet = await suggest('quiet');
  check('instrumental on LRCLIB: it joins', quiet?.ok === true, JSON.stringify(quiet));

  // 4. LRCLIB down, LRCLIB too slow: Needs a look as before; nothing marked.
  const down = await suggest('down');
  check('LRCLIB down (500): the song waits in Needs a look', down?.reason === 'review' && down.why?.id === 'unknown', JSON.stringify(down));
  const t0 = Date.now();
  const slow = await suggest('slow');
  check('LRCLIB too slow: Needs a look after about 4 s', slow?.reason === 'review' && Date.now() - t0 < 12_000, `${JSON.stringify(slow)} in ${Date.now() - t0} ms`);
  const rev = await until(() => {
    const r = lastState()?.review ?? [];
    return r.some((x) => x.song.id === SONGS.down.id) && r.some((x) => x.song.id === SONGS.slow.id) && r;
  });
  check('Needs a look: both there, with no lyrics note', Boolean(rev) && rev.every((x) => !x.checked), JSON.stringify(rev?.map((x) => [x.song.title, x.checked])));
  check('Needs a look page: no "Judged from lyrics" line', (await host.locator('#review').textContent()).includes(SONGS.down.title)
    && !/Judged from lyrics/.test(await host.locator('#review').textContent()));
  const vDown = JSON.parse(localKvGet(verdictKey(SONGS.down.id)) ?? '{}');
  check('KV: LRCLIB trouble marks nothing (looked up again next time)', vDown.verdict === 'unknown' && vDown.lyrics === undefined, JSON.stringify(vDown));

  // 5. No lyric line anywhere a page can see.
  check('student: never got a lyric', !raw.raw.some(hasLyricLine));
  check('host: never got a lyric', !hostMsgs.some(hasLyricLine) && !hasLyricLine(await host.content()));
  check('LRCLIB: asked once per song', ['sunny', 'party', 'quiet', 'down', 'slow'].every((k) => requests.filter((r) => r.track === SONGS[k].title).length === 1),
    JSON.stringify(requests.map((r) => r.track)));
  check('no console errors on the host page', errors.length === 0, errors.join(' | '));

  await host.click(await reveal(host, '#closeBtn'));
  await host.click('#confirm button[value="ok"]');
  await until(() => host.locator('#closedScreen').isVisible());
} catch (e) {
  failures++;
  console.log(`FAIL lyrics stopped: ${e?.stack ?? e}`);
  await host?.screenshot({ path: `${OUT}lyrics-crash.png` }).catch(() => {});
} finally {
  raw?.ws.close();
  const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) });
  if (!r.ok) console.log('FAIL could not put the saved teacher settings back');
  try {
    if (seeded.length) localKvBulk('delete', seeded);
  } catch (e) {
    console.log(`FAIL could not clean the seeded local KV keys: ${e.message}`);
  }
  await browser.close();
  fake.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
