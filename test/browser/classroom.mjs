// Browser test of the classroom controls (shared/classroom.js; Dalton 2026-11-16: "a teacher can reward or ban
// kids", "kids figured out using edge/chrome/private tab allows them to make multiple accounts"). One host page
// and student pages in separate browser contexts (each one a new device, like another browser or a private tab),
// in installed Chrome (playwright-core), against a LOCAL wrangler dev only.
//   npm run dev, then: npm run test:classroom   (or: node test/browser/classroom.mjs http://127.0.0.1:8792/)
// Needs TEST_AI_OFF=on and TYPED_NICKNAMES=on in .dev.vars. Reads TEACHER_KEY and never prints it. No Workers AI.
// Covers: ⭐ Pass in Students → the student sees the pass, their next song jumps ahead of earlier songs, the pass
// is used; ⏸ Time out 5 min → the student's card says paused, a vote is refused, End time out lifts it; 🚪 Close
// joining → a new device knocks and waits, the teacher is told, Let in → it joins; another knocks, No → it is told
// and stays out; a student already in can reload and come back.

import { mkdirSync, readFileSync } from 'node:fs';
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
const KEY = (() => {
  const line = readFileSync(new URL('.dev.vars', ROOT), 'utf8').split(/\r?\n/).find((l) => l.startsWith('TEACHER_KEY='));
  if (!line) throw new Error('TEACHER_KEY is not in .dev.vars');
  return line.slice('TEACHER_KEY='.length).trim().replace(/^"(.*)"$/, '$1');
})();

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
  return ok;
}
async function until(fn, { timeout = 10_000, every = 150 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}
const api = (path, init = {}) =>
  fetch(new URL(path, BASE), { ...init, headers: { 'x-teacher-key': KEY, 'x-teacher-profile': T1, 'content-type': 'application/json', ...init.headers } });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
async function openPage(name, path) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const p = { name, ctx, page, msgs: [], errors: [] };
  page.on('pageerror', (e) => p.errors.push(String(e)));
  page.on('websocket', (ws) => ws.on('framereceived', (f) => { try { p.msgs.push(JSON.parse(f.payload)); } catch { /* not JSON */ } }));
  await page.goto(new URL(path, BASE).href);
  return p;
}
const lastState = (p) => [...p.msgs].reverse().find((m) => m.t === 'state')?.state ?? null;
const stateOf = (p, pred, timeout = 10_000) => until(() => { const s = lastState(p); return s && pred(s) ? s : null; }, { timeout });
const text = (p, sel) => p.page.locator(sel).first().textContent().catch(() => '');

async function joinAs(p, code, nick) {
  await p.page.fill('#code', code);
  await p.page.fill('#nick', nick);
  await p.page.click('#joinBtn');
}

const savedDefaults = await (await api('/api/teacher/settings')).json();
await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify({ cooldownDays: null, backToWork: false, maxWaitingPerStudent: 5 }) });
const pages = [];
try {
  const host = await openPage('host', 'host/');
  pages.push(host);
  await host.page.waitForSelector('#startScreen:not([hidden])');
  await pickTeacher(host.page, KEY);
  await host.page.click('#openBtn');
  await host.page.waitForFunction(() => document.querySelector('#bigCode')?.textContent && !document.querySelector('#hostScreen').hidden, null, { timeout: 15_000 });
  const { classCode: code } = await host.page.evaluate(() => JSON.parse(sessionStorage.getItem('cq.host')));
  await host.page.click('#settingsBtn');
  await host.page.waitForSelector('#settingsDlg[open]');
  const ai = await reveal(host.page, '#setAi').catch(() => null);
  if (ai) await host.page.setChecked(ai, false);
  await host.page.click('#applySettings');
  await stateOf(host, (s) => !s.settings.aiCheck);

  const ava = await openPage('ava', '');
  const ben = await openPage('ben', '');
  pages.push(ava, ben);
  await joinAs(ava, code, 'Ava');
  await joinAs(ben, code, 'Ben');
  await ava.page.waitForSelector('#roomScreen:not([hidden])');
  await ben.page.waitForSelector('#roomScreen:not([hidden])');
  const hs = await stateOf(host, (s) => s.students?.length === 2);
  const avaDev = hs.students.find((x) => x.nick === 'Ava').device;

  const pickFrom = async (p, q) => {
    await p.page.fill('#q', q);
    await p.page.press('#q', 'Enter');
    await until(async () => (await p.page.locator('#results li[data-id] button[data-act="suggest"]:not([disabled])').count()) > 0, { timeout: 20_000 });
    const id = await p.page.$eval('#results li[data-id]:has(button[data-act="suggest"]:not([disabled]))', (e) => e.dataset.id);
    await p.page.click(`#results li[data-id="${id}"] button[data-act="suggest"]`);
    return id;
  };

  // ⭐ Pass: Ben's two songs wait first, then Ava (with a pass) suggests: hers goes ahead of both.
  const b1 = await pickFrom(ben, 'Lovely Day Bill Withers');
  await stateOf(host, (s) => s.queue.some((q) => q.song.id === b1), 30_000);
  const b2 = await pickFrom(ben, 'Walking on Sunshine Katrina');
  await stateOf(host, (s) => s.queue.some((q) => q.song.id === b2), 30_000);
  await host.page.click(await reveal(host.page, '#studentsBtn'));
  await host.page.waitForSelector('#studentsDlg[open]');
  await host.page.click(`#students li[data-id="${avaDev}"] button[data-act="pass"]`);
  check('⭐ the student sees the pass', Boolean(await until(async () => !(await ava.page.locator('#passes').isHidden()) && (await text(ava, '#passesN')).includes('1 skip-the-line pass'))));
  check('⭐ the teacher sees ⭐ 1 on the row', Boolean(await until(async () => (await text(host, `#students li[data-id="${avaDev}"] .student-controls`)).includes('⭐ 1'))));
  await host.page.keyboard.press('Escape');
  const a1 = await pickFrom(ava, 'Here Comes the Sun Beatles');
  const sPass = await stateOf(host, (s) => s.queue.some((q) => q.song.id === a1), 30_000);
  const order = sPass?.queue.map((q) => q.song.id) ?? [];
  check('⭐ the pass song jumps ahead of the songs suggested before it', order.indexOf(a1) < order.indexOf(b1) && order.indexOf(a1) < order.indexOf(b2), JSON.stringify(order));
  check('⭐ the pass is used up', Boolean(await stateOf(ava, (s) => s.you?.passes === 0)) && await ava.page.locator('#passes').isHidden());

  // ⏸ Time out 5 minutes: the card, a refused vote, End time out.
  await host.page.click(await reveal(host.page, '#studentsBtn'));
  await host.page.waitForSelector('#studentsDlg[open]');
  await host.page.selectOption(`#students li[data-id="${avaDev}"] select[data-act="timeout"]`, '5');
  check('⏸ the student sees "Paused by your teacher"', Boolean(await until(async () => (await text(ava, '#restTitle')).includes('Paused') && !(await ava.page.locator('#restScreen').isHidden()))));
  await ava.page.screenshot({ path: `${OUT}classroom-timeout-student.png` });
  check('⏸ the student state carries the time left', Boolean(await stateOf(ava, (s) => s.you?.timeoutLeft > 4 * 60_000)));
  check('⏸ the teacher row shows the time out', Boolean(await until(async () => (await text(host, `#students li[data-id="${avaDev}"] .student-controls`)).includes('⏸ until'))));
  await host.page.screenshot({ path: `${OUT}classroom-students-host.png` });
  await host.page.click(`#students li[data-id="${avaDev}"] button[data-act="untimeout"]`);
  check('⏸ End time out: the card goes away', Boolean(await until(async () => ava.page.locator('#restScreen').isHidden())));

  // 🚪 Close joining: a new device knocks; Let in → it joins.
  await host.page.click('#doorBtn');
  await stateOf(host, (s) => s.joinClosed === true);
  const cam = await openPage('cam', '');
  pages.push(cam);
  await joinAs(cam, code, 'Cam');
  check('🚪 the new device waits ("Joining is closed")', Boolean(await until(async () => (await text(cam, '#joinMsg')).includes('Joining is closed'))));
  check('🚪 the teacher sees the knock', Boolean(await until(async () => (await host.page.locator('#knocks li[data-id] button[data-act="letIn"]').count()) === 1)));
  await host.page.screenshot({ path: `${OUT}classroom-knock-host.png` });
  await host.page.click('#knocks li[data-id] button[data-act="letIn"]');
  check('🚪 Let in: the device joins the room', Boolean(await until(async () => !(await cam.page.locator('#roomScreen').isHidden()), { timeout: 15_000 })));

  // Another knocks; No → told, and stays out (a new browser trying again cannot sneak in either).
  const dan = await openPage('dan', '');
  pages.push(dan);
  await joinAs(dan, code, 'Dan');
  await until(async () => (await host.page.locator('#knocks li[data-id] button[data-act="turnAway"]').count()) === 1);
  await host.page.click('#knocks li[data-id] button[data-act="turnAway"]');
  check('🚪 No: the device is told it was not let in', Boolean(await until(async () => (await text(dan, '#joinMsg')).includes('did not let this device in'), { timeout: 15_000 })));
  await joinAs(dan, code, 'Dan');
  check('🚪 it cannot try again', Boolean(await until(async () => (await text(dan, '#joinMsg')).includes('removed you'))));

  // A student already in reloads while joining is closed: back in, no knock.
  await ben.page.reload();
  check('🚪 a student already in can reload and come back', Boolean(await until(async () => !(await ben.page.locator('#roomScreen').isHidden()), { timeout: 15_000 })));
  check('no page errors', pages.every((p) => p.errors.length === 0), pages.flatMap((p) => p.errors.map((e) => `${p.name}: ${e}`)).join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack ?? e}`);
} finally {
  await api('/api/teacher/settings', { method: 'PUT', body: JSON.stringify(savedDefaults) }).catch(() => {});
  await pages[0]?.page.evaluate(() => document.querySelector('#closeRoomBtn')?.click()).catch(() => {});
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
