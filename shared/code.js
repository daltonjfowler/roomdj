// The class code for the day (like uploadmymodel's class phrase, shared/slicing.js there). The
// teacher opens a room with a code on the board; students type it once to join. Pure JS, no DOM:
// the pages, the Worker, the Room and the Node tests all use it. The numbers live in protocol.js.
//
// The code is the only lock on a room, so it must be too many to guess. The Worker allows
// JOIN_RATE_IP (60) tries a minute from one address (a school shares one, so never fewer than a
// class needs), and on top of that a device is locked out after 5 wrong tries in a row
// (src/lockout.js). A suggested code is one of CODE_COUNT (28^5, about 17 million, over 2^24): one
// address trying all day (a room lives at most OPEN_MAX_MS, 24 hours) gets 60 x 60 x 24 = 86,400
// tries, about a 1 in 200 chance. Dalton chose that on 2026-10-29 (5 random characters, "K7MPQ", over
// the old 1 in 5,000 with three long words); someone who guesses it can only suggest (checked) songs
// and vote. A teacher's own code may be anything with a letter or number
// (Dalton's choice): a short one is guessable from outside the class, which the rate limit and
// lockout only slow down. The page still offers a strong suggestion.

import { CLASS_PERIOD_MIN, CODE_MAX, CODE_MIN_CHARS, CODE_MIN_PARTS, OPEN_MAX_MS, OPEN_MIN_MS } from './protocol.js';

/** "Blue Robot  Pancake 42" -> "blue-robot-pancake-42". Case, spaces and dashes do not matter. */
export function normalizeCode(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The code as the server compares it: no spaces or dashes at all (Dalton, 2026-10-29: "people can't
 * join with or without spaces for long phrases"). "Golden Walrus 42", "goldenwalrus42" and
 * "golden-walrus-42" are the same code.
 */
export function compactCode(text) {
  return normalizeCode(text).replace(/-/g, '');
}

/**
 * How the board shows a code: "golden-walrus-lantern-42" -> "golden walrus lantern 42"; a code of one
 * part (a suggestion like "k7mpq", or a teacher's one word) in capitals: "K7MPQ".
 */
export function displayCode(code) {
  const c = normalizeCode(code);
  return c.includes('-') ? c.replace(/-/g, ' ') : c.toUpperCase();
}

// Suggested codes (Dalton, 2026-10-29: "make the phrase way simpler", "Google Classroom style random
// code"): CODE_LENGTH characters from CODE_ALPHABET. No vowels, so a random code never spells a word on
// the board; no look-alikes (0/O, 1/I/L). Shown in capitals (displayCode). Keep CODE_COUNT at 2^24 or
// more (test/code.test.mjs).
export const CODE_ALPHABET = 'bcdfghjkmnpqrstvwxyz23456789';
export const CODE_LENGTH = 5;
export const CODE_COUNT = CODE_ALPHABET.length ** CODE_LENGTH;

// crypto, not Math.random: one code must say nothing about the next.
function cryptoRandom() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** CODE_LENGTH random characters for the board, e.g. "k7mpq" (shown "K7MPQ"). */
export function generateCode(random = cryptoRandom) {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]).join('');
}

/** A class code the teacher typed (or took from the suggestion): { ok, code } or { ok: false, error, message }. */
export function validateCode(text) {
  const code = normalizeCode(text);
  if (!code) return { ok: false, error: 'code', message: 'Type a class code, or use the suggestion.' };
  if (code.length > CODE_MAX) return { ok: false, error: 'code', message: `That class code is too long. Use up to ${CODE_MAX} letters and numbers.` };
  const parts = code.split('-');
  if (parts.length < CODE_MIN_PARTS || parts.join('').length < CODE_MIN_CHARS) {
    return { ok: false, error: 'code', message: 'Type a class code with at least one letter or number.' };
  }
  return { ok: true, code };
}

/** When a room opened now should close: the teacher's `until`, if it is a time we allow. */
export function validateUntil(until, now = Date.now()) {
  return Number.isSafeInteger(until) && until >= now + OPEN_MIN_MS && until <= now + OPEN_MAX_MS;
}

/**
 * The host page's "Open until" choices as absolute times (the teacher's own clock and time zone):
 * 'period' = one class period from now, 'day' = the end of today (local midnight). The end of
 * today is never less than one period away, so a room opened late in the day still lasts a class.
 */
export function untilFor(choice, now = new Date()) {
  const period = now.getTime() + CLASS_PERIOD_MIN * 60_000;
  if (choice === 'period') return period;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - 1000;
  return Math.max(period, Math.min(midnight, now.getTime() + OPEN_MAX_MS));
}
