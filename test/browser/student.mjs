// Browser test of the student page's own behaviour (the room flows are in flows.mjs): the QR link
// and the remembered nickname, a refused nickname, the wrong-code countdown, what a search result
// says when it cannot be suggested, "Your song is playing!", the offline note, the phone layout,
// reduced motion, and a 40-song queue on a slowed-down CPU (like a school Chromebook).
// Against a LOCAL wrangler dev only (it opens rooms with the teacher key from .dev.vars, which it
// never prints).
//   npm run dev, then:  npm run test:student   (or: node test/browser/student.mjs http://127.0.0.1:8792/)
// playwright-core: this repo's node_modules if present, else ../uploadmycut's. Searches hit the
// real iTunes API. Screenshots go to test/browser/.out/.

import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { T1, pickTeacher, closeOpenRooms } from './teacher-pick.mjs';
import { songKey } from '../../shared/repeats.js';

const BASE = process.argv[2] || 'http://127.0.0.1:8792/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = new URL('../../', import.meta.url);
const OUT = fileURLToPath(new URL('./.out/', import.meta.url));
mkdirSync(OUT, { recursive: true });
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname)) {
  console.log(`FAIL refused: runs only against a local dev server (not ${BASE})`);
  process.exit(1);
}

const UMC = fileURLToPath(new URL('../uploadmycut/', ROOT));
function resolveFrom(spec) {
  try { return createRequire(import.meta.url).resolve(spec); } catch { return createRequire(`${UMC}package.json`).resolve(spec); }
}
const pw = await import(pathToFileURL(resolveFrom('playwright-core')).href);
const { chromium } = pw.chromium ? pw : pw.default;

const vars = readFileSync(new URL('.dev.vars', ROOT), 'utf8');
const KEY = vars.split(/\r?\n/).find((l) => l.startsWith('TEACHER_KEY='))?.slice('TEACHER_KEY='.length).trim().replace(/^"(.*)"$/, '$1');
if (!KEY) throw new Error('TEACHER_KEY is not in .dev.vars');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 10_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(every);
  }
}

// ---- A room driven by API + sockets (no AI) ----
async function openRoom(label) {
  const code = `student ${label} room ${10 + Math.floor(Math.random() * 89)}`;
  await closeOpenRooms(BASE, KEY); // one room per teacher
  const r = await fetch(new URL('api/teacher/rooms', BASE), {
    method: 'POST', headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json' },
    body: JSON.stringify({ code, until: Date.now() + 30 * 60_000 }),
  });
  const room = await r.json();
  if (!r.ok) throw new Error(`could not open a room: ${room.error}`);
  return room;
}
const wsBase = BASE.replace(/^http/, 'ws');
const sockets = [];
const sock = (room, params) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${wsBase}api/rooms/${room.room}/ws?${new URLSearchParams(params)}`);
  ws.msgs = [];
  ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
  ws.onopen = () => resolve(ws);
  ws.onerror = reject;
  sockets.push(ws);
});
const lastState = (ws) => [...ws.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const send = (ws, msg) => ws.send(JSON.stringify(msg));
async function hostFor(room) {
  const host = await sock(room, { role: 'host', token: room.hostToken });
  send(host, { t: 'settings', settings: { aiCheck: false, blockUnknownSongs: false, hideVoteCounts: false, maxWaitingPerStudent: 10, maxSongMinutes: null, cooldownDays: null, downvoteMode: 'shown', scoreFloor: false, backToWork: false } });
  await until(() => lastState(host)?.settings.maxWaitingPerStudent === 10);
  return host;
}
async function studentSock(room, device, nick) {
  await fetch(new URL('api/join', BASE), { method: 'POST', headers: { 'x-device': device, 'content-type': 'application/json' }, body: JSON.stringify({ code: room.code }) });
  return sock(room, { role: 'student', device, nick });
}
async function roomSearch(room, device, q) {
  const r = await fetch(new URL(`api/rooms/${room.room}/search?q=${encodeURIComponent(q)}`, BASE), { headers: { 'x-device': device } });
  return (await r.json()).results ?? [];
}
async function suggestBy(ws, trackId) {
  const n = ws.msgs.length;
  send(ws, { t: 'suggest', song: trackId });
  return until(() => ws.msgs.slice(n).find((m) => m.t === 'suggested' && m.song === trackId), { timeout: 20_000 });
}

// ---- Pages ----
const browser = await chromium.launch({ executablePath: CHROME });
const contexts = [];
async function newPage({ viewport = { width: 1366, height: 768 }, scheme = 'light', reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion });
  await ctx.addInitScript(() => { if (!localStorage.getItem('cq.theme')) localStorage.setItem('cq.theme', 'system'); }); // the scheme decides (default is Dark)
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, page, errors };
}
const text = (page, sel) => page.locator(sel).textContent();
const focusedId = (page) => page.evaluate(() => document.activeElement?.id);
async function joinPage(page, room, nick) {
  await page.goto(new URL(`?code=${encodeURIComponent(room.code)}`, BASE).href);
  await page.fill('#nick', nick);
  await page.click('#joinBtn');
  await page.waitForSelector('#roomScreen:not([hidden])');
}
async function pageSearch(page, q) {
  await page.fill('#q', q);
  await page.press('#q', 'Enter');
  await page.waitForFunction(() => /found/.test(document.querySelector('#searchMsg').textContent), null, { timeout: 15_000 });
}
const resultLabel = (page, trackId) => page.locator(`#results li[data-id="${trackId}"] button`).textContent().catch(() => null);

try {
  const room = await openRoom('page');
  const host = await hostFor(room);
  const maya = await studentSock(room, 'student-test-maya-0001', 'Maya');

  // ---- QR link, refused nickname, remembered nickname ----
  {
    const { ctx, page, errors } = await newPage();
    await page.goto(new URL(`?code=${encodeURIComponent(room.code)}`, BASE).href);
    check('QR link: the note says only the nickname is left, and the cursor is in the nickname box',
      /class code is filled in\. Pick a nickname/.test(await text(page, '#joinNote')) && (await focusedId(page)) === 'nick');
    await page.fill('#nick', 'xXsh1tXx');
    await page.click('#joinBtn');
    const refused = await until(async () => (await text(page, '#joinMsg')) || null);
    check('refused nickname: a friendly sentence, and the cursor goes back to the nickname',
      refused === 'Please pick a different nickname.' && (await focusedId(page)) === 'nick', `${refused} / focus ${await focusedId(page)}`);
    check('refused nickname: it is not remembered', (await page.evaluate(() => localStorage.getItem('cq.nick'))) === null);
    await page.fill('#nick', 'Ava');
    await page.click('#joinBtn');
    await page.waitForSelector('#roomScreen:not([hidden])');
    check('nickname: remembered on this device once the room takes it', (await page.evaluate(() => localStorage.getItem('cq.nick'))) === '"Ava"');
    await page.click('#leave');
    await page.goto(new URL(`?code=${encodeURIComponent(room.code)}`, BASE).href);
    check('nickname: next time it is filled in, and the QR link lands on the Join button',
      (await page.inputValue('#nick')) === 'Ava' && (await focusedId(page)) === 'joinBtn' && /Check your nickname/.test(await text(page, '#joinNote')));
    check('no page errors (join)', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---- Wrong-code countdown ----
  {
    const { ctx, page } = await newPage();
    await page.goto(BASE);
    await page.fill('#nick', 'Eve');
    for (let i = 0; i < 6; i++) {
      if (await page.locator('#joinBtn').isDisabled()) break;
      await page.evaluate(() => { document.querySelector('#joinMsg').textContent = ''; });
      await page.fill('#code', 'purple walrus lantern 77');
      await page.click('#joinBtn');
      await until(async () => (await text(page, '#joinMsg')) || null);
    }
    const locked = await until(async () => /Too many wrong tries\. Wait \d+ seconds?/.test(await text(page, '#joinMsg')) && page.locator('#joinBtn').isDisabled());
    const label1 = await text(page, '#joinBtn');
    check('lockout: the Join button waits and counts down', Boolean(locked) && /^Wait \d+…$/.test(label1), label1);
    await wait(1600);
    const label2 = await text(page, '#joinBtn');
    check('lockout: the countdown goes down by itself', Number(label2.match(/\d+/)?.[0]) < Number(label1.match(/\d+/)?.[0]), `${label1} then ${label2}`);
    const free = await until(async () => !(await page.locator('#joinBtn').isDisabled()), { timeout: 12_000 });
    check('lockout: afterwards Join works again and says so', Boolean(free) && (await text(page, '#joinBtn')) === 'Join'
      && /try again now/.test(await text(page, '#joinMsg')));
    await ctx.close();
  }

  // ---- Search results that cannot be suggested say why ----
  const { page, ctx, errors } = await newPage();
  await joinPage(page, room, 'Bea');
  const pool = await roomSearch(room, 'student-test-maya-0001', 'Beatles');
  const [t1, t2, t3, t4] = pool.map((s) => s.id);
  check('search pool has songs', pool.length >= 4, String(pool.length));
  await suggestBy(maya, t1);
  await suggestBy(maya, t2);
  send(host, { t: 'next' }); // t1 plays
  await until(() => lastState(host)?.nowPlaying?.song.id === t1);
  await pageSearch(page, 'Beatles');
  check('results: the song playing says "Playing now", a queued one "In the queue"',
    /Playing now/.test(await resultLabel(page, t1)) && /In the queue/.test(await resultLabel(page, t2))
    && (await page.locator(`#results li[data-id="${t1}"] button`).isDisabled()), `${await resultLabel(page, t1)} / ${await resultLabel(page, t2)}`);
  check('results: a status reads as words for screen readers (no symbol first)',
    (await page.getAttribute(`#results li[data-id="${t1}"] button`, 'aria-label')).startsWith('Playing now:'));
  send(host, { t: 'next' }); // t2 plays, t1 is done
  check('results: a song that already played says so (no dead Suggest button)',
    Boolean(await until(async () => (await resultLabel(page, t1)) === 'Played already')));

  // A vote from someone else changes the counts, not the results list (no image flicker).
  await page.$eval(`#results li[data-id="${t3}"]`, (li) => { li.__mark = true; });
  await suggestBy(maya, t4);
  const t4Item = await until(() => lastState(maya)?.queue.find((q) => q.song.id === t4));
  send(maya, { t: 'vote', id: t4Item.id, v: 1 });
  await until(async () => (await page.locator(`#queue li[data-id="${t4Item.id}"] .vote.up .n`).textContent().catch(() => '')) === '1');
  check('results: a vote elsewhere does not rebuild the results', await page.$eval(`#results li[data-id="${t3}"]`, (li) => li.__mark === true));

  // Max song length: a long song says why ("⏱ Too long" + Why?), not a dead Suggest button.
  send(host, { t: 'settings', settings: { maxSongMinutes: 1 } });
  const suggestLabel = () => page.locator(`#results li[data-id="${t3}"] button[data-act="suggest"]`).textContent().catch(() => null);
  check('too long: a long result says "⏱ Too long"', Boolean(await until(async () => (await suggestLabel()) === '⏱ Too long')), String(await suggestLabel()));
  check('too long: with a Why? button, no Suggest button', await page.locator(`#results li[data-id="${t3}"] button[data-act="why"]`).isVisible()
    && await page.locator(`#results li[data-id="${t3}"] button[data-act="suggest"]`).isDisabled());
  await page.click(`#results li[data-id="${t3}"] button[data-act="why"]`);
  check('too long: Why? gives the song length and the limit', Boolean(await until(async () => /⏱ Too long: This song is \d+:\d\d; the limit is 1:00\./.test(await text(page, '#toasts')))));
  send(host, { t: 'settings', settings: { maxSongMinutes: null } });
  await until(async () => (await resultLabel(page, t3)) === 'Suggest');

  // Locked: buttons say Paused.
  send(host, { t: 'lock', on: true });
  check('locked: free songs say "Paused"', Boolean(await until(async () => (await resultLabel(page, t3)) === 'Paused')));
  send(host, { t: 'lock', on: false });
  await until(async () => (await resultLabel(page, t3)) === 'Suggest');

  // ---- Your song is playing ----
  await page.click(`#results li[data-id="${t3}"] button`);
  check('suggest: the result turns into "In the queue"', Boolean(await until(async () => /In the queue/.test(await resultLabel(page, t3)))));
  check('suggest: the waiting line counts it', /Your songs waiting: 1 of 10/.test(await text(page, '#waiting')), await text(page, '#waiting'));
  const avaItem = await until(() => lastState(maya)?.queue.find((q) => q.song.id === t3));
  send(maya, { t: 'vote', id: avaItem.id, v: 1 });
  send(host, { t: 'vote', id: avaItem.id, v: 1 }); // votes are final: the teacher's 👍 puts it ahead
  await until(() => lastState(host)?.queue[0]?.id === avaItem.id);
  send(host, { t: 'next' });
  const party = await until(async () => (await text(page, '#toasts')).includes('Your song is playing!'));
  check('your song plays: a "Your song is playing!" toast, said once to screen readers', Boolean(party)
    && Boolean(await until(async () => (await text(page, '#announce')).includes('Your song is playing!'))));
  check('your song plays: the now playing card is yours', await page.locator('.now.mine').isVisible() && /You suggested this one/.test(await text(page, '#nowPlaying')));
  check('toasts: the toast box is not a second live region', (await page.getAttribute('#toasts', 'aria-live')) === null);
  await page.screenshot({ path: `${OUT}student-your-song.png` });

  // ---- Offline note ----
  await ctx.setOffline(true);
  const offline = await until(() => page.locator('#netBanner').isVisible());
  check('offline: a note says so (fixed, nothing moves)', Boolean(offline) && /offline/.test(await text(page, '#netBanner'))
    && (await page.$eval('#netBanner', (e) => getComputedStyle(e).position)) === 'fixed');
  await page.screenshot({ path: `${OUT}student-offline.png` });
  await ctx.setOffline(false);
  check('back online: the note goes', Boolean(await until(async () => !(await page.locator('#netBanner').isVisible()), { timeout: 20_000 })));
  check('no page errors (room)', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // ---- Phone layout and reduced motion ----
  {
    const { ctx, page } = await newPage({ viewport: { width: 390, height: 844 }, scheme: 'dark', reducedMotion: 'reduce' });
    await joinPage(page, room, 'Alexandria-Rose 2026'); // a long nickname (20 letters)
    await page.waitForSelector('#queue li');
    const top = (sel) => page.$eval(`#roomScreen ${sel}`, (e) => e.getBoundingClientRect().top);
    check('phone: search comes before the queue', (await top('.now')) < (await top('.search-card')) && (await top('.search-card')) < (await top('.queue-card')));
    const bar = await page.$eval('.titlebar', (e) => e.getBoundingClientRect().height);
    check('phone: the title bar stays one row in a room, even with a long nickname', bar < 70, `${bar}px`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('phone: no sideways scrolling', over <= 1, `${over}px`);
    // The footer: teachChat and Dalton's site big, the family sites small; the way to the host page is
    // the big 🍎 Teacher button at the top (no Teacher link in the title bar or the footer any more).
    const foot = await page.$eval('footer.footer', (f) => ({
      hrefs: [...f.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      texts: [...f.querySelectorAll('a')].map((a) => a.textContent.trim()),
      right: Math.max(...[...f.querySelectorAll('*')].map((c) => c.getBoundingClientRect().right)),
    }));
    const teacherBtn = await page.$eval('.who-row a.who-btn', (a) => a.getAttribute('href')).catch(() => null);
    check('phone: Teacher button at the top; footer has teachChat, Made by, the family sites and Privacy & legal (no Teacher, no Open source), inside the screen',
      teacherBtn === '/host/' && !foot.hrefs.includes('/host/') && (await page.locator('#teacherLink').count()) === 0
      && ['https://teachchat.app', 'https://daltonjfowler.com', 'https://uploadmycut.com', '/legal'].every((h) => foot.hrefs.includes(h))
      && !foot.texts.some((t) => /open source/i.test(t)) && foot.right <= 390, JSON.stringify(foot));
    check('reduced motion: the now playing bars stand still', (await page.$eval('.now.playing .eq i', (e) => getComputedStyle(e).animationName)) === 'none');
    await page.screenshot({ path: `${OUT}student-phone-dark.png`, fullPage: true });
    await ctx.close();
  }
  // ---- Too many tabs: the oldest tab says so, and can take the room back ----
  {
    const { ctx, page } = await newPage();
    await joinPage(page, room, 'Cy');
    const others = [];
    for (let i = 0; i < 3; i++) {
      const p = await ctx.newPage();
      await p.goto(new URL(`?code=${encodeURIComponent(room.code)}`, BASE).href);
      await p.fill('#nick', 'Cy');
      await p.click('#joinBtn');
      await p.waitForSelector('#roomScreen:not([hidden])');
      others.push(p);
    }
    const told = await until(async () => (await page.locator('#endScreen').isVisible()) && (await text(page, '#endTitle')));
    check('tabs: the oldest tab says RoomDJ is open in another tab', told === 'RoomDJ is open in another tab', String(told));
    check('tabs: it offers to use this tab instead', (await text(page, '#endBtn')) === 'Use this tab instead');
    await others[0].close(); // so taking it back does not push out another tab
    await page.click('#endBtn');
    check('tabs: "Use this tab instead" goes back into the room', Boolean(await until(() => page.locator('#roomScreen').isVisible())));
    await ctx.close();
  }
  send(host, { t: 'close' });

  // ---- 40 songs on a slow CPU ----
  {
    const big = await openRoom('big');
    const bigHost = await hostFor(big);
    const kids = [];
    for (let i = 0; i < 7; i++) kids.push(await studentSock(big, `student-test-kid-${String(i).padStart(4, '0')}`, `Kid ${i + 1}`));
    // Different songs: two versions of one song (any version counts as the song) would be a duplicate.
    const songs = [];
    const keys = new Set();
    for (const q of ['love', 'happy', 'dance']) {
      for (const s of await roomSearch(big, 'student-test-kid-0000', q)) {
        if (songs.includes(s.id) || keys.has(songKey(s))) continue;
        keys.add(songKey(s));
        songs.push(s.id);
      }
    }
    let n = 0;
    await Promise.all(kids.map(async (kid, k) => {
      for (let j = 0; j < 6 && k * 6 + j < Math.min(40, songs.length); j++) if ((await suggestBy(kid, songs[k * 6 + j]))?.ok) n++;
    }));
    const queued = await until(() => (lastState(bigHost)?.queue.length >= 36 ? lastState(bigHost) : null), { timeout: 15_000 });
    check('big room: about 40 songs in the queue', Boolean(queued), `${lastState(bigHost)?.queue.length} queued, ${n} ok`);
    const { ctx, page, errors } = await newPage({ viewport: { width: 1366, height: 768 } });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await joinPage(page, big, 'Zoe');
    await page.waitForFunction((len) => document.querySelectorAll('#queue li').length === len, queued.queue.length, { timeout: 15_000 });
    await page.evaluate(() => {
      window.__long = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long = Math.max(window.__long, e.duration); }).observe({ type: 'longtask' });
    });
    // A burst of votes from the class: the bottom songs climb past the others.
    const items = lastState(bigHost).queue.slice(-10);
    for (const [i, item] of items.entries()) for (const kid of kids.slice(0, 1 + (i % 7))) send(kid, { t: 'vote', id: item.id, v: 1 });
    await wait(4000);
    const longest = await page.evaluate(() => window.__long);
    // At most one redraw a frame, and no sliding in a burst: about 100-180 ms a frame here (it was
    // 280 ms with a slide on every snapshot). 250 leaves room for a busy test machine.
    check('big room: a burst of votes with 40 songs, 4x slower CPU: no task over 250 ms', longest < 250, `${Math.round(longest)} ms`);
    check('big room: the page shows the same order as the server', await page.$$eval('#queue li', (els) => els.map((e) => e.dataset.id).join()) === lastState(bigHost).queue.map((q) => q.id).join());
    check('no page errors (big room)', errors.length === 0, errors.join(' | '));
    await page.screenshot({ path: `${OUT}student-big-room.png` });
    await ctx.close();
    send(bigHost, { t: 'close' });
  }
} catch (e) {
  failures++;
  console.log(`FAIL crashed: ${e?.stack || e}`);
} finally {
  await wait(300);
  for (const ws of sockets) try { ws.close(); } catch { /* closed */ }
  await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
