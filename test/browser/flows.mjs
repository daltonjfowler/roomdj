// Browser test of the room flows: one host page and two student pages in installed Chrome
// (playwright-core), against a LOCAL wrangler dev only (it changes the saved teacher settings and
// the ban list, then puts the settings back).
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:browser              (or: node test/browser/flows.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// playwright-core: this repo's node_modules if present, else PLAYWRIGHT_CORE (a path to its
// index.mjs), else the copy in ../uploadmycut/node_modules.
// The room's AI check is turned off (no Workers AI calls); scripts/ai-test.mjs tests the AI.
// The "Needs a look" flow turns it on, but first seeds an UNKNOWN verdict for its songs into the
// LOCAL KV (wrangler kv --local, the same .wrangler/state that wrangler dev uses), so the AI is
// never asked: the cached verdict is read first. Nothing in the Worker knows about this, so it
// cannot be triggered on the deployed site. (A dev server started with --persist-to <dir>: set
// CQ_PERSIST=<dir> so the seeding reaches it.) Nicknames that join while the AI check is on get
// seeded verdicts the same way (nick:v1:<key>): OK for the class, INAPPROPRIATE for "Mike Hawk".
// The teacher's Rename sends a student back to pick a new nickname (after a code change, so the
// way back in needs no code).
// Class codes: browsing before joining, a wrong code, the per-device lockout (another device on
// the same address still joins), changing the code mid-day, and a room closing itself at `until`.
// Searches hit the real iTunes API. Screenshots of failures go to test/browser/.out/.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_LYRICS, approvedKey, banKey, verdictKey } from '../../shared/filter.js';
import { nickVerdictKey } from '../../shared/nick.js';
import { T1, pickTeacher } from './teacher-pick.mjs';
import { reveal } from './ui.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = fileURLToPath(new URL('./.out/', import.meta.url));
const ROOT = new URL('../../', import.meta.url);
mkdirSync(OUT, { recursive: true });

if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: these flows change the saved teacher settings, so they run only against a local dev server (not ${BASE})`);
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
  const file = `${OUT}kv-${action}.json`;
  writeFileSync(file, JSON.stringify(entries));
  localKv('bulk', action, file, ...(action === 'delete' ? ['--force'] : []));
}
const localKvGet = (key) => {
  const out = localKv('key', 'get', key, '--text').trim();
  return out.startsWith('Value not found') ? null : out;
};

const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

// ---- Pages -------------------------------------------------------------------------------------

// Autoplay as on a real classroom computer: no sound until someone clicks the page.
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=document-user-activation-required'],
});

/** A page in its own context (own localStorage = own device id), with its socket messages and errors. */
async function openPage(name, path, { droppable = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const p = { name, ctx, page, msgs: [], errors: [], offline: false, routes: [], itunes: 0 };
  const record = (payload) => {
    try {
      p.msgs.push(JSON.parse(payload));
    } catch {
      // not JSON
    }
  };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  p.itunes = 0;
  page.on('request', (r) => { if (r.url().startsWith('https://itunes.apple.com/')) p.itunes++; });
  page.on('console', (m) => {
    // While the network is cut on purpose, failed socket and fetch attempts are expected. So is
    // Chrome's "Failed to load resource" line for a refused join (wrong code, kicked).
    const refusedJoin = /\/api\/join$/.test(m.location()?.url ?? '');
    if (m.type() === 'error' && !p.offline && !refusedJoin) p.errors.push(m.text());
  });
  if (droppable) {
    // Chrome's offline mode leaves an open WebSocket alone, so this page's sockets go through
    // Playwright, which can cut them (dropNetwork) and refuse new ones while offline.
    await ctx.routeWebSocket(/\/api\/rooms\/.*\/ws/, (ws) => {
      if (p.offline) return ws.close({ code: 1011, reason: 'offline' });
      const server = ws.connectToServer();
      server.onMessage((m) => {
        record(m);
        ws.send(m);
      });
      p.routes.push(ws, server);
    });
  } else {
    page.on('websocket', (ws) => ws.on('framereceived', (f) => record(f.payload)));
  }
  await page.goto(new URL(path, BASE).href);
  return p;
}

/** Like the Wi-Fi dropping: offline, and the open socket is cut. */
async function dropNetwork(p) {
  p.offline = true;
  await p.ctx.setOffline(true);
  for (const r of p.routes.splice(0)) await r.close({ code: 1011, reason: 'network lost' }).catch(() => {});
}

const lastState = (p) => [...p.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const visible = (p, sel) => p.page.locator(sel).isVisible();
const text = (p, sel) => p.page.locator(sel).textContent();

async function shot(p, label) {
  await p.page.screenshot({ path: `${OUT}flows-${label}-${p.name}.png` }).catch(() => {});
}

async function joinStudent(p, code, nick) {
  await p.page.fill('#code', code);
  await p.page.fill('#nick', nick);
  await p.page.click('#joinBtn');
}

/** Search on a student page; resolves the result song ids shown. */
async function search(p, q) {
  const before = await text(p, '#searchMsg');
  await p.page.fill('#q', q);
  await p.page.press('#q', 'Enter');
  await until(async () => {
    const t = await text(p, '#searchMsg');
    return t !== 'Searching…' && (t !== before || /found/.test(t)) && /found|not|Wait/.test(t);
  }, { timeout: 15_000 });
  return p.page.$$eval('#results li[data-id]', (els) => els.map((e) => e.dataset.id));
}

/** Click Suggest on one result and wait for the server's 'suggested' answer. */
async function suggest(p, trackId, { force = false } = {}) {
  const n = p.msgs.length;
  const btn = `#results li[data-id="${trackId}"] button[data-act="suggest"]`;
  if (force) {
    // Like a click that lands just before the next snapshot disables the button.
    await p.page.evaluate((sel) => {
      const b = document.querySelector(sel);
      b.disabled = false;
      b.click();
    }, btn);
  } else {
    await p.page.click(btn);
  }
  return until(() => p.msgs.slice(n).find((m) => m.t === 'suggested' && m.song === trackId), { timeout: 30_000 });
}

/** POST /api/join as some device; [status, body]. */
async function apiJoin(code, device) {
  const r = await fetch(new URL('api/join', BASE), {
    method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  return [r.status, await r.json().catch(() => ({}))];
}

/** Songs firstNew found, by id (for their banKey). */
const found = new Map();

/** The first result of a room search (through the API, as an admitted device) not already used. */
async function firstNew(roomId, q, used) {
  const r = await fetch(new URL(`api/rooms/${roomId}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': 'flows-test-device-0002' } });
  const song = (await r.json()).results?.find((s) => !used.has(s.id));
  if (!song) throw new Error(`no new search result for ${q}`);
  used.add(song.id);
  found.set(song.id, song);
  return song.id;
}

/** Search on a page until `trackId` shows, then suggest it. */
async function suggestFound(p, q, trackId) {
  const ids = await search(p, q);
  if (!ids.includes(trackId)) throw new Error(`${trackId} not in the page's results for ${q}`);
  return suggest(p, trackId);
}

async function searchAndSuggest(p, q, used) {
  const ids = await search(p, q);
  const trackId = ids.find((id) => !used.has(id));
  if (!trackId) return { trackId: null, ok: false, msg: null };
  used.add(trackId);
  const msg = await suggest(p, trackId);
  return { trackId, ok: Boolean(msg?.ok), msg };
}

async function hostState(host, pred, timeout = 10_000) {
  return until(() => {
    const s = lastState(host);
    return s && pred(s) ? s : null;
  }, { timeout });
}

async function confirmOk(p) {
  await p.page.waitForSelector('#confirm[open]');
  await p.page.click('#confirm button[value="ok"]');
}

async function hostSettings(host, { max, remove, ai, unknown, words }, button = '#applySettings') {
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  if (max !== undefined) await host.page.fill(await reveal(host.page, '#setMax'), String(max));
  if (remove !== undefined) await host.page.fill(await reveal(host.page, '#setRemove'), String(remove));
  if (ai !== undefined) await host.page.setChecked(await reveal(host.page, '#setAi'), ai);
  if (unknown !== undefined) await host.page.setChecked(await reveal(host.page, '#setUnknown'), unknown);
  if (words !== undefined) await host.page.fill(await reveal(host.page, '#setWords'), words.join('\n'));
  await host.page.click(button);
}

/** Open a room on a host page with its suggested code; resolves { code, id } (code as normalized). */
async function openRoom(host) {
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  return hostRoom(host);
}

/** What the host page remembers about its room (cq.host): { code, id, until }. */
async function hostRoom(host) {
  const saved = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  return { code: saved.classCode, id: saved.room, until: saved.until };
}

const queueIds = (s) => s.queue.map((q) => q.id);

// ---- The flows ---------------------------------------------------------------------------------

const savedDefaults = await (await api('/api/teacher/settings')).json();
// Songs replay across runs and rooms: no repeat cooldown while this test runs (the saved
// defaults, cooldown included, go back at the end).
const testDefaults = { ...savedDefaults, cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false };
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false }) });
const pages = [];
// Nicknames that join while the room's AI check is on: seeded verdicts, so the AI is never asked.
const NICK_VERDICTS = [
  ...['Dee', 'Cy', 'Eli', 'Ava Rose'].map((n) => [n, 'ok']),
  ['Mike Hawk', 'inappropriate'],
];
localKvBulk('put', NICK_VERDICTS.map(([n, verdict]) => ({ key: nickVerdictKey(n), value: JSON.stringify({ verdict, reason: 'flows test' }) })));
let reviewTracks = []; // song ids seeded in local KV; cleaned up at the end
// A teacher's Allow is also kept per song (approved:<banKey>, any version, either catalog).
const approvals = (ids) => ids.flatMap((t) => [approvedKey(t), ...(found.has(t) ? [approvedKey(banKey(found.get(t)))] : [])]);
try {
  // Browse before joining: no room, the saved default blocklist applies, no join needed.
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ ...testDefaults, blocklist: ['pharrell'] }) });
  const browser1 = await openPage('browse', '');
  pages.push(browser1);
  check('browse: the page starts on the join screen with the class code note', (await visible(browser1, '#joinScreen'))
    && (await text(browser1, '#joinScreen')).includes('Ask your teacher for today\'s class code to suggest and vote.') && !(await visible(browser1, '#roomScreen')));
  await browser1.page.fill('#bq', 'Uptown Funk Bruno Mars');
  await browser1.page.press('#bq', 'Enter');
  const browsed = await until(async () => /songs? found/.test(await text(browser1, '#browseMsg')), { timeout: 15_000 });
  const browseCount = await browser1.page.locator('#browseResults li').count();
  check('browse: songs show with no room, marked allowed, with no Suggest button', Boolean(browsed) && browseCount > 0
    && (await browser1.page.locator('#browseResults button').count()) === 0, await text(browser1, '#browseMsg'));
  check('browse: the page searched iTunes itself (no server search)', browser1.itunes > 0, String(browser1.itunes));
  const browseCheck = (songs, device = 'flows-test-device-0003') => fetch(new URL('api/browse', BASE), {
    method: 'POST', headers: { ...(device ? { 'x-device': device } : {}), 'content-type': 'application/json' }, body: JSON.stringify({ songs }),
  });
  const sample = [
    { id: 'it:863835363', title: 'Happy', artist: 'Pharrell Williams', album: 'G I R L', explicit: 'notExplicit' },
    { id: 'it:1', title: 'Lovely Day', artist: 'Bill Withers', album: 'Menagerie', explicit: 'notExplicit' },
    { id: 'it:2', title: 'Rude Song', artist: 'Band', album: 'LP', explicit: 'explicit' },
    { id: 'nonsense', title: 'X', artist: 'Y', album: '', explicit: 'notExplicit' },
  ];
  const blocked = await (await browseCheck(sample)).json();
  check('browse: the server applies the saved default blocklist and the explicit flag (the words stay on the server)',
    JSON.stringify(blocked.allowed) === JSON.stringify([false, true, false, false]) && !JSON.stringify(blocked).includes('pharrell'), JSON.stringify(blocked));
  const noDevice = (await browseCheck(sample, null)).status;
  check('browse: a check without a device id is refused', noDevice === 400, String(noDevice));
  const tooMany = (await browseCheck(Array.from({ length: 31 }, () => sample[1]))).status;
  check('browse: at most 30 songs a check', tooMany === 400, String(tooMany));
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(testDefaults) });
  await browser1.ctx.close();
  pages.pop();

  // Room + room settings (AI off so no Workers AI calls; more songs per student; a blocked word).
  const host = await openPage('host', 'host/');
  pages.push(host);
  await pickTeacher(host.page, KEY);
  const suggestedOnPage = await host.page.inputValue('#openCode');
  check('host start screen suggests a code (three words and a number)', /^[a-z]+ [a-z]+ [a-z]+ [1-9][0-9]$/.test(suggestedOnPage), suggestedOnPage);
  // A code with no letters or numbers is refused before anything opens (any other code is fine).
  await host.page.fill('#openCode', '!!');
  await host.page.click('#openBtn');
  check('host: an empty own code is refused with a reason', Boolean(await until(async () => /Type a class code/.test(await text(host, '#keyMsg')))));
  await host.page.click('#newCode');
  const { code, id: roomId, until: roomUntil } = await openRoom(host);
  check('host opens a room with the suggested code', /^[a-z]+-[a-z]+-[a-z]+-[1-9][0-9]$/.test(code ?? ''), code);
  check('host: the board shows the code as words', (await host.page.getAttribute('#bigCode', 'aria-label')) === code.replace(/-/g, ' '));
  check('host: open until the end of today by default', new Date(roomUntil).getHours() === 23 || roomUntil - Date.now() >= 50 * 60_000, new Date(roomUntil).toString());
  await hostSettings(host, { max: 5, ai: false, words: ['pineapple'] });
  check('room settings change from the dialog', Boolean(await hostState(host, (s) => s.settings.maxWaitingPerStudent === 5 && !s.settings.aiCheck && s.settings.blocklist.includes('pineapple'))));

  // Refused nicknames: a teacher-blocked word, and a rude one dressed up.
  const extra = await openPage('nick', `?code=${code}`);
  pages.push(extra);
  check('join link prefills the class code', (await extra.page.inputValue('#code')) === code.replace(/-/g, ' '));
  for (const [label, nick] of [['blocklisted word', 'Pineapple Pete'], ['rude word', 'xXsh1tXx']]) {
    await joinStudent(extra, code, nick);
    const msg = await until(async () => (await visible(extra, '#joinScreen')) && (await text(extra, '#joinMsg')));
    check(`nickname with a ${label} is refused with a friendly message`, msg === 'Please pick a different nickname.' && !(await visible(extra, '#roomScreen')), msg ?? 'no message');
    check(`join button usable again after a refused nickname (${label})`, !(await extra.page.locator('#joinBtn').isDisabled()));
  }

  // Wrong code, then the lockout: 5 wrong in a row lock this device (5 s), even for the right code.
  const WRONG = 'That class code is not right. Check the board and type it again.';
  const joinMsgAfter = async (codeTyped) => {
    await extra.page.evaluate(() => { document.querySelector('#joinMsg').textContent = ''; });
    await joinStudent(extra, codeTyped, 'Eve');
    return until(async () => (await text(extra, '#joinMsg')) || null);
  };
  const wrong1 = await joinMsgAfter('purple walrus lantern 77');
  check('wrong code: friendly message', wrong1 === WRONG, wrong1);
  for (let i = 0; i < 4; i++) await joinMsgAfter('purple walrus lantern 77');
  const lockedMsg = await joinMsgAfter(code);
  check('lockout: after 5 wrong tries even the right code waits', /Too many wrong tries\. Wait \d+ seconds/.test(lockedMsg ?? ''), lockedMsg);
  await extra.ctx.close();
  pages.pop();

  // Two students join.
  const ava = await openPage('ava', `?code=${code}`, { droppable: true });
  const ben = await openPage('ben', `?code=${code}`);
  pages.push(ava, ben);
  await joinStudent(ava, code, 'Ava');
  await joinStudent(ben, code, 'Ben');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');
  await ben.page.waitForSelector('#roomScreen:not([hidden])');
  check('two students join (same address as the locked-out device: the class is never locked)', Boolean(await hostState(host, (s) => s.students.filter((x) => x.online).length === 2)));
  check('a joined student\'s socket URL has the room id, never the class code', !(await ava.page.evaluate(() => sessionStorage.getItem('cq.join'))).includes(code));

  // Suggestions.
  const used = new Set();
  const a1 = await searchAndSuggest(ava, 'Here Comes the Sun Beatles', used);
  const a2 = await searchAndSuggest(ava, 'Happy Pharrell Williams', used);
  const a3 = await searchAndSuggest(ava, 'Shake It Off Taylor Swift', used);
  const b1 = await searchAndSuggest(ben, 'Uptown Funk Bruno Mars', used);
  const b2 = await searchAndSuggest(ben, 'Dancing Queen ABBA', used);
  check('five suggestions join the queue', [a1, a2, a3, b1, b2].every((x) => x.ok), JSON.stringify([a1, a2, a3, b1, b2].map((x) => x.msg?.reason ?? x.ok)));
  const s0 = await hostState(host, (s) => s.queue.length === 5);
  const itemOf = (s, trackId) => s.queue.find((q) => q.song.id === trackId) ?? (s.nowPlaying?.song.id === trackId ? s.nowPlaying : null);

  // Veto: the song leaves the queue and its student is told.
  const vetoId = itemOf(s0, a2.trackId).id;
  await host.page.click(await reveal(host.page, `#queue li[data-id="${vetoId}"] button[data-act="veto"]`));
  check('veto removes the song', Boolean(await hostState(host, (s) => s.queue.length === 4 && !queueIds(s).includes(vetoId))));
  check('student is told her vetoed song was taken out, and why (one tap: teacher choice)', Boolean(await until(async () => /took ".*" out of the queue\. 🍎 Teacher's choice\./.test(await text(ava, '#toasts')))), await text(ava, '#toasts'));

  // Ban a queued song. Ben has it in his search results; once it leaves the queue he tries it.
  const banTrack = a1.trackId;
  const benSees = await search(ben, 'Here Comes the Sun Beatles');
  check('other student sees the queued song as "In the queue"', benSees.includes(banTrack)
    && (await ben.page.locator(`#results li[data-id="${banTrack}"] button`).isDisabled()));
  const banId = itemOf(lastState(host), banTrack).id;
  await host.page.click(await reveal(host.page, `#queue li[data-id="${banId}"] button[data-act="ban"]`));
  await confirmOk(host);
  check('ban removes the queued song', Boolean(await hostState(host, (s) => !queueIds(s).includes(banId))));
  await until(async () => !(await ben.page.locator(`#results li[data-id="${banTrack}"] button`).isDisabled()));
  const reBan = await suggest(ben, banTrack);
  check('banned song is refused on re-suggest with the banned reason', reBan?.ok === false && reBan.reason === 'banned', JSON.stringify(reBan));
  check('student sees the banned message', Boolean(await until(async () => (await text(ben, '#toasts')).includes('That song is not allowed. ⛔ Banned by your teacher.'))));
  check('banned song is gone from new searches', !(await search(ben, 'Here Comes the Sun Beatles')).includes(banTrack));

  // Lock suggestions.
  const lovely = await search(ava, 'Lovely Day Bill Withers');
  const lovelyId = lovely.find((id) => !used.has(id));
  used.add(lovelyId);
  await host.page.click(await reveal(host.page, '#lockBtn'));
  await hostState(host, (s) => s.locked);
  check('locked: student sees the paused note', Boolean(await until(() => visible(ava, '#lockedNote'))));
  check('locked: suggest buttons are disabled', await ava.page.locator(`#results li[data-id="${lovelyId}"] button`).isDisabled());
  const lockedTry = await suggest(ava, lovelyId, { force: true });
  check('locked: server refuses a suggestion with a friendly message', lockedTry?.reason === 'locked'
    && Boolean(await until(async () => (await text(ava, '#toasts')).includes('Your teacher has paused new suggestions.'))), JSON.stringify(lockedTry));
  check('host shows the locked state', (await text(host, '#lockBtn')).includes('locked') && (await visible(host, '#lockedNote')));
  await host.page.click(await reveal(host.page, '#lockBtn'));
  await hostState(host, (s) => !s.locked);
  await until(async () => !(await visible(ava, '#lockedNote')));
  const unlocked = await suggest(ava, lovelyId);
  check('unlocked: suggestion works again', unlocked?.ok === true, JSON.stringify(unlocked));

  // removeAtScore: at -2, one 👎 keeps the song and the second removes it.
  await hostSettings(host, { remove: -2 });
  await hostState(host, (s) => s.settings.removeAtScore === -2);
  const downId = itemOf(lastState(host), b2.trackId).id;
  await ava.page.click(`#queue li[data-id="${downId}"] button[data-act="down"]`);
  check('one 👎 at removeAtScore -2 keeps the song', Boolean(await hostState(host, (s) => s.queue.find((q) => q.id === downId)?.score === -1)));
  await ben.page.click(`#queue li[data-id="${downId}"] button[data-act="down"]`);
  check('second 👎 removes the song (removeAtScore -2)', Boolean(await hostState(host, (s) => !queueIds(s).includes(downId))));

  // Reconnect: cut Ava's network, change the room meanwhile, bring it back.
  await dropNetwork(ava);
  const dropped = await until(async () => (await text(ava, '#roomPillText')) === 'Reconnecting…', { timeout: 10_000 });
  check('offline: student page shows Reconnecting', Boolean(dropped));
  await host.page.click(await reveal(host.page, '#lockBtn'));
  await hostState(host, (s) => s.locked);
  // Long enough for a few failed tries (backoff 1 s, 2 s, 4 s).
  await new Promise((r) => setTimeout(r, 8000));
  check('offline: student page is still in the room (not sent out)', (await visible(ava, '#roomScreen')) && !(await visible(ava, '#lockedNote')));
  ava.offline = false;
  await ava.ctx.setOffline(false);
  const backAt = Date.now();
  // The page retries at once on the browser's 'online' event instead of waiting out the backoff.
  const back = await until(async () => (await text(ava, '#roomPillText')).startsWith('In class as Ava'), { timeout: 5000 });
  check('back online: student page reconnects within 5 s', Boolean(back), `pill says "${await text(ava, '#roomPill')}" after ${Date.now() - backAt} ms`);
  check('back online: state resumes (sees the lock made while offline)', Boolean(await until(() => visible(ava, '#lockedNote'))));
  await host.page.click(await reveal(host.page, '#lockBtn'));
  await hostState(host, (s) => !s.locked);

  // Needs a look: songs the checker does not know wait for the teacher (AI on, ask me first on).
  // Their UNKNOWN verdicts are seeded into the local KV, so no Workers AI call is made.
  const REVIEW_Q = {
    allow: 'Lean on Me Bill Withers', remove: 'Three Little Birds Bob Marley',
    ban: 'Yellow Submarine Beatles', kick: 'What a Wonderful World Louis Armstrong',
  };
  const rt = {};
  await apiJoin(code, 'flows-test-device-0002'); // firstNew searches the room as this device
  for (const [k, q] of Object.entries(REVIEW_Q)) rt[k] = await firstNew(roomId, q, used);
  reviewTracks = Object.values(rt);
  localKvBulk('delete', approvals(reviewTracks)); // a teacher yes left from an earlier run
  localKvBulk('put', reviewTracks.map((t) => ({ key: verdictKey(t), value: JSON.stringify({ verdict: 'unknown', reason: 'flows test', ...NO_LYRICS }) })));
  await hostSettings(host, { ai: true, unknown: true });
  await hostState(host, (s) => s.settings.aiCheck && s.settings.blockUnknownSongs);
  // A nickname the AI check flags (its verdict is seeded): the same friendly sentence, no reason.
  const joker = await openPage('joker', `?code=${code}`);
  pages.push(joker);
  await joinStudent(joker, code, 'Mike Hawk');
  const jokeMsg = await until(async () => (await visible(joker, '#joinScreen')) && (await text(joker, '#joinMsg')));
  check('AI-flagged nickname is refused with the same friendly message', jokeMsg === 'Please pick a different nickname.'
    && !(await visible(joker, '#roomScreen')), jokeMsg ?? 'no message');
  check('AI-flagged nickname: never in the host list; a cached verdict leaves the AI warning off',
    !lastState(host).students.some((x) => x.nick === 'Mike Hawk') && lastState(host).aiStatus === 'ok' && !(await visible(host, '#aiWarn')));
  check('AI-flagged nickname: the join button works again', !(await joker.page.locator('#joinBtn').isDisabled()));
  await joker.ctx.close();
  pages.splice(pages.indexOf(joker), 1);
  check('review: no "Needs a look" panel or badge while the list is empty', !(await visible(host, '#reviewPanel')) && !(await visible(host, '#listsBadge')));

  const held = await suggestFound(ava, REVIEW_Q.allow, rt.allow);
  check('review: unknown song gets the "teacher needs to check" reply', held?.ok === false && held.reason === 'review'
    && held.message === 'Your teacher needs to check that song first. It joins the queue if they say yes.', JSON.stringify(held));
  const s1 = await hostState(host, (s) => s.review?.length === 1);
  check('review: host gets the song on the review list, credited to the student', s1?.review[0].song.id === rt.allow && s1.review[0].by === 'Ava'
    && !s1.queue.some((q) => q.song.id === rt.allow), JSON.stringify(s1?.review));
  check('review: host shows the panel and the badge with a count', Boolean(await until(async () => (await visible(host, '#reviewPanel'))
    && (await visible(host, '#listsBadge')) && (await text(host, '#listsBadge')) === '1' && (await text(host, '#reviewBadgeCount')) === '1')));
  check('review: host announces the new song for screen readers', Boolean(await until(async () => (await text(host, '#announce')).includes('Needs a look'))));

  // Big screen: the projector view hides teacher tools but keeps the code, the queue and the badge.
  await host.page.click(await reveal(host.page, '#bigBtn'));
  check('big screen: teacher tools hide; address, code, queue and the Needs a look badge stay',
    !(await visible(host, '#settingsBtn')) && !(await visible(host, '#studentsBtn')) && !(await visible(host, '#reviewPanel'))
    && !(await host.page.locator('#queue button[data-act="ban"]').first().isVisible())
    && (await visible(host, '#bigCode')) && (await visible(host, '#joinHost')) && (await visible(host, '#queue')) && (await visible(host, '#listsBadge'))
    && (await host.page.getAttribute('#bigBtn', 'aria-checked')) === 'true');
  await host.page.keyboard.press('Escape');
  check('big screen: Esc leaves it', (await visible(host, '#settingsBtn')) && (await host.page.getAttribute('#bigBtn', 'aria-checked')) === 'false');
  await host.page.click(await reveal(host.page, '#bigBtn'));
  await host.page.click(await reveal(host.page, '#reviewBadge'));
  check('big screen: the Needs a look badge brings the Allow / Remove / Ban buttons back', (await visible(host, '#reviewPanel'))
    && !(await host.page.evaluate(() => document.body.classList.contains('big'))));
  const avaState = await until(() => lastState(ava)?.you?.review === 1 && lastState(ava));
  check('review: student state counts it, and never has the review list', Boolean(avaState) && avaState.review === undefined
    && !avaState.queue.some((q) => q.song.id === rt.allow));
  check('review: student page says it is waiting for the teacher', Boolean(await until(async () => /waiting for your teacher/.test(await text(ava, '#waiting'))))
    && /Teacher checking/.test(await text(ava, `#results li[data-id="${rt.allow}"]`)));
  check('review: student sees the friendly toast', (await text(ava, '#toasts')).includes('❓ The checker does not know this song: Your teacher will check it.'));

  const dup = await suggestFound(ben, REVIEW_Q.allow, rt.allow);
  check('review: same song from another student is a duplicate', dup?.ok === false && dup.reason === 'duplicate', JSON.stringify(dup));

  const heldRemove = await suggestFound(ben, REVIEW_Q.remove, rt.remove); // Ben: Ava is near 6 suggestions a minute
  const heldBan = await suggestFound(ben, REVIEW_Q.ban, rt.ban);
  const heldKick = await suggestFound(ben, REVIEW_Q.kick, rt.kick);
  check('review: three more songs wait for a look', [heldRemove, heldBan, heldKick].every((m) => m?.reason === 'review'), JSON.stringify([heldRemove, heldBan, heldKick]));
  const s4 = await hostState(host, (s) => s.review?.length === 4);
  check('review: list is oldest first', JSON.stringify(s4?.review.map((x) => x.song.id)) === JSON.stringify([rt.allow, rt.remove, rt.ban, rt.kick]), JSON.stringify(s4?.review.map((x) => x.song.id)));
  const reviewId = (trackId) => lastState(host).review.find((x) => x.song.id === trackId)?.id;
  const reviewTitle = (trackId) => s4.review.find((x) => x.song.id === trackId)?.song.title;

  // Allow: it joins the queue for Ava, she is told, and the yes is remembered in KV.
  const allowId = reviewId(rt.allow);
  await host.page.click(`#review li[data-id="${allowId}"] button[data-act="allow"]`);
  const sAllowed = await hostState(host, (s) => !s.review.some((x) => x.id === allowId) && s.queue.some((q) => q.id === allowId));
  check('allow: the song joins the queue credited to its student', sAllowed?.queue.find((q) => q.id === allowId)?.by === 'Ava');
  check('allow: the student is told', Boolean(await until(async () => (await text(ava, '#toasts')).includes('Your teacher said yes to'))));
  check('allow: the student sees it in the queue as hers', Boolean(await until(() => lastState(ava)?.queue.find((q) => q.id === allowId)?.mine)));
  const approved = localKvGet(approvedKey(rt.allow));
  check('allow: KV remembers the teacher\'s yes (approved:<trackId>)', Boolean(approved) && JSON.parse(approved).id === rt.allow, String(approved).slice(0, 120));

  // Remove: gone, and the student is told kindly.
  const removeId = reviewId(rt.remove);
  await host.page.click(`#review li[data-id="${removeId}"] button[data-act="veto"]`);
  check('remove: the song leaves the review list (not into the queue)', Boolean(await hostState(host, (s) => !s.review.some((x) => x.id === removeId)
    && !s.queue.some((q) => q.song.id === rt.remove))));
  check('remove: the student is told kindly', Boolean(await until(async () => (await text(ben, '#toasts')).includes(`said no to "${reviewTitle(rt.remove)}" this time. 🍎 Teacher's choice. Try a different song!`))));
  check('remove: no approved verdict for a removed song', localKvGet(approvedKey(rt.remove)) === null);

  // Ban (asks first): gone for good.
  const banReviewId = reviewId(rt.ban);
  await host.page.click(`#review li[data-id="${banReviewId}"] button[data-act="ban"]`);
  await confirmOk(host);
  check('ban from review: the song leaves the list', Boolean(await hostState(host, (s) => !s.review.some((x) => x.id === banReviewId))));
  check('ban from review: the student is told', Boolean(await until(async () => (await text(ben, '#toasts')).includes(`said no to "${reviewTitle(rt.ban)}"`))));
  check('ban from review: the song is gone from new searches', !(await search(ben, REVIEW_Q.ban)).includes(rt.ban));
  check('review: one song left (the one for the kick)', Boolean(await hostState(host, (s) => s.review.length === 1 && s.review[0].song.id === rt.kick))
    && (await text(host, '#reviewBadgeCount')) === '1');

  // Kick Ben: he sees the kicked screen, his songs go, and he cannot rejoin.
  const benDevice = lastState(host).students.find((x) => x.nick === 'Ben').device;
  await host.page.click(await reveal(host.page, '#studentsBtn'));
  await host.page.click(`#students li[data-id="${benDevice}"] button[data-act="kick"]`);
  await confirmOk(host);
  await host.page.waitForSelector('#studentsDlg[open]');
  await host.page.click('#studentsDlg button[value="done"]');
  check('kicked student sees the kicked screen', Boolean(await until(async () => (await visible(ben, '#endScreen')) && (await text(ben, '#endTitle')) === 'You are out of this room')));
  check('kicked student\'s songs leave the queue', Boolean(await hostState(host, (s) => !s.queue.some((q) => q.by === 'Ben') && !s.students.some((x) => x.nick === 'Ben'))));
  check('kicked student\'s review songs leave the list, and the panel hides', Boolean(await hostState(host, (s) => s.review.length === 0))
    && Boolean(await until(async () => !(await visible(host, '#reviewPanel')) && !(await visible(host, '#listsBadge')))));
  await ben.page.click('#endBtn');
  await joinStudent(ben, code, 'Ben');
  check('kicked student cannot rejoin, even with the right code', Boolean(await until(async () => /removed you from this room/.test(await text(ben, '#joinMsg'))))
    && !(await visible(ben, '#roomScreen')));
  const benSearch = (await fetch(new URL(`api/rooms/${roomId}/search?q=happy`, BASE), { headers: { 'x-device': benDevice } })).status;
  check('kicked student cannot search the room', benSearch === 403, String(benSearch));
  const strangerSearch = await fetch(new URL(`api/rooms/${roomId}/search?q=happy`, BASE), { headers: { 'x-device': 'flows-never-joined-01' } });
  check('a device that never joined cannot search the room', strangerSearch.status === 403 && (await strangerSearch.json()).error === 'join');

  // Change the class code mid-day: Ava stays in, the old code stops working, the new one works.
  await host.page.click(await reveal(host.page, '#changeCodeBtn'));
  await host.page.waitForSelector('#codeDlg[open]');
  const newShown = await host.page.inputValue('#codeInput');
  await host.page.click('#codeSave');
  const changed = await until(async () => (await host.page.getAttribute('#bigCode', 'aria-label')) === newShown);
  check('change code: the board shows the new code', Boolean(changed), `${await host.page.getAttribute('#bigCode', 'aria-label')} vs ${newShown}`);
  const newCode = newShown.replace(/ /g, '-');
  check('change code: the host remembers it (and the join link)', (await hostRoom(host)).code === newCode
    && (await host.page.getAttribute('#copyLink', 'data-url')).includes(`code=${newCode}`));
  const [oldStatus, oldBody] = await apiJoin(code, 'flows-new-device-0001');
  check('change code: the old code no longer joins', oldStatus === 403 && oldBody.error === 'code', `${oldStatus} ${JSON.stringify(oldBody)}`);
  const dee = await openPage('dee', '');
  pages.push(dee);
  await joinStudent(dee, newShown.toUpperCase(), 'Dee'); // capitals and spaces do not matter
  check('change code: a new student joins with the new code', Boolean(await until(() => visible(dee, '#roomScreen'))));
  check('change code: students already in stay in', (await visible(ava, '#roomScreen')) && Boolean(await hostState(host, (s) => s.students.some((x) => x.nick === 'Ava' && x.online))));
  // The other teacher cannot open a room with a code in use.
  const taken = await api('/api/teacher/rooms', { method: 'POST', body: JSON.stringify({ code: newCode, until: Date.now() + 60 * 60_000 }) });
  check('a code already in use is refused for another room', taken.status === 409 && (await taken.json()).error === 'code_taken', String(taken.status));
  await dee.ctx.close();
  pages.splice(pages.indexOf(dee), 1);

  // Autoplay blocked: nothing plays before a click, "Start music" starts it.
  const sBefore = await hostState(host, (s) => s.queue.length >= 2);
  check('queue has songs before starting music', Boolean(sBefore));
  check('autoplay: host shows "Start music" and nothing plays yet', (await visible(host, '#startBtn')) && !lastState(host).nowPlaying);
  const nowText = await text(host, '#nowPlaying');
  check('autoplay: now-playing panel says it is ready', nowText.includes('Ready when you are.'), nowText.trim());
  await host.page.click('#startBtn');
  const playing = await hostState(host, (s) => s.nowPlaying);
  check('autoplay: after the click the top song becomes now playing', Boolean(playing));
  const progressed = await until(async () => parseFloat(await host.page.$eval('#progressBar', (e) => e.style.width || '0')) > 0, { timeout: 15_000 });
  check('autoplay: the preview is actually playing (progress moves)', Boolean(progressed));
  check('autoplay: Pause button shows', (await visible(host, '#playBtn')) && !(await visible(host, '#startBtn')));

  // Ban the song now playing: it advances, and re-suggesting it is refused as banned.
  const nowTrack = playing.nowPlaying.song.id;
  const nowId = playing.nowPlaying.id;
  const query = nowTrack === a3.trackId ? 'Shake It Off Taylor Swift' : 'Lovely Day Bill Withers';
  await search(ava, query);
  await host.page.click(await reveal(host.page, '#banNowBtn'));
  await confirmOk(host);
  const advanced = await hostState(host, (s) => s.nowPlaying?.id !== nowId);
  check('ban now playing: the room moves on', Boolean(advanced) && (!advanced.nowPlaying || advanced.nowPlaying.song.id !== nowTrack));
  await until(async () => !(await ava.page.locator(`#results li[data-id="${nowTrack}"] button`).isDisabled()));
  const reNow = await suggest(ava, nowTrack, { force: true });
  check('ban now playing: re-suggest is refused with the banned reason', reNow?.ok === false && reNow.reason === 'banned', JSON.stringify(reNow));

  // Save as my default: the teacher API has it and a new room starts with it.
  await hostSettings(host, { max: 4, remove: -4, ai: true, unknown: true, words: ['pineapple', 'beer'] }, '#saveDefault');
  check('save as default: room uses it', Boolean(await hostState(host, (s) => s.settings.maxWaitingPerStudent === 4 && s.settings.removeAtScore === -4)));
  const saved = await (await api('/api/teacher/settings')).json();
  check('save as default: GET /api/teacher/settings has it', saved.maxWaitingPerStudent === 4 && saved.removeAtScore === -4 && saved.blocklist.includes('pineapple'), JSON.stringify(saved));
  // One room per teacher (CLAUDE.md invariant 31): a second room is refused while this one is open.
  const twice = await api('/api/teacher/rooms', { method: 'POST', body: JSON.stringify({ code: `flows twice ${10 + Math.floor(Math.random() * 90)}`, until: Date.now() + 60_000 }) });
  check('one room at a time: a second room is refused (409 one_room)', twice.status === 409 && (await twice.json()).error === 'one_room');

  // Rename: the teacher asks Ava for a different nickname. Her device stays admitted (the class
  // code changed since she joined, and she gets back in without it); "Ava" is not usable here again.
  const avaDevice = lastState(host).students.find((x) => x.nick === 'Ava').device;
  await host.page.click(await reveal(host.page, '#studentsBtn'));
  await host.page.click(`#students li[data-id="${avaDevice}"] button[data-act="rename"]`);
  await confirmOk(host);
  await host.page.waitForSelector('#studentsDlg[open]');
  await host.page.click('#studentsDlg button[value="done"]');
  const renameMsg = await until(async () => (await visible(ava, '#joinScreen')) && (await text(ava, '#joinMsg')));
  check('rename: the student is back on the join screen with the teacher request', renameMsg === 'Your teacher asked you to pick a different nickname.'
    && (await ava.page.evaluate(() => document.activeElement?.id)) === 'nick', renameMsg ?? 'no message');
  check('rename: the host list drops the old nickname, and no song shows it', Boolean(await hostState(host,
    (s) => !s.students.some((x) => x.device === avaDevice) && ![s.nowPlaying, ...s.queue].some((q) => q?.by === 'Ava'))));
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  const oldNick = await until(async () => (await text(ava, '#joinMsg')) === 'Please pick a different nickname.' && !(await ava.page.locator('#joinBtn').isDisabled()));
  check('rename: the old nickname is refused', Boolean(oldNick) && !(await visible(ava, '#roomScreen')), await text(ava, '#joinMsg'));
  await ava.page.fill('#nick', 'Ava Rose');
  await ava.page.click('#joinBtn');
  check('rename: a new nickname goes straight back in, no class code needed', Boolean(await until(async () => (await visible(ava, '#roomScreen'))
    && (await text(ava, '#roomPillText')) === 'In class as Ava Rose')));
  check('rename: the host sees the new nickname on the same device', Boolean(await hostState(host,
    (s) => s.students.some((x) => x.device === avaDevice && x.nick === 'Ava Rose' && x.online))));

  // Close the room: the student is sent out.
  await host.page.click(await reveal(host.page, '#closeBtn'));
  await confirmOk(host);
  check('close: host shows closed', Boolean(await until(() => visible(host, '#closedScreen'))));
  check('close: student sees the room closed', Boolean(await until(async () => (await visible(ava, '#endScreen')) && (await text(ava, '#endTitle')) === 'The room is closed')));
  check('close: the class code stops working', (await apiJoin(newCode, 'flows-new-device-0002'))[0] === 403);

  // A new room once the first is closed: saved defaults, the ban list and approvals reach it.
  const host2 = await openPage('host2', 'host/');
  pages.push(host2);
  const { code: code2, id: roomId2 } = await openRoom(host2);
  // The ban list lives in KV, so it reaches every new room too.
  await apiJoin(code2, 'flows-test-device-0001');
  const r2 = await (await fetch(new URL(`api/rooms/${roomId2}/search?q=${encodeURIComponent('Here Comes the Sun Beatles')}`, BASE),
    { headers: { 'x-device': 'flows-test-device-0001' } })).json();
  check('ban list (KV) holds in a new room: the banned song is not in its search', Array.isArray(r2.results)
    && !r2.results.some((s) => s.id === banTrack || s.id === nowTrack), JSON.stringify(r2).slice(0, 200));
  const s2 = await hostState(host2, () => true);
  check('save as default: a new room starts with it', s2?.settings.maxWaitingPerStudent === 4 && s2.settings.removeAtScore === -4, JSON.stringify(s2?.settings));
  // The teacher's yes holds in every room: the allowed song goes straight into this room's queue
  // (AI check and "ask me first" both on, and its seeded verdict still says UNKNOWN).
  const cy = await openPage('cy', `?code=${code2}`);
  pages.push(cy);
  await joinStudent(cy, code2, 'Cy');
  await cy.page.waitForSelector('#roomScreen:not([hidden])');
  const again = await suggestFound(cy, REVIEW_Q.allow, rt.allow);
  check('allow: a teacher-approved song passes in a new room without asking again', again?.ok === true, JSON.stringify(again));
  check('allow: ... and the new room\'s review list stays empty', Boolean(await hostState(host2, (s) => s.queue.some((q) => q.song.id === rt.allow) && s.review.length === 0)));
  await host2.page.click(await reveal(host2.page, '#closeBtn'));
  await confirmOk(host2);
  check('second room closes', Boolean(await until(() => visible(host2, '#closedScreen'))) && code2 !== code);

  // A room closes itself at `until` (a short one here; the host page offers 50 minutes and up).
  const shortCode = `flows short room ${10 + Math.floor(Math.random() * 90)}`;
  const opened = await api('/api/teacher/rooms', { method: 'POST', body: JSON.stringify({ code: shortCode, until: Date.now() + 12_000 }) });
  const short = await opened.json();
  check('a room opens with a short until', opened.ok && short.code === shortCode.replace(/ /g, '-'), JSON.stringify(short));
  const eli = await openPage('eli', '');
  pages.push(eli);
  await joinStudent(eli, shortCode, 'Eli');
  check('until: a student joins the short room', Boolean(await until(() => visible(eli, '#roomScreen'))));
  const ended = await until(async () => (await visible(eli, '#endScreen')) && (await text(eli, '#endText')), { timeout: 25_000 });
  check('until: the room closes itself and the student is told it closed for today', /closed for today/.test(ended ?? ''), ended);
  const gone = await fetch(new URL(`api/rooms/${short.room}`, BASE));
  check('until: the room is gone (404) and its code no longer joins', gone.status === 404 && (await apiJoin(shortCode, 'flows-new-device-0003'))[0] === 403);

  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL flows stopped: ${e?.stack ?? e}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) });
  if (!r.ok) console.log('FAIL could not put the saved teacher settings back');
  try {
    localKvBulk('delete', NICK_VERDICTS.map(([n]) => nickVerdictKey(n)));
    if (reviewTracks.length) localKvBulk('delete', [...reviewTracks.map(verdictKey), ...approvals(reviewTracks)]);
  } catch (e) {
    console.log(`FAIL could not clean the seeded local KV keys: ${e.message}`);
  }
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
