// Browser test of student credits (shared/protocol.js CREDITS): one host page and two student pages
// in installed Chrome (playwright-core), plus a plain WebSocket as a third student, against a LOCAL
// wrangler dev only.
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:credits              (or: node test/browser/credits.mjs http://127.0.0.1:8792/)
// A dev server started with --persist-to <dir>: set CQ_PERSIST=<dir> so the KV seeding reaches it.
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// playwright-core: this repo's node_modules if present, else PLAYWRIGHT_CORE, else the copy in
// ../uploadmycut/node_modules.
// No Workers AI call: the AI check is on only while two songs are suggested whose verdicts this
// test seeds into the LOCAL KV first (one INAPPROPRIATE, one UNKNOWN), like flows.mjs; it deletes
// them at the end. It saves "Starting credits" as the teacher's default once, then puts the saved
// settings back. Searches hit the real iTunes API through the host page.
// Covers: Starting credits 2; a suggestion costs 1; a filter "no" refunds; Needs a look holds the
// credit and Remove refunds it; a jump with too few credits is refused (page and server); the
// teacher gives 5, the jump works and that song plays next; Give everyone; Set to; a new starting
// amount is for students who join later; turning Credits off turns it all off. Priority jump (off by
// default): no Jump buttons and a forced jump refused ('off', nothing spent) while it is off;
// turning it on shows them; turning it off mid-room keeps the jumped song's place and tag.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_LYRICS, approvedKey, banKey, verdictKey } from '../../shared/filter.js';
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
  const file = `${OUT}credits-kv-${action}.json`;
  writeFileSync(file, JSON.stringify(entries));
  localKv('bulk', action, file, ...(action === 'delete' ? ['--force'] : []));
}

const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

// ---- Pages -------------------------------------------------------------------------------------

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=document-user-activation-required'],
});

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
const visible = (p, sel) => p.page.locator(sel).isVisible();
const text = (p, sel) => p.page.locator(sel).textContent();
const shot = (p, label) => p.page.screenshot({ path: `${OUT}credits-${label}-${p.name}.png` }).catch(() => {});

async function joinStudent(p, code, nick) {
  await p.page.fill('#code', code);
  await p.page.fill('#nick', nick);
  await p.page.click('#joinBtn');
  await p.page.waitForSelector('#roomScreen:not([hidden])');
}

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

async function suggest(p, songId) {
  const n = p.msgs.length;
  await p.page.click(`#results li[data-id="${songId}"] button[data-act="suggest"]`);
  return until(() => p.msgs.slice(n).find((m) => m.t === 'suggested' && m.song === songId), { timeout: 30_000 });
}

async function suggestFound(p, q, songId) {
  const ids = await search(p, q);
  if (!ids.includes(songId)) throw new Error(`${songId} not in the page's results for ${q}`);
  return suggest(p, songId);
}

async function searchAndSuggest(p, q, used) {
  const ids = await search(p, q);
  const songId = ids.find((id) => !used.has(id));
  if (!songId) throw new Error(`no new result for ${q}`);
  used.add(songId);
  return { songId, msg: await suggest(p, songId) };
}

async function apiJoin(code, device) {
  const r = await fetch(new URL('api/join', BASE), {
    method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  return [r.status, await r.json().catch(() => ({}))];
}

const found = new Map();
async function firstNew(roomId, q, used, device) {
  const r = await fetch(new URL(`api/rooms/${roomId}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': device } });
  const song = (await r.json()).results?.find((s) => !used.has(s.id));
  if (!song) throw new Error(`no new search result for ${q}`);
  used.add(song.id);
  found.set(song.id, song);
  return song.id;
}

async function hostState(host, pred, timeout = 10_000) {
  return until(() => {
    const s = lastState(host);
    return s && pred(s) ? s : null;
  }, { timeout });
}

async function hostSettings(host, { ai, unknown, credits, max, jump }, button = '#applySettings') {
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  if (max !== undefined) await host.page.fill(await reveal(host.page, '#setMax'), String(max));
  if (ai !== undefined) await host.page.setChecked(await reveal(host.page, '#setAi'), ai);
  if (unknown !== undefined) await host.page.setChecked(await reveal(host.page, '#setUnknown'), unknown);
  if (credits !== undefined) {
    await host.page.setChecked(await reveal(host.page, '#setCreditsOn'), credits !== null);
    if (credits !== null) await host.page.fill(await reveal(host.page, '#setCredits'), String(credits));
  }
  if (jump !== undefined) await host.page.setChecked(await reveal(host.page, '#setJump'), jump);
  await host.page.click(button);
}

/** A student that is only a WebSocket (to send what a page never would). */
async function rawStudent(roomId, device, nick) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}api/rooms/${roomId}/ws?${new URLSearchParams({ role: 'student', device, nick })}`);
  const s = { ws, msgs: [] };
  ws.addEventListener('message', (e) => { try { s.msgs.push(JSON.parse(e.data)); } catch { /* not JSON */ } });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  s.ask = async (msg, pred) => {
    const n = s.msgs.length;
    ws.send(JSON.stringify(msg));
    return until(() => s.msgs.slice(n).find(pred));
  };
  return s;
}

const myCredits = (p) => lastState(p)?.you?.credits;
const studentCredits = (host, nick) => lastState(host)?.students?.find((x) => x.nick === nick)?.credits;

// ---- The flow ----------------------------------------------------------------------------------

const savedDefaults = await (await api('/api/teacher/settings')).json();
// Songs replay across runs and rooms: no repeat cooldown while this test runs (the saved
// defaults, cooldown included, go back at the end).
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false }) });
const pages = [];
let seeded = [];
let raw = null;
try {
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { classCode: code, room: roomId } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  await hostState(host, () => true);
  check('credits and Priority jump are off in a new room by default', lastState(host).settings.startingCredits === null
    && lastState(host).settings.allowJump === false, JSON.stringify(lastState(host).settings));

  // Settings: the Credits switch is off, no number box, Priority jump greyed out with a note.
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  await reveal(host.page, '#setJump'); // the Credits tab, All settings (Priority jump is an advanced row)
  check('settings: Credits switch off, no Starting credits box', !(await host.page.isChecked('#setCreditsOn'))
    && !(await visible(host, '#setCredits')) && (await host.page.getAttribute('#setCreditsOn', 'role')) === 'switch');
  check('settings: Priority jump is off and greyed out, with "Turn credits on first."', !(await host.page.isChecked('#setJump'))
    && (await host.page.isDisabled('#setJump')) && (await visible(host, '#jumpOffNote')) && (await text(host, '#jumpOffNote')).includes('Turn credits on first.'));
  await host.page.click(await reveal(host.page, '#setCreditsOn'));
  check('settings: switching Credits on shows Starting credits 3 and lets Priority jump be used', (await visible(host, '#setCredits'))
    && (await host.page.inputValue('#setCredits')) === '3' && !(await host.page.isDisabled('#setJump')) && !(await visible(host, '#jumpOffNote')));
  check('settings: the help says turning jump off keeps jumped songs in place', /does not move songs already jumped; they keep their place/.test(await text(host, '#jumpHelp')));
  await host.page.click('#cancelSettings');

  // Settings: Starting credits 2 (Credits on, Priority jump still off), no AI, room for several songs each.
  await hostSettings(host, { ai: false, max: 5, credits: 2 });
  check('settings: Starting credits 2 reaches the room', Boolean(await hostState(host, (s) => s.settings.startingCredits === 2 && !s.settings.aiCheck)));

  // Ava joins with 2 credits.
  const ava = await openPage('ava', `?code=${code}`);
  pages.push(ava);
  await joinStudent(ava, code, 'Ava');
  check('student: the credits pill shows 2 credits', Boolean(await until(async () => (await visible(ava, '#credits')) && (await text(ava, '#creditsN')) === '2 credits')));
  const used = new Set();
  const ids1 = await search(ava, 'Here Comes the Sun Beatles');
  const firstId = ids1.find((id) => !used.has(id));
  check('student: Suggest says it costs a credit', /Suggest · 1/.test(await text(ava, `#results li[data-id="${firstId}"] button`))
    && /Suggest for 1 credit/.test(await ava.page.getAttribute(`#results li[data-id="${firstId}"] button`, 'aria-label')));
  used.add(firstId);
  const s1 = await suggest(ava, firstId);
  check('suggest: the song joins the queue', s1?.ok === true, JSON.stringify(s1));
  check('suggest: it cost 1 (2 → 1), on the page and for the host', Boolean(await until(() => myCredits(ava) === 1))
    && Boolean(await until(async () => (await text(ava, '#creditsN')) === '1 credit')) && Boolean(await until(() => studentCredits(host, 'Ava') === 1)));

  // A filter "no" (AI theme, seeded verdict) refunds; Needs a look holds the credit and Remove refunds.
  const probe = 'credits-test-device-0001';
  await apiJoin(code, probe);
  const themeId = await firstNew(roomId, 'Lean on Me Bill Withers', used, probe);
  const reviewId = await firstNew(roomId, 'Three Little Birds Bob Marley', used, probe);
  seeded = [themeId, reviewId];
  const approvals = seeded.flatMap((t) => [approvedKey(t), approvedKey(banKey(found.get(t)))]);
  localKvBulk('delete', approvals);
  localKvBulk('put', [
    { key: verdictKey(themeId), value: JSON.stringify({ verdict: 'inappropriate', reason: 'credits test' }) },
    { key: verdictKey(reviewId), value: JSON.stringify({ verdict: 'unknown', reason: 'credits test', ...NO_LYRICS }) },
  ]);
  await hostSettings(host, { ai: true, unknown: true });
  await hostState(host, (s) => s.settings.aiCheck && s.settings.blockUnknownSongs);
  const blocked = await suggestFound(ava, 'Lean on Me Bill Withers', themeId);
  check('refund: a song the filter says no to comes back with refunded: true', blocked?.ok === false && blocked.reason === 'theme' && blocked.refunded === true, JSON.stringify(blocked));
  check('refund: the student is told "Your credit came back."', Boolean(await until(async () => (await text(ava, '#toasts')).includes('Your credit came back.'))));
  check('refund: still 1 credit', myCredits(ava) === 1 && (await text(ava, '#creditsN')) === '1 credit', String(myCredits(ava)));
  const held = await suggestFound(ava, 'Three Little Birds Bob Marley', reviewId);
  check('review: an unknown song waits for the teacher', held?.reason === 'review', JSON.stringify(held));
  check('review: its credit is held (1 → 0)', Boolean(await until(() => myCredits(ava) === 0)));
  const noneLeft = await search(ava, 'Dancing Queen ABBA');
  const noneId = noneLeft.find((id) => !used.has(id));
  check('no credits: a result says "No credits" instead of Suggest', Boolean(await until(async () => (await text(ava, `#results li[data-id="${noneId}"] button`)) === 'No credits'))
    && (await ava.page.isDisabled(`#results li[data-id="${noneId}"] button`)));
  const reviewItem = (await hostState(host, (s) => s.review?.length === 1)).review[0];
  await host.page.click(`#review li[data-id="${reviewItem.id}"] button[data-act="veto"]`);
  check('review: Remove gives the credit back (0 → 1), and the student hears it', Boolean(await until(() => myCredits(ava) === 1))
    && Boolean(await until(async () => /said no to .* this time\..* Try a different song! Your credit came back\./.test(await text(ava, '#toasts')))));
  await hostSettings(host, { ai: false });
  await hostState(host, (s) => !s.settings.aiCheck);

  // Ben joins (2 credits) and suggests; his song leads on votes.
  const ben = await openPage('ben', `?code=${code}`);
  pages.push(ben);
  await joinStudent(ben, code, 'Ben');
  const b1 = await searchAndSuggest(ben, 'Uptown Funk Bruno Mars', used);
  check('Ben: suggestion joins, 2 → 1', b1.msg?.ok === true && Boolean(await until(() => myCredits(ben) === 1)), JSON.stringify(b1.msg));
  const sQueue = await hostState(host, (s) => s.queue.length === 2);
  const avaItem = sQueue.queue.find((q) => q.song.id === firstId);
  const benItem = sQueue.queue.find((q) => q.song.id === b1.songId);
  await ben.page.click(`#queue li[data-id="${benItem.id}"] button[data-act="up"]`);
  check('votes: Ben\'s song is first', Boolean(await hostState(host, (s) => s.queue[0]?.id === benItem.id)));

  // Priority jump is off: no Jump buttons, and the server refuses a forced jump without charging.
  check('jump off: no Jump buttons and no Jump line under the credits', (await ava.page.locator('#queue .jump:visible').count()) === 0
    && (await ava.page.locator('#queue li').count()) === 2 && !(await visible(ava, '#creditsJump')));
  raw = await rawStudent(roomId, probe, 'Probe');
  await hostState(host, (s) => s.students.some((x) => x.nick === 'Probe'));
  const probeBefore = studentCredits(host, 'Probe');
  const offForced = await raw.ask({ t: 'jump', id: benItem.id }, (m) => m.t === 'jumped');
  check('jump off: the server refuses a forced jump (reason off, friendly message)', offForced?.ok === false && offForced.reason === 'off'
    && offForced.message === 'Your teacher turned off jumping.', JSON.stringify(offForced));
  check('jump off: ... and charges nothing, the song is not jumped', Number.isInteger(probeBefore) && studentCredits(host, 'Probe') === probeBefore
    && !lastState(host).queue.some((q) => q.jumped), String(probeBefore));
  await hostSettings(host, { jump: true });
  check('jump on: the setting reaches the room', Boolean(await hostState(host, (s) => s.settings.allowJump === true)));

  // Jump with too few credits: the page says why, and the server refuses a forced one.
  check('jump on: every waiting song has a Jump (2) button', Boolean(await until(async () => (await ava.page.locator('#queue .jump:visible').count()) === 2))
    && (await text(ava, `#queue li[data-id="${avaItem.id}"] .jump`)) === '⚡ Jump (2)');
  check('jump: with 1 credit the button says why it will not work', (await ava.page.getAttribute(`#queue li[data-id="${avaItem.id}"] .jump`, 'aria-disabled')) === 'true'
    && /You need 2 credits to jump a song/.test(await ava.page.getAttribute(`#queue li[data-id="${avaItem.id}"] .jump`, 'aria-label')));
  const sentBefore = ava.msgs.length;
  // aria-disabled (not disabled): a real click still reaches the page, which says why.
  await ava.page.click(`#queue li[data-id="${avaItem.id}"] .jump`, { force: true });
  check('jump: a click with too few credits shows the friendly refusal', Boolean(await until(async () => (await text(ava, '#toasts')).includes('You need 2 credits to jump a song. Ask your teacher for more.'))));
  check('jump: ... and spends nothing', myCredits(ava) === 1 && !ava.msgs.slice(sentBefore).some((m) => m.t === 'jumped'));
  // The teacher sets Probe to 1 credit (Students → More… → Set to this).
  await host.page.click(await reveal(host.page, '#studentsBtn'));
  await host.page.waitForSelector('#studentsDlg[open]');
  check('students: credits and give buttons show while credits are on', await visible(host, '#creditsBar')
    && (await host.page.locator('#students .student-credits button').count()) >= 9);
  const probeDevice = probe;
  await host.page.click(`#students li[data-id="${probeDevice}"] button[data-act="credits"]`);
  await host.page.waitForSelector('#creditDlg[open]');
  await host.page.fill('#creditN', '1');
  await host.page.click('#creditSet');
  check('set to: Probe now has 1 credit', Boolean(await until(() => studentCredits(host, 'Probe') === 1)));
  check('set to: the Students list is back', Boolean(await until(() => host.page.locator('#studentsDlg[open]').count())));
  check('set to: the student is told', Boolean(await until(() => raw.msgs.some((m) => m.t === 'credits' && m.why === 'set' && m.credits === 1))));
  const forced = await raw.ask({ t: 'jump', id: avaItem.id }, (m) => m.t === 'jumped');
  check('server: a jump with too few credits is refused (reason credits), nothing spent', forced?.ok === false && forced.reason === 'credits'
    && forced.message === 'You need 2 credits to jump a song. Ask your teacher for more.' && studentCredits(host, 'Probe') === 1, JSON.stringify(forced));
  const grant = await raw.ask({ t: 'credits', device: probe, amount: 50 }, (m) => m.t === 'error');
  check('server: a student cannot give credits (host message refused)', grant?.error === 'bad_message' && studentCredits(host, 'Probe') === 1, JSON.stringify(grant));

  // The teacher gives Ava 5; she jumps her song, and it plays next.
  await host.page.click(`#students li[data-id="${lastState(host).students.find((x) => x.nick === 'Ava').device}"] button[data-act="give5"]`);
  check('give: Ava gets 5 (1 → 6) and is told', Boolean(await until(() => myCredits(ava) === 6))
    && Boolean(await until(async () => (await text(ava, '#toasts')).includes('Your teacher gave you 5 credits!'))));
  await host.page.click('#studentsDlg button[value="done"]');
  await until(async () => (await ava.page.getAttribute(`#queue li[data-id="${avaItem.id}"] .jump`, 'aria-disabled')) === 'false');
  const jumpN = ava.msgs.length;
  await ava.page.click(`#queue li[data-id="${avaItem.id}"] .jump`);
  const jumped = await until(() => ava.msgs.slice(jumpN).find((m) => m.t === 'jumped'));
  check('jump: works and costs 2 (6 → 4)', jumped?.ok === true && Boolean(await until(() => myCredits(ava) === 4)), JSON.stringify(jumped));
  const sJumped = await hostState(host, (s) => s.queue[0]?.id === avaItem.id);
  check('jump: the jumped song is first, ahead of the song with more votes', Boolean(sJumped) && sJumped.queue[0].jumped?.by === 'Ava' && sJumped.queue[1].id === benItem.id);
  check('jump: the host shows "⚡ Jumped by Ava"', Boolean(await until(async () => (await text(host, `#queue li[data-id="${avaItem.id}"]`)).includes('⚡ Jumped by Ava'))));
  check('jump: students see the tag, and the button says Jumped', Boolean(await until(async () => (await text(ben, `#queue li[data-id="${avaItem.id}"] .jtag`)).includes('Jumped by Ava')))
    && (await text(ben, `#queue li[data-id="${avaItem.id}"] .jump`)) === '⚡ Jumped');
  const twice = await raw.ask({ t: 'jump', id: avaItem.id }, (m) => m.t === 'jumped');
  check('server: a song that is already jumped is refused without charging', twice?.reason === 'jumped' && studentCredits(host, 'Probe') === 1, JSON.stringify(twice));

  // Priority jump off mid-room: Jump buttons go, the jumped song keeps its place and its tag.
  await hostSettings(host, { jump: false });
  await hostState(host, (s) => s.settings.allowJump === false);
  check('jump off mid-room: the Jump buttons hide', Boolean(await until(async () => (await ava.page.locator('#queue .jump:visible').count()) === 0)));
  check('jump off mid-room: the jumped song stays first and keeps "Jumped by Ava" (host and students)', lastState(host).queue[0]?.id === avaItem.id
    && (await text(host, `#queue li[data-id="${avaItem.id}"]`)).includes('⚡ Jumped by Ava')
    && (await text(ben, `#queue li[data-id="${avaItem.id}"] .jtag`)).includes('Jumped by Ava'));
  const midOff = await raw.ask({ t: 'jump', id: benItem.id }, (m) => m.t === 'jumped');
  check('jump off mid-room: the server refuses (off)', midOff?.reason === 'off' && studentCredits(host, 'Probe') === 1, JSON.stringify(midOff));
  await hostSettings(host, { jump: true });
  check('jump on again: the Jump buttons come back', Boolean(await until(async () => (await ava.page.locator('#queue .jump:visible').count()) === 2)));
  await host.page.click('#startBtn');
  const playing = await hostState(host, (s) => s.nowPlaying);
  check('jump: the jumped song plays next', playing?.nowPlaying.id === avaItem.id, JSON.stringify(playing?.nowPlaying?.song?.title));
  const onPlaying = await raw.ask({ t: 'jump', id: avaItem.id }, (m) => m.t === 'jumped');
  check('server: the song playing cannot be jumped', onPlaying?.reason === 'playing', JSON.stringify(onPlaying));

  // Give everyone 3.
  await host.page.click(await reveal(host.page, '#studentsBtn'));
  await host.page.waitForSelector('#studentsDlg[open]');
  await host.page.fill('#giveAllN', '3');
  await host.page.click('#giveAllBtn');
  check('give everyone: Ava 4 → 7, Ben 1 → 4, Probe 1 → 4', Boolean(await hostState(host, (s) => ['Ava:7', 'Ben:4', 'Probe:4']
    .every((pair) => s.students.some((x) => `${x.nick}:${x.credits}` === pair)))), JSON.stringify(lastState(host).students.map((x) => [x.nick, x.credits])));
  check('give everyone: students are told', Boolean(await until(async () => (await text(ben, '#toasts')).includes('Your teacher gave you 3 credits!'))));
  check('give everyone: the Students list shows the new balances', Boolean(await until(async () => (await text(host, '#students')).includes('🎟 7'))));
  await host.page.click('#studentsDlg button[value="done"]');

  // A new starting amount is for students who join later; Save as my default keeps it.
  await hostSettings(host, { credits: 10 }, '#saveDefault');
  const reached = Boolean(await hostState(host, (s) => s.settings.startingCredits === 10));
  const savedNow = await (await api('/api/teacher/settings')).json();
  check('settings: starting credits 10 and Priority jump on (saved as the default too)', reached
    && savedNow.startingCredits === 10 && savedNow.allowJump === true, JSON.stringify(savedNow));
  check('settings: students already in keep their balance', studentCredits(host, 'Ava') === 7 && studentCredits(host, 'Ben') === 4);
  const cy = await openPage('cy', `?code=${code}`);
  pages.push(cy);
  await joinStudent(cy, code, 'Cy');
  check('settings: a student who joins later starts with 10', Boolean(await until(() => myCredits(cy) === 10)));

  // Rejoin on the same device keeps the balance.
  await ben.page.reload();
  check('rejoin: Ben keeps 4 credits after a refresh', Boolean(await until(async () => (await visible(ben, '#roomScreen')) && (await text(ben, '#creditsN')) === '4 credits')));

  // Credits switch off: credits off for everyone.
  await hostSettings(host, { credits: null });
  await hostState(host, (s) => s.settings.startingCredits === null);
  check('unlimited: the pill and the Jump buttons hide, Suggest is free', Boolean(await until(async () => !(await visible(ava, '#credits'))))
    && (await ava.page.locator('#queue .jump:visible').count()) === 0 && myCredits(ava) === null);
  const offJump = await raw.ask({ t: 'jump', id: benItem.id }, (m) => m.t === 'jumped');
  check('unlimited: the server refuses a jump (off)', offJump?.reason === 'off', JSON.stringify(offJump));
  await host.page.click(await reveal(host.page, '#studentsBtn'));
  check('unlimited: Students says credits are off, no give buttons', Boolean(await until(() => visible(host, '#creditsOff')))
    && !(await visible(host, '#creditsBar')) && (await host.page.locator('#students .student-credits button').count()) === 0);
  await host.page.click('#studentsDlg button[value="done"]');

  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
  await host.page.click(await reveal(host.page, '#closeBtn'));
  await host.page.waitForSelector('#confirm[open]');
  await host.page.click('#confirm button[value="ok"]');
  await until(() => visible(host, '#closedScreen'));
} catch (e) {
  failures++;
  console.log(`FAIL credits stopped: ${e?.stack ?? e}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  raw?.ws.close();
  const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) });
  if (!r.ok) console.log('FAIL could not put the saved teacher settings back');
  try {
    if (seeded.length) {
      localKvBulk('delete', [...seeded.map(verdictKey), ...seeded.flatMap((t) => [approvedKey(t), ...(found.has(t) ? [approvedKey(banKey(found.get(t)))] : [])])]);
    }
  } catch (e) {
    console.log(`FAIL could not clean the seeded local KV keys: ${e.message}`);
  }
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
