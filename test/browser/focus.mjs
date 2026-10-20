// Browser test of 📚 Back to work (protocol.js BACK TO WORK): one host page, one student page in
// installed Chrome (playwright-core), plus plain WebSockets, against a LOCAL wrangler dev only.
//   npm run dev                       (build + wrangler dev on 127.0.0.1:8792), then in another shell:
//   npm run test:focus                (or: node test/browser/focus.mjs http://127.0.0.1:8792/)
// Reads TEACHER_KEY from .dev.vars and never prints it. Chrome: CHROME_PATH to override. No Workers
// AI call (the room's AI check is off); searches hit the real iTunes API through the host page.
// The teacher's saved settings are put back at the end (the repeat cooldown is off while it runs).
// Covers: the Settings choice (Off, 1/2/3/5/10 minutes); a suggestion → the full-page "📚 Back to
// work!" with a countdown, search, queue and votes hidden, the credit spent once; a reload is still
// blocked; the server refuses a forced suggestion (no credit charged) and jump from the same device
// (reason back_to_work, "You can suggest again in m:ss") but a forced VOTE counts and does not move
// the rest; the teacher's Students list shows 📚 m:ss and Let back in brings the room view back; the
// teacher's own picks and votes never wait; votes NEVER start a rest (Dalton 2026-10-08: only a
// suggestion does; no "Finish your votes" banner); the next suggestion does; Off: everyone is back
// in and nothing waits.

import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

async function openPage(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.addInitScript(() => { if (!localStorage.getItem('cq.theme')) localStorage.setItem('cq.theme', 'system'); }); // emulateMedia decides (default is Dark)
  const page = await ctx.newPage();
  const p = { name, ctx, page, msgs: [], errors: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|NotSupportedError|play\(\)/.test(m.text())) p.errors.push(m.text()); });
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    try { p.msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ }
  }));
  await page.goto(new URL(path, BASE).href);
  return p;
}
const lastState = (p) => [...p.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const visible = (p, sel) => p.page.locator(sel).isVisible();
const text = async (p, sel) => (await p.page.locator(sel).textContent()) ?? '';
const shot = (p, label) => p.page.screenshot({ path: `${OUT}focus-${label}-${p.name}.png` }).catch(() => {});
async function stateOf(p, pred, timeout = 10_000) {
  return until(() => {
    const s = lastState(p);
    return s && pred(s) ? s : null;
  }, { timeout });
}

async function rawSocket(roomId, params) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}api/rooms/${roomId}/ws?${new URLSearchParams(params)}`);
  const s = { ws, msgs: [] };
  ws.addEventListener('message', (e) => { try { s.msgs.push(JSON.parse(e.data)); } catch { /* not JSON */ } });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  s.ask = async (msg, pred, timeout = 15_000) => {
    const n = s.msgs.length;
    ws.send(JSON.stringify(msg));
    return until(() => s.msgs.slice(n).find(pred), { timeout });
  };
  s.send = (msg) => ws.send(JSON.stringify(msg));
  s.state = () => [...s.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
  return s;
}

let searches = 0;
async function findSong(roomId, q) {
  let last = '';
  for (let i = 0; i < 4; i++) {
    const probe = ['focustest-device-probe1', 'focustest-device-probe2'][searches++ % 2];
    const r = await fetch(new URL(`api/rooms/${roomId}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': probe } });
    const data = await r.json();
    if (data.results?.[0]) return data.results[0];
    last = `${r.status} ${JSON.stringify(data).slice(0, 300)}`;
    await wait(2000);
  }
  throw new Error(`no search result for ${q}: ${last}`);
}
async function apiJoin(code, device) {
  const r = await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  return r.status;
}

/**
 * 📐 Where the back-to-work card sits (page scrolled to the top): the title bar's bottom, the card's
 * top and bottom, the footer's top, and any element between the title bar and the card taller than
 * 120 px (an empty block pushing the card down).
 */
const restGap = (page) => page.evaluate(() => {
  window.scrollTo(0, 0);
  const header = document.querySelector('header.titlebar').getBoundingClientRect();
  const card = document.querySelector('#restScreen').getBoundingClientRect();
  const footer = document.querySelector('footer.footer').getBoundingClientRect();
  const bigEmpty = [];
  for (const el of document.querySelectorAll('#main *')) {
    const r = el.getBoundingClientRect();
    if (r.height > 120 && r.top >= header.bottom - 1 && r.bottom <= card.top + 1) bigEmpty.push(`${el.tagName.toLowerCase()}#${el.id} ${Math.round(r.height)}px`);
  }
  const px = (n) => Math.round(n);
  return { headerBottom: px(header.bottom), cardTop: px(card.top), cardBottom: px(card.bottom), footerTop: px(Math.min(footer.top, innerHeight)), bigEmpty };
});

/** The student page's view: 'rest' (the back-to-work card), 'room' (search + queue), or another. */
const view = (p) => p.page.evaluate(() => {
  const shown = (sel) => { const el = document.querySelector(sel); return Boolean(el && !el.hidden && el.offsetParent !== null); };
  if (shown('#restScreen') && !shown('#q') && !shown('#queue')) return 'rest';
  if (!shown('#restScreen') && shown('#q')) return 'room';
  return `other(rest ${shown('#restScreen')}, q ${shown('#q')}, queue ${shown('#queue')})`;
});

const savedDefaults = await (await api('/api/teacher/settings')).json();
// Songs replay across runs: no repeat cooldown. Back to work as a new teacher has it (on, 3 minutes).
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: true, backToWorkMinutes: 3 }) });
const pages = [];
const raws = [];
try {
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.check('input[name="openEnd"][value="day"]');
  await host.page.fill('#openCleanup', '');
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { classCode: code, room: roomId, token } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  const first = await stateOf(host, () => true);
  check('a new room: back to work on, 3 minutes', first.settings.backToWork === true && first.settings.backToWorkMinutes === 3, JSON.stringify(first.settings));

  // Settings: the choice is Off or 1/2/3/5/10 minutes; pick 1 minute.
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  const choices = await host.page.$$eval('#setBackToWork option', (os) => os.map((o) => o.value).join());
  check('settings: 📚 Back to work offers Off, 1, 2, 3, 5, 10 minutes (3 picked)', choices === 'off,1,2,3,5,10'
    && (await host.page.inputValue('#setBackToWork')) === '3', choices);
  await host.page.selectOption(await reveal(host.page, '#setBackToWork'), '1');
  await host.page.setChecked(await reveal(host.page, '#setAi'), false);
  await host.page.click('#applySettings');
  check('settings: 1 minute reaches the room', Boolean(await stateOf(host, (s) => s.settings.backToWorkMinutes === 1 && !s.settings.aiCheck)));
  const hostWs = await rawSocket(roomId, { role: 'host', token });
  raws.push(hostWs);
  hostWs.send({ t: 'settings', settings: { blockUnknownSongs: false, maxWaitingPerStudent: 10, maxSongMinutes: null, startingCredits: 5, cooldownDays: null, downvoteMode: 'shown', scoreFloor: false } });
  await stateOf(host, (s) => s.settings.startingCredits === 5 && s.settings.maxWaitingPerStudent === 10);

  for (const d of ['focustest-device-probe1', 'focustest-device-probe2']) await apiJoin(code, d); // they search
  const songs = {};
  songs.a = await findSong(roomId, 'Here Comes the Sun Beatles');
  songs.b = await findSong(roomId, 'Dancing Queen ABBA');
  songs.c = await findSong(roomId, 'Mr. Blue Sky Electric Light Orchestra');
  songs.d = await findSong(roomId, 'September Earth Wind Fire');
  songs.e = await findSong(roomId, 'Walking on Sunshine Katrina');

  // Ava suggests on her page.
  const ava = await openPage('ava', `?code=${code}`);
  pages.push(ava);
  await ava.page.fill('#code', code);
  await ava.page.fill('#nick', 'Ava');
  await ava.page.click('#joinBtn');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');
  check('student: the room view before any action', (await view(ava)) === 'room');
  await ava.page.fill('#q', 'Here Comes the Sun Beatles');
  await ava.page.press('#q', 'Enter');
  await ava.page.waitForSelector(`#results li[data-id="${songs.a.id}"] button[data-act="suggest"]:not([disabled])`, { timeout: 20_000 });
  const n0 = ava.msgs.length;
  await ava.page.click(`#results li[data-id="${songs.a.id}"] button[data-act="suggest"]`);
  const sug = await until(() => ava.msgs.slice(n0).find((m) => m.t === 'suggested'), { timeout: 20_000 });
  check('suggest: it joins the queue', sug?.ok === true, JSON.stringify(sug));
  check('suggest → the full-page back-to-work screen', Boolean(await until(async () => (await view(ava)) === 'rest')), await view(ava));
  const restText = (await text(ava, '#restScreen')).replace(/\s+/g, ' ');
  check('... "📚 Back to work! Your pick is in. Check back in 1 minute."', /📚 Back to work!/.test(restText) && /Your pick is in\. Check back in 1 minute\./.test(restText), restText);
  const c1 = await text(ava, '#restClock');
  await wait(1600);
  const c2 = await text(ava, '#restClock');
  check('... with a countdown (m:ss, ticking)', /^[01]:\d\d$/.test(c1) && /^[01]:\d\d$/.test(c2) && c1 !== c2, `${c1} → ${c2}`);
  check('... search, the queue and votes are hidden', !(await visible(ava, '#q')) && !(await visible(ava, '#queue')) && !(await ava.page.locator('.vote').first().isVisible()));
  const s1 = lastState(ava);
  check('state: you.restUntil and restLeft (about a minute), credits 5 → 4', s1.you.restUntil > 0 && s1.you.restLeft > 50_000 && s1.you.restLeft <= 60_000
    && s1.you.credits === 4, JSON.stringify(s1.you));
  await shot(ava, 'rest');

  // A reload: still resting (the room has it, not the page).
  await ava.page.reload();
  await ava.page.waitForSelector('#roomScreen:not([hidden])', { timeout: 15_000 });
  check('reload: still the back-to-work screen', Boolean(await until(async () => (await view(ava)) === 'rest')), await view(ava));

  // The same device on its own socket (another tab, a script): the server refuses, nothing charged.
  const device = await ava.page.evaluate(() => localStorage.getItem('cq.device'));
  const tab = await rawSocket(roomId, { role: 'student', device, nick: 'Ava' });
  raws.push(tab);
  await until(() => tab.state());
  const r1 = await tab.ask({ t: 'suggest', song: songs.b.id }, (m) => m.t === 'suggested');
  check('forced suggest: refused, reason back_to_work', r1?.ok === false && r1.reason === 'back_to_work'
    && /^📚 Back to work! You can suggest again in \d:\d\d\.$/.test(r1.message) && r1.left > 0, JSON.stringify(r1));
  await wait(500);
  check('... no credit charged (still 4), not in the queue', tab.state().you.credits === 4 && !tab.state().queue.some((q) => q.song.id === songs.b.id));
  const itemA = lastState(host).queue.find((q) => q.song.id === songs.a.id);
  const restBefore = tab.state().you.restUntil;
  const r2 = await tab.ask({ t: 'vote', id: itemA.id, v: 1 }, (m) => m.t === 'error' || (m.t === 'state' && m.state.queue.find((x) => x.id === itemA.id)?.myVote === 1));
  check('forced vote while resting: it counts (votes are never refused by a rest)', r2?.t === 'state', JSON.stringify(r2));
  check('... and the rest did not move', tab.state().you.restUntil === restBefore && restBefore > 0);
  tab.ws.send(JSON.stringify({ t: 'vote', id: itemA.id, v: 0 })); // take it back: the counts below start clean
  await stateOf(host, (s) => s.queue.find((x) => x.id === itemA.id)?.up === 0);
  const r3 = await tab.ask({ t: 'jump', id: itemA.id }, (m) => m.t === 'jumped');
  check('forced jump: refused, reason back_to_work', r3?.ok === false && r3.reason === 'back_to_work', JSON.stringify(r3));

  // The teacher's own picks and votes never wait.
  const t1 = await hostWs.ask({ t: 'suggest', song: songs.b.id }, (m) => m.t === 'suggested' && m.song === songs.b.id, 20_000);
  const t2 = await hostWs.ask({ t: 'suggest', song: songs.c.id }, (m) => m.t === 'suggested' && m.song === songs.c.id, 20_000);
  check('teacher: two picks in a row both join', t1?.ok === true && t2?.ok === true, JSON.stringify([t1, t2]));
  const q = await stateOf(host, (s) => s.queue.length === 3);
  const itemB = q.queue.find((x) => x.song.id === songs.b.id).id;
  const itemC = q.queue.find((x) => x.song.id === songs.c.id).id;
  hostWs.send({ t: 'vote', id: itemA.id, v: 1 });
  hostWs.send({ t: 'vote', id: itemB, v: 1 });
  check('teacher: votes go through one after another', Boolean(await stateOf(host, (s) => s.queue.find((x) => x.id === itemA.id)?.myVote === 1
    && s.queue.find((x) => x.id === itemB)?.myVote === 1)));
  check('teacher: never in a rest', !lastState(host).students.some((s) => s.device === 'teacher:host'));

  // The teacher's Students list: 📚 m:ss and Let back in.
  await host.page.click(await reveal(host.page, '#studentsBtn'));
  await host.page.waitForSelector('#studentsDlg[open]');
  const row = host.page.locator(`#students li[data-id="${device}"]`);
  check('host: Students shows 📚 m:ss next to Ava', /📚 [01]:\d\d/.test(await row.locator('.rest-tag').textContent().catch(() => '')));
  await row.locator('button[data-act="letBackIn"]').click();
  check('Let back in: Ava\'s room view returns', Boolean(await until(async () => (await view(ava)) === 'room')), await view(ava));
  check('... the 📚 tag goes', Boolean(await until(async () => (await row.locator('.rest-tag').count()) === 0)));
  await host.page.click('#studentsDlg button[value="done"]');

  // Votes never start a rest: vote on two songs, the room view stays, no banner, no rest.
  await ava.page.waitForSelector(`#queue li[data-id="${itemB}"] button[data-act="up"]`);
  await ava.page.click(`#queue li[data-id="${itemB}"] button[data-act="up"]`);
  await ava.page.click(`#queue li[data-id="${itemC}"] button[data-act="up"]`);
  check('votes: both count', Boolean(await stateOf(host, (s) => s.queue.find((x) => x.id === itemB)?.up === 2
    && s.queue.find((x) => x.id === itemC)?.up === 1)));
  await wait(2500);
  check('votes: no rest starts (room view, no "Finish your votes" banner, restUntil null)', (await view(ava)) === 'room'
    && (await ava.page.locator('#restSoon').count()) === 0 && lastState(ava).you.restUntil === null, await view(ava));
  // The next suggestion does.
  await ava.page.fill('#q', 'September Earth Wind Fire');
  await ava.page.press('#q', 'Enter');
  await ava.page.waitForSelector(`#results li[data-id="${songs.d.id}"] button[data-act="suggest"]:not([disabled])`, { timeout: 20_000 });
  await ava.page.click(`#results li[data-id="${songs.d.id}"] button[data-act="suggest"]`);
  check('the next suggestion starts the rest again', Boolean(await until(async () => (await view(ava)) === 'rest', { timeout: 20_000 }))
    && /Your pick is in\./.test(await text(ava, '#restText')));
  // 📐 The card sits right under the title bar (no giant empty band above it): Chromebook and phone, light and dark.
  for (const [w, h] of [[1366, 768], [390, 844]]) {
    await ava.page.setViewportSize({ width: w, height: h });
    for (const scheme of ['light', 'dark']) {
      await ava.page.emulateMedia({ colorScheme: scheme });
      await wait(150);
      const gap = await restGap(ava.page);
      check(`rest card at ${w}x${h} ${scheme}: its top within 120 px of the header, no big empty block above it, no empty band below it`,
        gap.cardTop - gap.headerBottom <= 120 && gap.bigEmpty.length === 0 && gap.footerTop - gap.cardBottom <= 60, JSON.stringify(gap));
      await shot(ava, `rest-${w}-${scheme}`);
    }
  }
  await ava.page.setViewportSize({ width: 1366, height: 768 });
  await ava.page.emulateMedia({ colorScheme: 'light' });

  // Off: everyone is back in at once, and nothing waits.
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  await host.page.selectOption(await reveal(host.page, '#setBackToWork'), 'off');
  await host.page.click('#applySettings');
  check('Off: the room says backToWork false', Boolean(await stateOf(host, (s) => s.settings.backToWork === false)));
  check('Off: Ava\'s room view returns', Boolean(await until(async () => (await view(ava)) === 'room')), await view(ava));
  const r5 = await tab.ask({ t: 'suggest', song: songs.e.id }, (m) => m.t === 'suggested', 20_000);
  check('Off: a suggestion goes through', r5?.ok === true, JSON.stringify(r5));
  await wait(800);
  check('Off: no back-to-work screen after it, no rest in the state', (await view(ava)) === 'room' && lastState(ava).you.restUntil === null);
  const r6 = await tab.ask({ t: 'vote', id: itemA.id, v: 1 }, (m) => m.t === 'state' && m.state.queue.find((x) => x.id === itemA.id)?.myVote === 1);
  check('Off: votes go through', Boolean(r6));

  // A second student with the default (on) is not touched by Ava's rest.
  const bo = 'focustest-device-bo-0001';
  await apiJoin(code, bo);
  const boWs = await rawSocket(roomId, { role: 'student', device: bo, nick: 'Bo' });
  raws.push(boWs);
  await until(() => boWs.state());
  check('another student: not resting', boWs.state().you.restUntil === null);

  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.join(' | '));
  hostWs.send({ t: 'close' });
  await wait(500);
} catch (e) {
  failures++;
  console.log(`FAIL focus stopped: ${e?.stack ?? e}`);
  for (const p of pages) await shot(p, 'crash');
} finally {
  for (const r of raws) r.ws.close();
  const r = await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) });
  if (!r.ok) console.log('FAIL could not put the saved teacher settings back');
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exitCode = failures ? 1 : 0;
