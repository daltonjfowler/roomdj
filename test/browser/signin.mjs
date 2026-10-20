// Sign in with Spotify (protocol.js SPOTIFY SIGN-IN) in a real browser, against a FAKE Spotify:
// own app → private teacher; RoomDJ's app → the teacher linked to the Spotify email (nobody picks;
// a matching display name is not enough); a signed-in teacher cannot take back another
// teacher's room even with its code; the board follows the signed-in teacher; Sign out.
//
// Start a dev server whose sign-ins go to the fake Spotify this test runs on FAKE_PORT, with a fresh
// local storage folder (the teacher list must start as the seed list):
//   npm run build
//   npx wrangler dev --ip 127.0.0.1 --port 8798 --local-upstream 127.0.0.1:8798 \
//     --persist-to .wrangler/signin-test --var SPOTIFY_AUTH_TEST_BASE:http://127.0.0.1:8797 --var TYPED_NICKNAMES:off --var ADMIN_PROFILES:teacher-1
//   node test/browser/signin.mjs http://127.0.0.1:8798
// Accounts.spotify.com/authorize is caught in the browser and answered with a redirect back to
// /host/ (the code names the Spotify user the fake Spotify then reports).

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isGeneratedNick } from '../../shared/nickgen.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:8798';
const FAKE_PORT = 8797;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = new URL('../../', import.meta.url);
const OWN = '0123456789abcdef0123456789abcdef';
const SHARED = readFileSync(new URL('wrangler.jsonc', ROOT), 'utf8').match(/"SPOTIFY_CLIENT_ID":\s*"([0-9a-f]{32})"/)[1];

if (!['127.0.0.1', 'localhost'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: runs only against a local dev server (not ${BASE})`);
  process.exit(1);
}

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    return import(pathToFileURL(process.env.PLAYWRIGHT_CORE || fileURLToPath(new URL('../uploadmycut/node_modules/playwright-core/index.mjs', ROOT))).href);
  }
}
const pw = await loadPlaywright();
const { chromium } = pw.chromium ? pw : pw.default;

const PERSIST = '.wrangler/signin-test';
function teacherKey() {
  const line = readFileSync(new URL('.dev.vars', ROOT), 'utf8').split(/\r?\n/).find((l) => l.startsWith('TEACHER_KEY='));
  return line.slice('TEACHER_KEY='.length).trim().replace(/^"(.*)"$/, '$1');
}
/** Link an email to a list teacher in the LOCAL KV (scripts/link-teacher.mjs, with the test's storage folder). */
function linkLocal(email, profileId) {
  const hash = createHash('sha256').update(`email:${email}`).digest('hex');
  const wrangler = fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', ROOT));
  const r = spawnSync(process.execPath, [wrangler, 'kv', 'key', 'put', `link:v1:${hash}`, profileId, '--binding', 'CLASS_KV', '--local', '--persist-to', PERSIST], { cwd: fileURLToPath(ROOT), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

/** A teacher API call from a signed-in page (its session). → { status, data } */
const apiCall = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const s = JSON.parse(sessionStorage.getItem('cq.session'));
  const r = await fetch(path, { method, headers: { authorization: `Bearer ${s.session}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, { method, path, body });

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
  if (!ok) failed++;
  return ok;
}

// ---- The fake Spotify: code "U.<id>.<name>" is that user ----
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/token' && req.method === 'POST') {
      const code = new URLSearchParams(body).get('code') ?? '';
      return res.end(JSON.stringify({ access_token: `ACC_${code}`, refresh_token: `REF_${code}`, expires_in: 3600 }));
    }
    if (req.url === '/v1/me') {
      const code = (req.headers.authorization ?? '').replace('Bearer ACC_', '');
      const [, id, name] = code.split('.');
      if (!id) { res.statusCode = 401; return res.end('{}'); }
      return res.end(JSON.stringify({ id, display_name: decodeURIComponent(name ?? ''), email: `${id}@example.com` }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME });

/** A fresh browser profile whose Spotify login is the user `id` called `name`. */
async function teacher(id, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  page error (${id}): ${e.message}`));
  await page.route('https://accounts.spotify.com/authorize**', (route) => {
    const u = new URL(route.request().url());
    const to = `${BASE}/host/?code=${encodeURIComponent(`U.${id}.${encodeURIComponent(name)}`)}&state=${u.searchParams.get('state')}`;
    page.clientIdUsed = u.searchParams.get('client_id');
    route.fulfill({ status: 302, headers: { location: to } });
  });
  await page.route('https://sdk.scdn.co/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await page.route('https://api.spotify.com/**', (r) => r.fulfill({ status: 401, json: {} }));
  return { context, page };
}

const visible = (page, sel) => page.locator(sel).isVisible();
async function waitFor(page, sel, timeout = 15_000) {
  await page.locator(sel).waitFor({ state: 'visible', timeout });
}

async function signIn(page, app, clientId = OWN) {
  await page.goto(`${BASE}/host/`);
  await waitFor(page, '#signinStep');
  await page.waitForFunction(() => !document.querySelector('#signinSetup').hidden || !document.querySelector('#signinReady').hidden);
  if (app === 'shared') await page.click('#sharedBtn'); // "Invited? Sign in with no setup"
  else {
    if (await visible(page, '#otherApp')) await page.click('#otherApp'); // back on this computer: one button
    await page.fill('#clientId', clientId);
    await page.click('#signinBtn');
  }
  return passDisclaimer(page);
}

/**
 * The first-sign-in disclaimer (protocol.js DISCLAIMER): once per teacher. When it shows, OK is
 * locked for 5 seconds, then closes it. → { shown, locked } (locked: OK started disabled with "(5)").
 */
async function passDisclaimer(page) {
  await waitFor(page, '#keyForm');
  const shown = await page.locator('#disclaimerDlg[open]').waitFor({ timeout: 4000 }).then(() => true, () => false);
  if (!shown) return { shown: false };
  const locked = await page.evaluate(() => {
    const ok = document.querySelector('#disclaimerOk');
    return ok.disabled && /\(5\)|\(4\)/.test(ok.textContent);
  });
  const started = Date.now();
  await page.locator('#disclaimerOk:not([disabled])').waitFor({ timeout: 8000 });
  const waited = Date.now() - started;
  await page.click('#disclaimerOk');
  await page.locator('#disclaimerDlg:not([open])').waitFor({ state: 'attached', timeout: 5000 });
  return { shown: true, locked: locked && waited > 3000 };
}

async function openRoom(page) {
  await waitFor(page, '#keyForm');
  const code = (await page.inputValue('#openCode')).trim();
  await page.click('#openBtn');
  await waitFor(page, '#hostScreen');
  return code;
}

try {
  // ---- 1. Own app ----
  const rivera = await teacher('rivera', 'Ms Rivera');
  const riveraFirst = await signIn(rivera.page, 'own');
  await waitFor(rivera.page, '#keyForm');
  check('first sign-in: the disclaimer shows, OK locked for 5 seconds', riveraFirst.shown && riveraFirst.locked, JSON.stringify(riveraFirst));
  await rivera.page.reload();
  check('after OK: not again on this computer', !(await passDisclaimer(rivera.page)).shown);
  check('own app: the login used the typed Client ID', rivera.page.clientIdUsed === OWN, rivera.page.clientIdUsed);
  check('own app: signed in as the Spotify name', (await rivera.page.textContent('#teachingName')) === 'Ms Rivera');
  check('own app: Sign out shown, Switch teacher hidden', (await visible(rivera.page, '#signOutBtn')) && !(await visible(rivera.page, '#switchTeacher')));
  const store = await rivera.page.evaluate(() => ({
    tab: Boolean(sessionStorage.getItem('cq.session')),
    computer: localStorage.getItem('cq.session'),
    spotify: JSON.parse(localStorage.getItem('cq.spotify') ?? 'null'),
    url: location.href,
  }));
  check('session in this tab only (Stay signed in not ticked)', store.tab && store.computer === null, JSON.stringify(store));
  check('the sign-in also connected Spotify for playback (own Client ID)', store.spotify?.clientId === OWN && store.spotify?.access?.startsWith('ACC_'), JSON.stringify(store.spotify));
  check('no code or state left in the address bar', !/[?&](code|state)=/.test(store.url), store.url);
  for (let i = 0; i < 100 && !(await visible(rivera.page, '#usageNote')); i++) await new Promise((r) => setTimeout(r, 100));
  const usage = await rivera.page.textContent('#usageNote');
  check('free teacher: what is left today and when it resets', /10 of 10 rooms/.test(usage) && /150 of 150 new-song checks/.test(usage) && /Resets (today|tomorrow) at/.test(usage), usage);
  const riveraCode = await openRoom(rivera.page);
  check('own app: opens a room', Boolean(riveraCode));
  const second = await apiCall(rivera.page, 'POST', '/api/teacher/rooms', { code: 'second room 12', until: Date.now() + 3600_000 });
  check('free teacher: one class at a time', second.status === 409 && second.data.error === 'one_room', JSON.stringify(second));

  // ---- 1b. A student gets a made nickname ("Adjective Noun"), 🎲 for another, nothing typed ----
  const kidCtx = await browser.newContext();
  const kid = await kidCtx.newPage();
  await kid.goto(`${BASE}/?code=${encodeURIComponent(riveraCode)}`);
  await waitFor(kid, '#nickShown');
  const first = (await kid.textContent('#nickShown')).trim();
  check('student: a made nickname, no typing box', isGeneratedNick(first) && !(await visible(kid, '#nick')), first);
  let rolled = first;
  for (let i = 0; i < 5 && rolled === first; i++) { await kid.click('#nickRoll'); rolled = (await kid.textContent('#nickShown')).trim(); }
  check('student: 🎲 picks another', rolled !== first && isGeneratedNick(rolled), rolled);
  await kid.click('#joinBtn');
  await waitFor(kid, '#roomScreen');
  check('student: joined as the made nickname', (await kid.textContent('#roomPillText')).includes(rolled), await kid.textContent('#roomPillText'));
  await kidCtx.close();

  // ---- 2. RoomDJ's app: the Spotify email decides the teacher (nobody picks) ----
  const seeded = await fetch(`${BASE}/api/teacher/profiles`, { headers: { 'x-teacher-key': teacherKey() } }); // writes the seed list
  check('seed list written', seeded.ok, String(seeded.status));
  linkLocal('dalton@example.com', 'teacher-1');
  const dalton = await teacher('dalton', 'Peter Robinson'); // a display name of someone else: it must not matter
  await signIn(dalton.page, 'shared');
  await waitFor(dalton.page, '#keyForm');
  check('shared app: the login used RoomDJ\'s Client ID', dalton.page.clientIdUsed === SHARED, dalton.page.clientIdUsed);
  check('shared app: signed in as the teacher linked to the email', (await dalton.page.textContent('#teachingName')) === 'Teacher 1');
  check('no "which teacher are you?" screen at all', (await dalton.page.locator('#claimStep').count()) === 0);
  await new Promise((r) => setTimeout(r, 800));
  check('RoomDJ\'s own app: no usage limits shown', !(await visible(dalton.page, '#usageNote')));

  // ---- 2b. Admin (the dev server runs with --var ADMIN_PROFILES:teacher-1) ----
  for (let i = 0; i < 50 && !(await visible(dalton.page, '#adminLink')); i++) await new Promise((r) => setTimeout(r, 100));
  check('admin: the Admin link on the start screen', await visible(dalton.page, '#adminLink'));
  await dalton.page.goto(`${BASE}/admin/`);
  for (let i = 0; i < 100 && !(await visible(dalton.page, '#dash')); i++) await new Promise((r) => setTimeout(r, 100));
  const tiles = await dalton.page.textContent('#nTeachers').catch(() => '');
  check('admin: the numbers load', await visible(dalton.page, '#dash') && /\d/.test(tiles), tiles);
  check('admin: the teacher list shows who signed in', /Teacher 1[\s\S]*signed in/.test(await dalton.page.textContent('#teacherList')));
  if (process.env.SHOTS) await dalton.page.screenshot({ path: `${process.env.SHOTS}/admin.png`, fullPage: true });
  await dalton.page.goto(`${BASE}/host/`);
  await waitFor(dalton.page, '#keyForm');

  // ---- 2c. Close my open rooms (and the board link is on the start screen) ----
  check('start screen: a clear board link', (await dalton.page.getAttribute('#boardOpenLink', 'href')) === '/board/' && await visible(dalton.page, '#boardOpenLink'));
  const daltonCode = await openRoom(dalton.page);
  // Another computer, same Spotify account: "Your open rooms" shows it; Open here moves it.
  const other = await teacher('dalton', 'Peter Robinson');
  const otherFirst = await signIn(other.page, 'shared');
  check('the same teacher on another computer: no disclaimer (the OK is kept on the server)', !otherFirst.shown);
  await waitFor(other.page, '#keyForm');
  await waitFor(other.page, '#openRooms');
  const listed = await other.page.textContent('#openRoomsList');
  check('your open rooms: the room, its code, with Open here', listed.replace(/\s+/g, ' ').includes(daltonCode.replace(/\s+/g, ' ')) && (await other.page.locator('#openRoomsList button').count()) === 1, listed);
  await other.page.click('#openRoomsList button');
  await waitFor(other.page, '#hostScreen');
  check('Open here: the room runs on this computer, code shown', (await other.page.textContent('#bigCode')).replace(/\s+/g, '').toLowerCase() === daltonCode.replace(/\s+/g, '').toLowerCase(), `shown ${await other.page.textContent('#bigCode')} / opened ${daltonCode}`);
  for (let i = 0; i < 100 && (await visible(dalton.page, '#hostScreen')); i++) await new Promise((r) => setTimeout(r, 100));
  check('the first computer lets go of it', !(await visible(dalton.page, '#hostScreen')));
  await other.context.close();
  await dalton.page.goto(`${BASE}/host/`);
  await waitFor(dalton.page, '#keyForm');
  // One room per Spotify account (Dalton, 2026-10-16 and 2026-10-20): a second one is refused.
  await dalton.page.click('#openBtn');
  for (let i = 0; i < 100 && !/one room at a time/.test(await dalton.page.textContent('#keyMsg')); i++) await new Promise((r) => setTimeout(r, 100));
  check('one room per Spotify account: a second room is refused', /one room at a time/.test(await dalton.page.textContent('#keyMsg')) && !(await visible(dalton.page, '#hostScreen')), await dalton.page.textContent('#keyMsg'));
  const closedAll = await dalton.page.evaluate(async () => {
    const s = JSON.parse(sessionStorage.getItem('cq.session'));
    const r = await fetch('/api/teacher/rooms/close-all', { method: 'POST', headers: { authorization: `Bearer ${s.session}` } });
    return r.json();
  });
  check('close my open rooms: closes this teacher\'s one room (the moved one)', closedAll.closed === 1, JSON.stringify(closedAll));
  await dalton.page.goto(`${BASE}/host/`); // the moved room's host page was closed with the other computer
  await waitFor(dalton.page, '#keyForm');
  check('closed: no open rooms left to list', !(await visible(dalton.page, '#openRooms')));
  check('another teacher\'s room was not touched (Ms Rivera still runs hers)', await visible(rivera.page, '#hostScreen') || (await rivera.page.url()).includes('/board'));
  await dalton.page.goto(`${BASE}/host/`);
  await waitFor(dalton.page, '#keyForm');

  // ---- 3. A display name that matches a teacher is not enough ----
  const peter = await teacher('impostor', 'Teacher 1');
  await signIn(peter.page, 'shared');
  await waitFor(peter.page, '#keyForm');
  const got = await peter.page.textContent('#teachingName');
  check('not linked: a new teacher with the Spotify name (numbered), never Teacher 1', got === 'Teacher 1 2', got);
  check('not an admin: no Admin link', !(await visible(peter.page, '#adminLink')));
  await peter.page.goto(`${BASE}/admin/`);
  for (let i = 0; i < 100 && !(await visible(peter.page, '#gate')); i++) await new Promise((r) => setTimeout(r, 100));
  check('not an admin: /admin/ shows nothing', (await visible(peter.page, '#gate')) && !(await visible(peter.page, '#dash'))
    && /not an admin/.test(await peter.page.textContent('#gateText')));
  await peter.page.goto(`${BASE}/host/`);
  await waitFor(peter.page, '#keyForm');

  // ---- 4. Another teacher's room: not in your list, cannot be opened by id ----
  const riveraRoom = await rivera.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')).room);
  const peterList = await apiCall(peter.page, 'GET', '/api/teacher/rooms');
  check("your open rooms: never another teacher's", peterList.status === 200 && !peterList.data.rooms.some((x) => x.room === riveraRoom), JSON.stringify(peterList));
  const steal = await apiCall(peter.page, 'POST', '/api/teacher/rooms/resume', { room: riveraRoom });
  check("another teacher's room cannot be opened here (404)", steal.status === 404, JSON.stringify(steal));
  check('Ms Rivera still runs her room', await visible(rivera.page, '#hostScreen'));
  check('the old "Take back a room" button is gone', (await peter.page.locator('#reclaimLink, #reclaimBtn').count()) === 0);

  // ---- 5. The board follows the signed-in teacher (same tab) ----
  await rivera.page.goto(`${BASE}/board/`);
  let boardShows = '';
  for (let i = 0; i < 150 && !boardShows; i++) {
    for (const id of ['#boardScreen', '#waitScreen', '#signinScreen']) if (await visible(rivera.page, id)) boardShows = id;
    if (!boardShows) await new Promise((r) => setTimeout(r, 100));
  }
  check('board: signed in already, shows her room (no sign-in screen)', boardShows === '#boardScreen', boardShows || 'nothing');
  const btns = await rivera.page.evaluate(() => ({
    waitSwitch: document.querySelector('#waitSwitch').hidden, menuSwitch: document.querySelector('#menuSwitch').hidden,
    forget: document.querySelector('#waitForget').textContent, menuForget: document.querySelector('#menuForget').textContent,
  }));
  check('board signed in: no old "Switch teacher"; "Sign out of this board"', btns.waitSwitch && btns.menuSwitch
    && btns.forget === 'Sign out of this board' && btns.menuForget === 'Sign out of this board', JSON.stringify(btns));

  // ---- 6. Sign out ----
  await peter.page.click('#signOutBtn');
  await waitFor(peter.page, '#signinStep');
  const gone = await peter.page.evaluate(() => [sessionStorage.getItem('cq.session'), localStorage.getItem('cq.session'), localStorage.getItem('cq.spotify')]);
  check('sign out: session and Spotify login forgotten here', gone.every((v) => v === null), JSON.stringify(gone));
  await peter.page.reload();
  await waitFor(peter.page, '#signinStep');
  check('signed out stays signed out after a reload', await visible(peter.page, '#signinStep'));
} catch (e) {
  check('no unexpected error', false, e.stack);
} finally {
  await browser.close();
  fake.close();
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
