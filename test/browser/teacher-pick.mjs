// "Who's teaching?" for the browser tests (teacher profiles, protocol.js TEACHER PROFILES): get a
// host page from the start screen to the open-room form as one teacher. The tests use the seed
// list (protocol.js SEED_PROFILES): "Teacher 1", the legacy profile (the plain KV keys they seed and
// put back are that teacher's), and "Teacher 2". A local KV that still holds an older `profiles`
// list (other names) makes pickTeacher fail with a hint: delete the local key once
// (npx wrangler kv key delete profiles --binding CLASS_KV --local) and the first use seeds again.

import { SEED_PROFILES } from '../../shared/protocol.js';

/** Teacher 1: the legacy profile (the KV data from before profiles). */
export const T1 = SEED_PROFILES[0].id;
export const T1_NAME = SEED_PROFILES[0].name;
export const T2 = SEED_PROFILES[1].id;
export const T2_NAME = SEED_PROFILES[1].name;

/**
 * Every teacher runs ONE room at a time (CLAUDE.md invariant 31): close this teacher's rooms other
 * tests left open (POST /api/teacher/rooms/close-all) before a test opens its own.
 */
export async function closeOpenRooms(base, key, profile = T1) {
  await fetch(new URL('/api/teacher/rooms/close-all', base), { method: 'POST', headers: { 'x-teacher-key': key, 'x-teacher-profile': profile } }).catch(() => {});
}

/** The step the start screen shows: 'key' | 'who' | 'open' | null (none yet). */
export function startStep(page) {
  return page.evaluate(() => {
    const shown = (sel) => { const el = document.querySelector(sel); return Boolean(el && !el.hidden && el.offsetParent !== null); };
    if (shown('#signinStep') && !document.querySelector('#useKey').hidden) return 'signin';
    if (shown('#keyStep')) return 'key';
    if (shown('#whoStep') && document.querySelector('#whoList .who-pick')) return 'who';
    if (shown('#keyForm')) return 'open';
    return null;
  });
}

async function waitStep(page, want, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const step = await startStep(page).catch(() => null); // a reload in between
    if (step && (!want || want.includes(step))) return step;
    if (Date.now() > end) throw new Error(`start screen never showed ${want ?? 'a step'} (now ${step})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * From the start screen to the open-room form as `name`: types the key if asked, picks the teacher
 * (a different one than the page was loaded with reloads the page), and waits for "Teaching as".
 */
export async function pickTeacher(page, key, name = T1_NAME) {
  let step = await waitStep(page);
  if (step === 'signin') {
    // Spotify sign-in is the default; the tests use the teacher key (the local server has one).
    await page.click('#useKey');
    step = await waitStep(page, ['key', 'who', 'open']);
  }
  if (step === 'key') {
    await page.fill('#key', key);
    await page.click('#keyNext');
    step = await waitStep(page, ['who', 'open']);
  }
  if (step === 'open' && (await page.locator('#teachingName').textContent()) === name) return;
  if (step === 'open') {
    await page.click('#switchTeacher');
    await waitStep(page, ['who']);
  }
  const names = await page.$$eval('#whoList .who-pick', (b) => b.map((x) => x.textContent.trim()));
  if (!names.includes(name)) {
    throw new Error(`"${name}" is not on Who's teaching? (${names.join(', ')}). The local KV has an older profiles list: `
      + 'npx wrangler kv key delete profiles --binding CLASS_KV --local');
  }
  await page.locator('#whoList .who-pick', { hasText: name }).first().click();
  const end = Date.now() + 15_000;
  for (;;) {
    const ok = await page.evaluate((n) => {
      const form = document.querySelector('#keyForm');
      return Boolean(form && !form.hidden && document.querySelector('#teachingName')?.textContent === n);
    }, name).catch(() => false);
    if (ok) {
      // One room per teacher: rooms other tests left open would refuse this test's room (409 one_room).
      const profile = SEED_PROFILES.find((p) => p.name === name)?.id;
      if (profile) await closeOpenRooms(page.url(), key, profile);
      return;
    }
    if (Date.now() > end) throw new Error(`could not pick ${name}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
