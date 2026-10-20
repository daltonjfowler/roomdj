// Browser test of teacher picks (shared/protocol.js TEACHER PICKS): the teacher suggests songs and
// votes from the host page. One host page, one student page, a board page, plus a raw host socket
// (to send what the page offers no button for), in installed Chrome (playwright-core), against a
// LOCAL wrangler dev only.
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:teacher-suggest      (or: node test/browser/teacher-suggest.mjs http://127.0.0.1:8792/)
// A dev server started with --persist-to <dir>: set CQ_PERSIST=<dir> so the KV seeding reaches it.
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// No Workers AI call: the AI check is on only while one song is suggested whose UNKNOWN verdict
// (NO_LYRICS: no lyrics lookup) this test seeds into the LOCAL KV, plus a made-up explicit song in
// the KV song cache; both deleted at the end. The repeat cooldown is off while it runs (the saved
// settings go back at the end). Searches hit the real iTunes API through the host page.
// Covers: 🔎 Suggest a song (search + suggest a clean song: "🍎 Teacher 1" on the student page,
// the host and the board), a blocked word refused with the reason and the word for the teacher
// (Blocked today, tagged teacher), an explicit song refused, an unknown song in Needs a look,
// suggestions locked → the teacher can still add, credits on → the teacher is not charged and is no
// student, the teacher's 👍 on a queued song (one vote, take back), 👍 on the song playing, 👎 on
// it refused, the recap's Top contributor / Top voter / Crowd favorite never the teacher, the A key.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_LYRICS, approvedKey, verdictKey } from '../../shared/filter.js';
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
  const file = `${OUT}teacher-suggest-kv-${action}.json`;
  writeFileSync(file, JSON.stringify(entries));
  localKv('bulk', action, file, ...(action === 'delete' ? ['--force'] : []));
}

const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

// ---- Pages -------------------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function openPage(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
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
const lastBlocked = (p) => [...p.msgs].reverse().find((m) => m.t === 'blocked')?.list ?? null;
const visible = (p, sel) => p.page.locator(sel).isVisible();
const text = (p, sel) => p.page.locator(sel).textContent();
const shot = (p, label) => p.page.screenshot({ path: `${OUT}teacher-suggest-${label}-${p.name}.png` }).catch(() => {});
const toastHas = (p, s) => until(async () => (await text(p, '#toasts')).includes(s));

async function hostState(host, pred, timeout = 10_000) {
  return until(() => {
    const s = lastState(host);
    return s && pred(s) ? s : null;
  }, { timeout });
}

async function hostSettings(host, { ai, unknown, credits, words }) {
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  if (ai !== undefined) await host.page.setChecked(await reveal(host.page, '#setAi'), ai);
  if (unknown !== undefined) await host.page.setChecked(await reveal(host.page, '#setUnknown'), unknown);
  if (words !== undefined) await host.page.fill(await reveal(host.page, '#setWords'), words.join('\n'));
  if (credits !== undefined) {
    await host.page.setChecked(await reveal(host.page, '#setCreditsOn'), credits !== null);
    if (credits !== null) await host.page.fill(await reveal(host.page, '#setCredits'), String(credits));
  }
  await host.page.click('#applySettings');
}

/** The teacher's 🔎 Suggest a song: search and return the result rows. */
async function teacherSearch(host, q) {
  if (!(await host.page.locator('#suggestDlg').evaluate((d) => d.open))) await host.page.click('#suggestBtn');
  const n = host.msgs.length;
  await host.page.fill('#tq', q);
  await host.page.press('#tq', 'Enter');
  const got = await until(() => host.msgs.slice(n).find((m) => m.t === 'searchResults' && m.q === q), { timeout: 20_000 });
  if (!got || got.error) throw new Error(`teacher search for ${q} failed: ${JSON.stringify(got)}`);
  await until(async () => (await host.page.locator('#tResults li[data-id]').count()) > 0);
  return host.page.$$eval('#tResults li[data-id]', (els) => els.map((e) => ({
    id: e.dataset.id, title: e.querySelector('.song-title')?.textContent ?? '',
    free: Boolean(e.querySelector('button[data-act="tsuggest"]:not([disabled])')),
  })));
}

/** Click ➕ Suggest on one teacher result; the room's answer. */
async function teacherSuggest(host, id) {
  const n = host.msgs.length;
  await host.page.click(`#tResults li[data-id="${id}"] button[data-act="tsuggest"]`);
  return until(() => host.msgs.slice(n).find((m) => m.t === 'suggested' && m.song === id), { timeout: 30_000 });
}

async function firstFree(host, q, used) {
  const rows = await teacherSearch(host, q);
  const row = rows.find((r) => r.free && !used.has(r.id));
  if (!row) throw new Error(`no free result for ${q}`);
  used.add(row.id);
  return row;
}

async function closeDlg(host) {
  if (await host.page.locator('#suggestDlg').evaluate((d) => d.open)) await host.page.click('#suggestDlg button[value="done"]');
}

/** A raw socket (the host token from the page's own storage, or a student). */
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

/** A made-up explicit song in the LOCAL KV song cache (the room looks it up there first). */
function seedExplicitSong() {
  const trackId = 980_000_000 + Math.floor(Math.random() * 1_000_000);
  const song = {
    id: `it:${trackId}`, title: 'Teacher Pick Explicit Song', artist: 'Teacher Pick Test', album: 'Test', artwork: '',
    durationMs: 1000, explicit: 'explicit', previewUrl: 'https://audio-ssl.itunes.apple.com/test.m4a',
  };
  localKvBulk('put', [{ key: `song:${trackId}`, value: JSON.stringify(song) }]);
  seeded.push(`song:${trackId}`);
  return song.id;
}

// ---- The flow ----------------------------------------------------------------------------------

const savedDefaults = await (await api('/api/teacher/settings')).json();
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false }) });
const pages = [];
const seeded = [];
let rawHost = null;
try {
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const saved = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const { classCode: code, room: roomId } = saved;
  await hostSettings(host, { ai: false, credits: 3, words: [] });
  await hostState(host, (s) => s.settings.startingCredits === 3 && !s.settings.aiCheck);
  check('host: the 🔎 Suggest a song button shows', await visible(host, '#suggestBtn'));
  check('host snapshot names the teacher for picks', lastState(host)?.teacherName === 'Teacher 1');

  rawHost = await rawSocket(roomId, { role: 'host', token: saved.token });
  const link = await rawHost.ask({ t: 'boardLink' }, (m) => m.t === 'boardLink');
  const ava = await openPage('ava', `?code=${code}`);
  const board = await openPage('board', `board/#${roomId}.${link.token}`);
  pages.push(ava, board);
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');
  await hostState(host, (s) => s.students.some((x) => x.nick === 'Ava' && x.online));
  const used = new Set();

  // 1. Search and suggest a clean song: "🍎 Teacher 1" everywhere; no credit, no student.
  const clean = await firstFree(host, 'Lovely Day Bill Withers', used);
  const ok1 = await teacherSuggest(host, clean.id);
  check('teacher pick: joins the queue', ok1?.ok === true, JSON.stringify(ok1));
  const s1 = await hostState(host, (s) => s.queue.some((x) => x.song.id === clean.id));
  const item1 = s1?.queue.find((x) => x.song.id === clean.id);
  check('teacher pick: by Teacher 1, teacher: true, mine on the host', item1?.by === 'Teacher 1' && item1.teacher === true && item1.mine === true, JSON.stringify(item1));
  check('host queue shows 🍎 Teacher 1', Boolean(await until(async () => (await text(host, `#queue li[data-id="${item1.id}"]`)).includes('🍎 Teacher 1'))));
  check('host toast: joined the queue as 🍎 Teacher 1', Boolean(await toastHas(host, 'joined the queue as 🍎 Teacher 1')));
  check('the result now says In the queue', Boolean(await until(async () => (await text(host, `#tResults li[data-id="${clean.id}"]`)).includes('In the queue'))));
  check('student page shows "by 🍎 Teacher 1"', Boolean(await until(async () => (await text(ava, `#queue li[data-id="${item1.id}"]`).catch(() => '')).includes('🍎 Teacher 1'))));
  check('board shows "by 🍎 Teacher 1"', Boolean(await until(async () => (await text(board, '#queue').catch(() => '')).includes('🍎 Teacher 1'), { timeout: 15_000 })));
  const sNoTeacher = lastState(host);
  check('the teacher is not a student and has no credits', !sNoTeacher.students.some((x) => /teacher/i.test(x.device) || x.nick === 'Teacher 1')
    && sNoTeacher.students.length === 1);
  check('the student page: the teacher pick is not "mine"', lastState(ava)?.queue.find((x) => x.id === item1.id)?.mine === false);

  // 2. Suggestions locked: the teacher can still add (students cannot).
  await closeDlg(host);
  await host.page.click(await reveal(host.page, '#lockBtn'));
  await hostState(host, (s) => s.locked);
  const locked = await firstFree(host, 'Walking on Sunshine Katrina and the Waves', used);
  const ok2 = await teacherSuggest(host, locked.id);
  check('locked: the teacher can still add', ok2?.ok === true, JSON.stringify(ok2));
  await host.page.click('#suggestDlg button[value="done"]');
  await host.page.click(await reveal(host.page, '#lockBtn'));
  await hostState(host, (s) => !s.locked);

  // 3. A blocked word: refused with the reason, the teacher sees the word; Blocked today tagged teacher.
  const birds = await firstFree(host, 'Three Little Birds Bob Marley', used);
  await closeDlg(host);
  await hostSettings(host, { words: ['birds'] });
  await hostState(host, (s) => s.settings.blocklist.includes('birds'));
  await host.page.click('#suggestBtn'); // the old results are still in the dialog
  const bw = await teacherSuggest(host, birds.id);
  check('blocked word: refused, why blocked_word, the word in detail for the teacher', bw?.reason === 'blocklist' && bw.why?.id === 'blocked_word'
    && /birds/.test(bw.detail ?? ''), JSON.stringify(bw));
  check('blocked word: the toast says why with the word', Boolean(await toastHas(host, 'Blocked word: "birds"')), await text(host, '#toasts'));
  check('blocked word: the result says Not allowed with Why?', Boolean(await until(async () => (await text(host, `#tResults li[data-id="${birds.id}"]`)).includes('Not allowed')))
    && (await host.page.locator(`#tResults li[data-id="${birds.id}"] button[data-act="twhy"]`).count()) === 1);
  const bl = await until(() => lastBlocked(host)?.find((b) => b.song.id === birds.id));
  check('Blocked today: the teacher pick is tagged teacher, by Teacher 1, can be allowed', bl?.teacher === true && bl.by === 'Teacher 1' && bl.canAllow === true, JSON.stringify(bl));
  check('students never get the teacher\'s refusal or the word', !JSON.stringify(ava.msgs).includes('"birds"'));
  await closeDlg(host);
  await hostSettings(host, { words: [] });
  await hostState(host, (s) => s.settings.blocklist.length === 0);

  // 4. An explicit song (no search shows one): the same filter as students.
  const explicitId = seedExplicitSong();
  const ex = await rawHost.ask({ t: 'suggest', song: explicitId }, (m) => m.t === 'suggested' && m.song === explicitId);
  check('explicit: refused for the teacher too', ex?.reason === 'explicit' && ex.why?.id === 'explicit', JSON.stringify(ex));

  // 5. An unknown song (seeded UNKNOWN verdict, no lyrics lookup) waits in the teacher's own Needs a look.
  const unknown = await firstFree(host, 'Dancing Queen ABBA', used);
  {
    const approvals = [approvedKey(unknown.id)];
    try {
      localKvBulk('delete', approvals); // a teacher yes left from an earlier run
    } catch {
      // wrangler's local KV sometimes fails a delete; nothing to clear then
    }
    seeded.push(verdictKey(unknown.id), ...approvals);
    localKvBulk('put', [{ key: verdictKey(unknown.id), value: JSON.stringify({ verdict: 'unknown', category: 'other', evidence: 'teacher pick test', ...NO_LYRICS }) }]);
  }
  await closeDlg(host);
  await hostSettings(host, { ai: true, unknown: true });
  await hostState(host, (s) => s.settings.aiCheck && s.settings.blockUnknownSongs);
  await host.page.click('#suggestBtn');
  const un = await teacherSuggest(host, unknown.id);
  check('unknown: waits in Needs a look', un?.reason === 'review' && un.why?.id === 'unknown', JSON.stringify(un));
  const sR = await hostState(host, (s) => s.review.some((x) => x.song.id === unknown.id));
  check('Needs a look: the teacher pick, as 🍎 Teacher 1', sR?.review.find((x) => x.song.id === unknown.id)?.teacher === true
    && Boolean(await until(async () => (await text(host, '#review')).includes('🍎 Teacher 1'))));
  check('the result now says Needs a look', Boolean(await until(async () => (await text(host, `#tResults li[data-id="${unknown.id}"]`)).includes('Needs a look'))));
  await closeDlg(host);
  await hostSettings(host, { ai: false });
  await hostState(host, (s) => !s.settings.aiCheck);
  const reviewId = lastState(host).review.find((x) => x.song.id === unknown.id).id;
  await host.page.click(`#review li[data-id="${reviewId}"] button[data-act="veto"]`);
  await hostState(host, (s) => !s.review.length);

  // 6. Credits on: the teacher was never charged (Ava still has 3).
  check('credits: the student still has 3, the teacher has no balance', lastState(ava)?.you?.credits === 3
    && !lastState(host).students.some((x) => x.device.includes(':')));

  // 7. The teacher's votes: one vote, take back, never merged with a student.
  const avaSearch = async (q) => {
    await ava.page.fill('#q', q);
    await ava.page.press('#q', 'Enter');
    await until(async () => (await ava.page.locator('#results li[data-id] button[data-act="suggest"]:not([disabled])').count()) > 0, { timeout: 20_000 });
    return ava.page.$$eval('#results li[data-id]', (els) => els.filter((e) => e.querySelector('button[data-act="suggest"]:not([disabled])')).map((e) => e.dataset.id));
  };
  const avaPick = (await avaSearch('Here Comes the Sun Beatles')).find((id) => !used.has(id));
  used.add(avaPick);
  await ava.page.click(`#results li[data-id="${avaPick}"] button[data-act="suggest"]`);
  const sA = await hostState(host, (s) => s.queue.some((x) => x.song.id === avaPick), 30_000);
  const avaItem = sA.queue.find((x) => x.song.id === avaPick);
  await host.page.click(`#queue li[data-id="${avaItem.id}"] button[data-act="up"]`);
  const v1 = await hostState(host, (s) => s.queue.find((x) => x.id === avaItem.id)?.up === 1);
  check('teacher 👍: count +1, myVote 1, pressed', v1?.queue.find((x) => x.id === avaItem.id).myVote === 1
    && Boolean(await until(async () => (await host.page.getAttribute(`#queue li[data-id="${avaItem.id}"] button[data-act="up"]`, 'aria-pressed')) === 'true')));
  await new Promise((r) => setTimeout(r, 500));
  check('teacher 👍: once (still 1)', lastState(host).queue.find((x) => x.id === avaItem.id).up === 1);
  await host.page.click(`#queue li[data-id="${avaItem.id}"] button[data-act="up"]`);
  check('teacher 👍 again: taken back', Boolean(await hostState(host, (s) => s.queue.find((x) => x.id === avaItem.id)?.up === 0)));
  await host.page.click(`#queue li[data-id="${avaItem.id}"] button[data-act="up"]`);
  await hostState(host, (s) => s.queue.find((x) => x.id === avaItem.id)?.up === 1);
  await ava.page.click(`#queue li[data-id="${avaItem.id}"] button[data-act="up"]`);
  check('a student 👍 adds to the teacher\'s: 2', Boolean(await hostState(host, (s) => s.queue.find((x) => x.id === avaItem.id)?.up === 2)));
  check('the student page: the teacher\'s vote is not Ava\'s', Boolean(await until(() => lastState(ava)?.queue.find((x) => x.id === avaItem.id)?.myVote === 1)));

  // 8. The song playing: the teacher's 👍 counts; a 👎 is refused.
  const top = lastState(host).queue[0];
  await rawHost.ask({ t: 'next', from: null }, (m) => m.t === 'state' && m.state.nowPlaying);
  const playing = await hostState(host, (s) => s.nowPlaying?.id === top.id);
  check('a song plays (the best-voted one)', Boolean(playing), JSON.stringify(lastState(host)?.nowPlaying?.song?.title));
  const upBefore = lastState(host).nowPlaying.up;
  const mineBefore = lastState(host).nowPlaying.myVote;
  if (mineBefore === 1) {
    await host.page.click('#nowUpBtn');
    await hostState(host, (s) => s.nowPlaying.myVote === 0);
  }
  const base = lastState(host).nowPlaying.up;
  await host.page.click('#nowUpBtn');
  check('teacher 👍 on the song playing: +1', Boolean(await hostState(host, (s) => s.nowPlaying.up === base + 1 && s.nowPlaying.myVote === 1)), `${upBefore} ${base}`);
  check('the 👍 button shows pressed', Boolean(await until(async () => (await host.page.getAttribute('#nowUpBtn', 'aria-pressed')) === 'true')));
  const down = await rawHost.ask({ t: 'vote', id: top.id, v: -1 }, (m) => m.t === 'error');
  check('teacher 👎 on the song playing: refused (playing_down)', down?.error === 'playing_down', JSON.stringify(down));
  check('the board has no vote buttons', (await board.page.locator('#queue button, #nowPlaying button').count()) === 0);
  await host.page.click(await reveal(host.page, '#bigBtn'));
  check('big screen: no 🔎 Suggest a song, no teacher vote buttons', !(await visible(host, '#suggestBtn')) && !(await visible(host, '#nowUpBtn'))
    && ((await host.page.locator('#queue button[data-act="up"]').count()) === 0 || !(await host.page.locator('#queue button[data-act="up"]').first().isVisible())));
  await host.page.click(await reveal(host.page, '#bigBtn'));

  // 9. The recap: the teacher is never Top contributor, Top voter or Crowd favorite.
  await rawHost.ask({ t: 'next', from: top.id }, (m) => m.t === 'state');
  await rawHost.ask({ t: 'next', from: lastState(host).nowPlaying?.id ?? null }, (m) => m.t === 'state');
  const recap = (await rawHost.ask({ t: 'recap' }, (m) => m.t === 'recap'))?.recap;
  const versus = recap?.stats?.find((x) => x.id === 'versus');
  check('recap: Top contributor and Top voter are Ava, never the teacher', versus?.contributor?.nick === 'Ava' && versus?.voter?.nick === 'Ava', JSON.stringify(versus));
  check('recap: Crowd favorite is never the teacher', recap?.crowdFavorite?.nick !== 'Teacher 1', JSON.stringify(recap?.crowdFavorite));
  check('recap: the songs list shows the teacher\'s pick (teacher: true)', recap?.songs.some((x) => x.teacher === true && x.by === 'Teacher 1'), JSON.stringify(recap?.songs?.map((x) => x.by)));

  // 10. The A key opens 🔎 Suggest a song; Favorites dialog has ➕ Suggest.
  await host.page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await host.page.keyboard.press('a');
  check('A opens 🔎 Suggest a song with the search box focused', Boolean(await until(() => host.page.locator('#suggestDlg').evaluate((d) => d.open)))
    && (await host.page.evaluate(() => document.activeElement?.id)) === 'tq');
  await closeDlg(host);
  await host.page.click(await reveal(host.page, '#favBtn'));
  await until(() => host.msgs.some((m) => m.t === 'favoritesAll'));
  const favs = [...host.msgs].reverse().find((m) => m.t === 'favoritesAll')?.list ?? [];
  check('⭐ Favorites: every song has ➕ Suggest (or why it cannot)', favs.length === 0 || Boolean(await until(async () => (await host.page.locator('#favList li[data-id] [data-act="fsuggest"]').count()) === favs.length)), String(favs.length));
  await host.page.click('#favDlg button[value="done"]');

  await host.page.click(await reveal(host.page, '#closeBtn'));
  await host.page.click('#confirm button[value="ok"]');
  check('close: the room is gone', Boolean(await until(() => visible(host, '#closedScreen'))));
  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL teacher-suggest stopped: ${e?.stack ?? e}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  rawHost?.ws.close();
  const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) });
  if (!r.ok) console.log('FAIL could not put the saved teacher settings back');
  try {
    if (seeded.length) localKvBulk('delete', seeded);
  } catch (e) {
    console.log(`FAIL could not clean the seeded local KV keys: ${e.message}`);
  }
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
