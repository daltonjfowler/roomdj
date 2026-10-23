// Browser test of "why was my song turned down" (shared/protocol.js REASONS, BLOCKED): one host
// page, two student pages and a plain WebSocket student in installed Chrome (playwright-core),
// against a LOCAL wrangler dev only.
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:reasons              (or: node test/browser/reasons.mjs http://127.0.0.1:8792/)
// A dev server started with --persist-to <dir>: set CQ_PERSIST=<dir> so the KV seeding reaches it.
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override.
// playwright-core: this repo's node_modules if present, else PLAYWRIGHT_CORE, else the copy in
// ../uploadmycut/node_modules.
// No Workers AI call: while the AI check is on, every suggested song has a verdict seeded into the
// LOCAL KV first (like flows.mjs): one INAPPROPRIATE with category + evidence, one in the old
// format (no category), one UNKNOWN, one OK; and a made-up explicit song in the KV song cache.
// Deleted at the end. Searches hit the real iTunes API (through the host page).
// Covers: a blocked word (students get the reason, never the word; the teacher sees it), an
// explicit song, the AI's category + evidence and an old verdict, "Why?" on a result, Remove in
// Needs a look with a picked reason + note, Veto with a reason + note (a rude note is refused on
// the page), Blocked today (details, Allow anyway charges nothing, Ban).

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
  const file = `${OUT}reasons-kv-${action}.json`;
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
const shot = (p, label) => p.page.screenshot({ path: `${OUT}reasons-${label}-${p.name}.png` }).catch(() => {});
const toastHas = (p, s) => until(async () => (await text(p, '#toasts')).includes(s));

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

async function apiJoin(code, device) {
  const r = await fetch(new URL('api/join', BASE), {
    method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  return [r.status, await r.json().catch(() => ({}))];
}

async function hostState(host, pred, timeout = 10_000) {
  return until(() => {
    const s = lastState(host);
    return s && pred(s) ? s : null;
  }, { timeout });
}

async function hostSettings(host, { ai, unknown, credits, max, words }) {
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  if (max !== undefined) await host.page.fill(await reveal(host.page, '#setMax'), String(max));
  if (ai !== undefined) await host.page.setChecked(await reveal(host.page, '#setAi'), ai);
  if (unknown !== undefined) await host.page.setChecked(await reveal(host.page, '#setUnknown'), unknown);
  if (words !== undefined) await host.page.fill(await reveal(host.page, '#setWords'), words.join('\n'));
  if (credits !== undefined) {
    await host.page.setChecked(await reveal(host.page, '#setCreditsOn'), credits !== null);
    if (credits !== null) await host.page.fill(await reveal(host.page, '#setCredits'), String(credits));
  }
  await host.page.click('#applySettings');
}

/** A student that is only a WebSocket (to suggest a song id no search shows). */
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
    return until(() => s.msgs.slice(n).find(pred), { timeout: 30_000 });
  };
  return s;
}

/**
 * An explicit song for the room to look up: seeded into the LOCAL KV song cache (song:<trackId>,
 * src/itunes.js lookupSong reads it before iTunes), as iTunes answers this computer with clean
 * versions only. A made-up track id, deleted at the end.
 */
function seedExplicitSong() {
  const trackId = 990_000_000 + Math.floor(Math.random() * 1_000_000);
  const song = {
    id: `it:${trackId}`, title: 'Reasons Test Explicit Song', artist: 'Reasons Test', album: 'Test', artwork: '',
    durationMs: 1000, explicit: 'explicit', previewUrl: 'https://audio-ssl.itunes.apple.com/test.m4a',
  };
  localKvBulk('put', [{ key: `song:${trackId}`, value: JSON.stringify(song) }]);
  seeded.push(`song:${trackId}`);
  return song.id;
}

const myCredits = (p) => lastState(p)?.you?.credits;

/** Open the quick-pick (▾) on a row of `list` ('#queue' or '#review'), pick a reason, type a note. */
async function quickPick(host, list, itemId, reason, note) {
  await host.page.click(await reveal(host.page, `${list} li[data-id="${itemId}"] button[data-act="more"]`));
  await host.page.waitForSelector('#reasonDlg[open]');
  await host.page.check(`#reasonPicks input[value="${reason}"]`);
  await host.page.fill('#reasonNote', note);
}

// ---- The flow ----------------------------------------------------------------------------------

const savedDefaults = await (await api('/api/teacher/settings')).json();
// Songs replay across runs and rooms: no repeat cooldown while this test runs (the saved
// defaults, cooldown included, go back at the end).
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false }) });
const pages = [];
let seeded = [];
let raw = null;
let unban = null; // the song this test bans: off the local ban list again at the end
try {
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { classCode: code, room: roomId } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  await hostSettings(host, { ai: false, max: 5, credits: 5, words: [] });
  await hostState(host, (s) => s.settings.startingCredits === 5 && !s.settings.aiCheck);
  check('host: Blocked today starts empty', Boolean(await until(async () => (await text(host, '#blockedCount')) === '(0)')) && lastBlocked(host)?.length === 0);

  const ava = await openPage('ava', `?code=${code}`);
  const ben = await openPage('ben', `?code=${code}`);
  pages.push(ava, ben);
  await joinStudent(ava, code, 'Ava');
  await joinStudent(ben, code, 'Ben');
  await hostState(host, (s) => s.students.filter((x) => x.online).length === 2);
  const used = new Set();

  // 1. A blocked word: the student gets the reason, never the word; the teacher sees the word.
  const lovely = (await search(ava, 'Lovely Day Bill Withers')).find((id) => !used.has(id));
  used.add(lovely);
  await hostSettings(host, { words: ['lovely'] });
  await hostState(host, (s) => s.settings.blocklist.includes('lovely'));
  const bw = await suggest(ava, lovely);
  check('blocked word: refused with why blocked_word and the plain sentence', bw?.reason === 'blocklist' && bw.why?.id === 'blocked_word'
    && bw.why.evidence === 'It has a word your teacher blocked.', JSON.stringify(bw));
  check('blocked word: the word is nowhere in what the student got', !JSON.stringify(ava.msgs).toLowerCase().includes('"lovely"')
    && !JSON.stringify(bw).toLowerCase().includes('lovely'));
  check('blocked word: the toast says why, without the word', Boolean(await toastHas(ava, '📝 Blocked word: It has a word your teacher blocked.'))
    && !(await text(ava, '#toasts')).toLowerCase().includes('lovely'));
  check('blocked word: the credit came back', Boolean(await until(() => myCredits(ava) === 5)), String(myCredits(ava)));
  const whyBtn = `#results li[data-id="${lovely}"] button[data-act="why"]`;
  check('results: the refused song shows "Not allowed" and a Why? button', Boolean(await until(() => visible(ava, whyBtn)))
    && /Not allowed/.test(await text(ava, `#results li[data-id="${lovely}"]`)));
  await ava.page.evaluate(() => document.querySelector('#toasts').replaceChildren());
  await ava.page.click(whyBtn);
  check('results: Why? says the reason again', Boolean(await toastHas(ava, '📝 Blocked word: It has a word your teacher blocked.')));
  const bl1 = await until(() => lastBlocked(host)?.length === 1 && lastBlocked(host));
  check('host: Blocked today has it, with the word for the teacher only', bl1?.[0]?.detail === 'Blocked word: "lovely"' && bl1[0].by === 'Ava'
    && bl1[0].canAllow === true && (await text(host, '#blockedCount')) === '(1)', JSON.stringify(bl1));
  check('students never get the Blocked today list', !ava.msgs.some((m) => m.t === 'blocked') && !('blocked' in (lastState(ava) ?? {})));
  await hostSettings(host, { words: [] });
  await hostState(host, (s) => s.settings.blocklist.length === 0);

  // 2. An explicit song (suggested by id, as no search shows it).
  const explicitId = seedExplicitSong();
  {
    await apiJoin(code, 'reasons-raw-device-0001');
    raw = await rawStudent(roomId, 'reasons-raw-device-0001', 'Cy');
    const ex = await raw.ask({ t: 'suggest', song: explicitId }, (m) => m.t === 'suggested');
    check('explicit: why explicit, "Apple marks this song explicit."', ex?.reason === 'explicit' && ex.why?.id === 'explicit'
      && ex.why.evidence === 'Apple marks this song explicit.', JSON.stringify(ex));
    const bl = await until(() => lastBlocked(host)?.find((b) => b.song.id === explicitId));
    check('explicit: in Blocked today, no Allow anyway and no Ban', bl?.why.id === 'explicit' && !bl.canAllow && !bl.canBan, JSON.stringify(bl));
  }

  // 3. The AI check on, with seeded verdicts: category + evidence, an old verdict, an unknown song, an OK one.
  // Each song is picked from the page's own results, its verdict seeded, then suggested from there.
  const verdicts = {
    drugs: { verdict: 'inappropriate', category: 'drugs', evidence: 'Sings about using crystal meth' },
    legacy: { verdict: 'inappropriate', reason: 'old reason text from before categories' },
    unknown: { verdict: 'unknown', category: 'other', evidence: 'reasons test', ...NO_LYRICS }, // no lyrics lookup: stays unknown
    ok: { verdict: 'ok', category: 'other', evidence: 'reasons test', lyrics: 'found', lv: 1, source: 'lyrics' }, // confirmed (unconfirmedOk)
  };
  const t = {};
  async function pickAndSeed(p, q, kind) {
    await search(p, q);
    const song = await p.page.$$eval('#results li[data-id]', (els) => els.map((e) => ({
      id: e.dataset.id, title: e.querySelector('.song-title')?.textContent ?? '', artist: e.querySelector('.song-artist')?.textContent ?? '',
      free: !e.querySelector('button[data-act="suggest"]')?.disabled,
    }))).then((rows) => rows.find((r) => r.free && !used.has(r.id)));
    if (!song) throw new Error(`no new result on ${p.name}'s page for ${q}`);
    used.add(song.id);
    t[kind] = song.id;
    const approvals = [approvedKey(song.id), approvedKey(banKey(song))];
    localKvBulk('delete', approvals); // a teacher yes left from an earlier run
    seeded.push(verdictKey(song.id), ...approvals);
    localKvBulk('put', [{ key: verdictKey(song.id), value: JSON.stringify(verdicts[kind]) }]);
    return song.id;
  }
  await hostSettings(host, { ai: true, unknown: true });
  await hostState(host, (s) => s.settings.aiCheck && s.settings.blockUnknownSongs);

  const before = myCredits(ava);
  const dr = await suggest(ava, await pickAndSeed(ava, 'Semi-Charmed Life Third Eye Blind', 'drugs'));
  check('AI: why = category + the AI\'s own evidence', dr?.reason === 'theme' && dr.why?.id === 'drugs' && dr.why.evidence === 'Sings about using crystal meth', JSON.stringify(dr));
  check('AI: the toast shows "💊 Drug references: ..."', Boolean(await toastHas(ava, '💊 Drugs or smoking: Sings about using crystal meth.')));
  check('AI: the credit came back', Boolean(await until(() => myCredits(ava) === before)), `${myCredits(ava)} vs ${before}`);
  check('AI: Why? on the refused result', Boolean(await until(() => visible(ava, `#results li[data-id="${t.drugs}"] button[data-act="why"]`))));
  const lg = await suggest(ben, await pickAndSeed(ben, 'Gin and Juice Snoop Dogg', 'legacy'));
  check('old verdict (no category): students see Other and a plain sentence, not the old reason',
    lg?.why?.id === 'other' && lg.why.evidence === 'It does not seem right for school.' && !JSON.stringify(lg).includes('old reason text'), JSON.stringify(lg));

  // 3b. A clean edit the AI turns down (what the song is about): the student is told why clean was not enough.
  {
    await search(ava, 'Lose Yourself Eminem');
    const clean = await ava.page.$$eval('#results li[data-id]', (els) => els.map((e) => ({
      id: e.dataset.id, title: e.querySelector('.song-title')?.textContent ?? '', artist: e.querySelector('.song-artist')?.textContent ?? '',
      tag: e.querySelector('.tag')?.textContent ?? '', tip: e.querySelector('.tag')?.title ?? '',
      free: !e.querySelector('button[data-act="suggest"]')?.disabled,
    }))).then((rows) => rows.find((r) => r.free && r.tag === 'Clean edit' && !used.has(r.id)));
    if (check('clean edit: the result tag says "Clean edit" with what it means', Boolean(clean)
      && clean.tip === 'Swear words bleeped out. RoomDJ still checks what the song is about.', JSON.stringify(clean))) {
      used.add(clean.id);
      const approvals = [approvedKey(clean.id), approvedKey(banKey(clean))];
      localKvBulk('delete', approvals);
      seeded.push(verdictKey(clean.id), ...approvals);
      localKvBulk('put', [{ key: verdictKey(clean.id), value: JSON.stringify({ verdict: 'inappropriate', category: 'violence', evidence: 'About a fight with a gun' }) }]);
      await ava.page.evaluate(() => document.querySelector('#toasts').replaceChildren());
      const cl = await suggest(ava, clean.id);
      const CLEAN_NO = 'Even the clean edit is not allowed: clean edits only bleep out swear words, and the song is still about the same thing.';
      check('clean edit: refused by the theme check (violence)', cl?.reason === 'theme' && cl.why?.id === 'violence', JSON.stringify(cl));
      check('clean edit: the toast starts with why clean was not enough, then the reason',
        Boolean(await toastHas(ava, `${CLEAN_NO} 🔪 Violence or weapons: About a fight with a gun.`)), await text(ava, '#toasts'));
      await ava.page.evaluate(() => document.querySelector('#toasts').replaceChildren());
      const cwhy = `#results li[data-id="${clean.id}"] button[data-act="why"]`;
      await until(() => visible(ava, cwhy));
      await ava.page.click(cwhy);
      check('clean edit: Why? says it too', Boolean(await toastHas(ava, `${CLEAN_NO} 🔪 Violence or weapons`)), await text(ava, '#toasts'));
    }
  }

  // 4. Needs a look: Remove with a picked reason and a note reaches the student.
  const held = await suggest(ben, await pickAndSeed(ben, 'Three Little Birds Bob Marley', 'unknown'));
  check('review: why unknown, "Your teacher will check it."', held?.reason === 'review' && held.why?.id === 'unknown' && held.why.evidence === 'Your teacher will check it.', JSON.stringify(held));
  const sReview = await hostState(host, (s) => s.review.some((x) => x.song.id === t.unknown));
  const reviewItem = sReview.review.find((x) => x.song.id === t.unknown);
  await quickPick(host, '#review', reviewItem.id, 'alcohol', 'Too much about parties');
  check('quick-pick: Needs a look offers Remove and Ban', (await text(host, '#reasonActions')).includes('Remove') && (await text(host, '#reasonActions')).includes('Ban'));
  await host.page.click('#reasonActions button[data-do="veto"]');
  check('remove with a reason: the student sees it with the note', Boolean(await toastHas(ben, '🍺 Alcohol or partying: Too much about parties.')), await text(ben, '#toasts'));
  check('remove with a reason: the dialog closes and the song is gone', !(await visible(host, '#reasonDlg'))
    && Boolean(await hostState(host, (s) => !s.review.some((x) => x.song.id === t.unknown))));

  // 5. Veto with a reason and a note; a rude note is refused on the page first.
  const okMsg = await suggest(ava, await pickAndSeed(ava, 'Here Comes the Sun Beatles', 'ok'));
  check('an OK song joins the queue', okMsg?.ok === true, JSON.stringify(okMsg));
  const sQ = await hostState(host, (s) => s.queue.some((x) => x.song.id === t.ok));
  const okItem = sQ.queue.find((x) => x.song.id === t.ok);
  await quickPick(host, '#queue', okItem.id, 'other', 'this is sh1t');
  await host.page.click('#reasonActions button[data-do="veto"]');
  check('quick-pick: a rude note is refused on the page, nothing sent', /cannot be shown that note/.test(await text(host, '#reasonMsg'))
    && (await visible(host, '#reasonDlg')) && lastState(host).queue.some((x) => x.id === okItem.id));
  await host.page.fill('#reasonNote', 'Save it for Friday');
  await host.page.click('#reasonActions button[data-do="veto"]');
  check('veto with a reason: the student is told why, with the note', Boolean(await toastHas(ava, 'out of the queue. Other: Save it for Friday.')), await text(ava, '#toasts'));
  check('veto with a reason: no extra "left the queue" toast', !(await text(ava, '#toasts')).includes('left the queue'));
  check('quick-pick: focus goes back to the page', !(await visible(host, '#reasonDlg')));

  // 6. Blocked today: details, Allow anyway (no charge), Ban.
  const list = await until(() => lastBlocked(host)?.[0]?.song.id === t.ok && lastBlocked(host));
  await host.page.click(await reveal(host.page, '#blockedBtn'));
  await host.page.waitForSelector('#blockedDlg[open]');
  const dlg = (await until(async () => {
    const d = await text(host, '#blockedList');
    return d.includes('Save it for Friday') && d;
  })) || '';
  check('Blocked today: newest first, every kind with the teacher details', list?.[0]?.song.id === t.ok && list[0].action === 'veto'
    && dlg.includes('Blocked word: "lovely"') && dlg.includes('AI checker: Sings about using crystal meth')
    && dlg.includes('old reason text from before categories') && dlg.includes('Alcohol or partying: Too much about parties')
    && dlg.includes('Other: Save it for Friday'), dlg.replace(/\s+/g, ' ').slice(0, 600));
  const drugEntry = list.find((b) => b.song.id === t.drugs);
  const credits0 = myCredits(ava);
  await host.page.click(`#blockedList li[data-id="${drugEntry.id}"] button[data-act="allowAnyway"]`);
  check('Allow anyway: the student is told yes', Boolean(await toastHas(ava, 'Your teacher said yes to')));
  check('Allow anyway: in the queue for that student', Boolean(await hostState(host, (s) => s.queue.some((x) => x.song.id === t.drugs && x.by === 'Ava'))));
  check('Allow anyway: no credit charged', Boolean(await until(() => lastState(ava)?.queue.some((x) => x.song.id === t.drugs))) && myCredits(ava) === credits0, `${myCredits(ava)} vs ${credits0}`);
  check('Allow anyway: remembered like Allow (approved: in KV)', Boolean(localKvGet(approvedKey(t.drugs))));
  check('Allow anyway: the entry says Allowed, no second Allow', Boolean(await until(async () => (await text(host, `#blockedList li[data-id="${drugEntry.id}"]`)).includes('Allowed')))
    && (await host.page.locator(`#blockedList li[data-id="${drugEntry.id}"] button[data-act="allowAnyway"]`).count()) === 0);
  const vetoEntry = lastBlocked(host).find((b) => b.song.id === t.ok);
  await host.page.click(`#blockedList li[data-id="${vetoEntry.id}"] button[data-act="banBlocked"]`);
  await host.page.waitForSelector('#confirm[open]');
  await host.page.click('#confirm button[value="ok"]');
  check('Ban from Blocked today: the entry says Banned', Boolean(await until(async () => (await text(host, `#blockedList li[data-id="${vetoEntry.id}"]`)).includes('Banned'))));
  unban = t.ok;
  check('Ban from Blocked today: on the ban list (KV)', (localKvGet('banned') ?? '').includes(t.ok));
  await host.page.click('#blockedDlg button[value="done"]');

  // 7. Big screen: the quick-pick and Blocked today are teacher tools, hidden on the projector.
  check('host: the family footer shows, with Student page in a new tab', (await visible(host, 'footer.footer'))
    && (await host.page.getAttribute('footer.footer a[href="/"]', 'target')) === '_blank');
  await host.page.click(await reveal(host.page, '#bigBtn'));
  check('big screen: no ▾, no Blocked today button, no footer', !(await visible(host, '#blockedBtn')) && !(await visible(host, '#banNowMore'))
    && !(await visible(host, 'footer.footer'))
    && (await host.page.locator('#queue button[data-act="more"]').count() === 0 || !(await host.page.locator('#queue button[data-act="more"]').first().isVisible())));
  await host.page.keyboard.press('Escape');

  await host.page.click(await reveal(host.page, '#closeBtn'));
  await host.page.click('#confirm button[value="ok"]');
  check('close: the room (and its Blocked today) is gone', Boolean(await until(() => visible(host, '#closedScreen'))));
  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL reasons stopped: ${e?.stack ?? e}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  raw?.ws.close();
  const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) });
  if (!r.ok) console.log('FAIL could not put the saved teacher settings back');
  try {
    if (seeded.length) localKvBulk('delete', seeded);
    if (unban) {
      const list = JSON.parse(localKvGet('banned') ?? '[]').filter((b) => b.id !== unban);
      localKvBulk('put', [{ key: 'banned', value: JSON.stringify(list) }]);
    }
  } catch (e) {
    console.log(`FAIL could not clean the seeded local KV keys: ${e.message}`);
  }
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
