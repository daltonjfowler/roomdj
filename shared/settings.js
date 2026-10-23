// Room / teacher settings checks. The Worker and the Room refuse anything that does not pass.
// A missing field takes its default, so a page may send only the fields it changes.

import { BACK_TO_WORK_MINUTES, COOLDOWN_DAYS, DEFAULT_SETTINGS, DOWNVOTE_MODES, SETTINGS_LIMITS } from './protocol.js';
import { screenNote } from './reasons.js';

const BELL_TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * The bell schedule presets: [{ name, ends: 'HH:MM' }], sorted by time. Names are one line, at most
 * SETTINGS_LIMITS.bellName letters, and pass the word screen (students may see them on the board).
 */
export function cleanBellSchedule(errors, value) {
  if (!Array.isArray(value)) {
    errors.push('The bell schedule must be a list.');
    return [];
  }
  if (value.length > SETTINGS_LIMITS.bellSchedule) errors.push(`At most ${SETTINGS_LIMITS.bellSchedule} bell times.`);
  const out = [];
  for (const row of value.slice(0, SETTINGS_LIMITS.bellSchedule)) {
    const raw = typeof row?.name === 'string' ? row.name.normalize('NFKC').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim() : null;
    const m = BELL_TIME.exec(typeof row?.ends === 'string' ? row.ends.trim() : '');
    if (!raw || [...raw].length > SETTINGS_LIMITS.bellName) {
      errors.push(`Each bell time needs a name of 1 to ${SETTINGS_LIMITS.bellName} letters.`);
      continue;
    }
    if (!m) {
      errors.push(`"${raw}" needs an end time like 10:10 (24-hour, 13:45 for 1:45 PM).`);
      continue;
    }
    if (screenNote(raw).refused) {
      errors.push('A bell time name has a word students should not see. Pick another name.');
      continue;
    }
    out.push({ name: raw, ends: `${m[1].padStart(2, '0')}:${m[2]}` });
  }
  return out.sort((a, b) => a.ends.localeCompare(b.ends));
}

function intInRange(errors, label, value, [min, max]) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${label} must be a whole number from ${min} to ${max}.`);
    return null;
  }
  return n;
}

function bool(errors, label, value) {
  if (typeof value !== 'boolean') {
    errors.push(`${label} must be on or off.`);
    return null;
  }
  return value;
}

/** Lower-cased, trimmed, inner spaces collapsed; empty and duplicate words dropped. */
export function cleanBlocklist(errors, value) {
  if (!Array.isArray(value)) {
    errors.push('The blocked words must be a list.');
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') {
      errors.push('Each blocked word must be text.');
      continue;
    }
    const word = raw.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!word || seen.has(word)) continue;
    if (word.length > SETTINGS_LIMITS.blocklistWordLength) {
      errors.push(`Blocked words can be at most ${SETTINGS_LIMITS.blocklistWordLength} letters ("${word.slice(0, 20)}...").`);
      continue;
    }
    seen.add(word);
    out.push(word);
  }
  if (out.length > SETTINGS_LIMITS.blocklistWords) {
    errors.push(`At most ${SETTINGS_LIMITS.blocklistWords} blocked words.`);
  }
  return out.slice(0, SETTINGS_LIMITS.blocklistWords);
}

/** null = credits off (the Credits switch); otherwise a whole number (a real number, not text or true). */
function startingCredits(errors, value) {
  if (value === null) return null;
  const [min, max] = SETTINGS_LIMITS.startingCredits;
  if (typeof value !== 'number') {
    errors.push(`Starting credits must be off or a whole number from ${min} to ${max}.`);
    return null;
  }
  return intInRange(errors, 'Starting credits', value, SETTINGS_LIMITS.startingCredits);
}

/** null = Max song length off (the switch); otherwise whole minutes (a real number). */
function maxSongMinutes(errors, value) {
  if (value === null) return null;
  const [min, max] = SETTINGS_LIMITS.maxSongMinutes;
  if (typeof value !== 'number') {
    errors.push(`Max song length must be off or a whole number of minutes from ${min} to ${max}.`);
    return null;
  }
  return intInRange(errors, 'Max song length (minutes)', value, SETTINGS_LIMITS.maxSongMinutes);
}

/** null = Repeat cooldown off; otherwise one of COOLDOWN_DAYS (a real number). */
function cooldownDays(errors, value) {
  if (value === null || COOLDOWN_DAYS.includes(value)) return value;
  errors.push(`Repeat cooldown must be off or ${COOLDOWN_DAYS.join(', ')} days.`);
  return null;
}

/** Back-to-work minutes: one of BACK_TO_WORK_MINUTES (a real number); Off is backToWork false. */
function backToWorkMinutes(errors, value) {
  if (BACK_TO_WORK_MINUTES.includes(value)) return value;
  errors.push(`Back to work must be ${BACK_TO_WORK_MINUTES.join(', ')} minutes.`);
  return null;
}

/** 👎 per student per class (protocol.js DOWNVOTE LIMIT): null = unlimited; otherwise a whole number (a real number). */
function maxDownvotes(errors, value) {
  if (value === null) return null;
  const [min, max] = SETTINGS_LIMITS.maxDownvotes;
  if (typeof value !== 'number') {
    errors.push(`👎 per student must be unlimited or a whole number from ${min} to ${max}.`);
    return null;
  }
  return intInRange(errors, '👎 per student', value, SETTINGS_LIMITS.maxDownvotes);
}

/** 👍 per student per class (protocol.js UPVOTE LIMIT): null = unlimited; otherwise a whole number (a real number). */
function maxUpvotes(errors, value) {
  if (value === null) return null;
  const [min, max] = SETTINGS_LIMITS.maxUpvotes;
  if (typeof value !== 'number') {
    errors.push(`👍 per student must be unlimited or a whole number from ${min} to ${max}.`);
    return null;
  }
  return intInRange(errors, '👍 per student', value, SETTINGS_LIMITS.maxUpvotes);
}

/** 👎 votes (protocol.js DOWNVOTE MODE): one of DOWNVOTE_MODES. */
function downvoteMode(errors, value) {
  if (DOWNVOTE_MODES.includes(value)) return value;
  errors.push('👎 votes must be off, on with counts hidden, or on with counts shown.');
  return null;
}

/** 👻 Ghost 👍 minutes (protocol.js GHOST VOTE): a whole number (a real number, not text). */
function ghostVoteMinutes(errors, value) {
  const [min, max] = SETTINGS_LIMITS.ghostVoteMinutes;
  if (typeof value !== 'number') {
    errors.push(`Ghost 👍 minutes must be a whole number from ${min} to ${max}.`);
    return null;
  }
  return intInRange(errors, 'Ghost 👍 minutes', value, SETTINGS_LIMITS.ghostVoteMinutes);
}

/** 🔔 Bell offset (protocol.js BELL OFFSET): whole seconds, a real number (not text, null or true). */
function bellOffsetSeconds(errors, value) {
  const [min, max] = SETTINGS_LIMITS.bellOffsetSeconds;
  if (typeof value !== 'number') {
    errors.push(`The bell offset must be a whole number of seconds from ${min} to ${max}.`);
    return null;
  }
  return intInRange(errors, 'The bell offset (seconds)', value, SETTINGS_LIMITS.bellOffsetSeconds);
}

/**
 * @param {unknown} input
 * @param {{ testAiOff?: boolean }} [o] testAiOff: the local-only TEST_AI_OFF=on (.dev.vars, browser
 *   tests): aiCheck / blockUnknownSongs are read from `input` again. Never set in production.
 * @returns {{ ok: true, settings: typeof DEFAULT_SETTINGS } | { ok: false, errors: string[] }}
 */
export function validateSettings(input, { testAiOff = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['Settings must be an object.'] };
  const errors = [];
  const pick = (key) => (input[key] === undefined ? DEFAULT_SETTINGS[key] : input[key]);
  const settings = {
    maxWaitingPerStudent: intInRange(errors, 'Songs waiting per student', pick('maxWaitingPerStudent'), SETTINGS_LIMITS.maxWaitingPerStudent),
    removeAtScore: intInRange(errors, 'Remove at score', pick('removeAtScore'), SETTINGS_LIMITS.removeAtScore),
    // Locked on (Dalton, 2026-10-16: no way to turn off the AI review; liability). Saved false reads as true.
    blockUnknownSongs: testAiOff ? bool(errors, 'Songs the checker does not know', pick('blockUnknownSongs')) : true,
    aiCheck: testAiOff ? bool(errors, 'AI song check', pick('aiCheck')) : true,
    blocklist: cleanBlocklist(errors, pick('blocklist')),
    maxSongMinutes: maxSongMinutes(errors, pick('maxSongMinutes')),
    instrumentalsOnly: bool(errors, 'Instrumentals only', pick('instrumentalsOnly')),
    cleanupMinutes: intInRange(errors, 'Cleanup minutes before class ends', pick('cleanupMinutes'), SETTINGS_LIMITS.cleanupMinutes),
    bellSchedule: cleanBellSchedule(errors, pick('bellSchedule')),
    startingCredits: startingCredits(errors, pick('startingCredits')),
    allowJump: bool(errors, 'Priority jump', pick('allowJump')),
    coupons: bool(errors, 'Coupons', pick('coupons')),
    periodMinutes: intInRange(errors, 'Class period length (minutes)', pick('periodMinutes'), SETTINGS_LIMITS.periodMinutes),
    showFavorites: bool(errors, 'Class favorites', pick('showFavorites')),
    noBackToBackArtist: bool(errors, 'No back-to-back artist', pick('noBackToBackArtist')),
    oneSongPerArtist: bool(errors, 'One song per artist', pick('oneSongPerArtist')),
    cooldownDays: cooldownDays(errors, pick('cooldownDays')),
    recapMusic: bool(errors, 'Recap music and sounds', pick('recapMusic')),
    recapVolume: intInRange(errors, 'Recap music volume (percent)', pick('recapVolume'), SETTINGS_LIMITS.recapVolume),
    backToWork: bool(errors, 'Back-to-work screen', pick('backToWork')),
    backToWorkMinutes: backToWorkMinutes(errors, pick('backToWorkMinutes')),
    bellOffsetSeconds: bellOffsetSeconds(errors, pick('bellOffsetSeconds')),
    artCheck: bool(errors, 'Album art check', pick('artCheck')),
    hideAllArt: bool(errors, 'Hide all album art', pick('hideAllArt')),
    maxDownvotes: maxDownvotes(errors, pick('maxDownvotes')),
    upvotes: bool(errors, '👍 votes', pick('upvotes')),
    maxUpvotes: maxUpvotes(errors, pick('maxUpvotes')),
    hideUpvoteCounts: bool(errors, 'Hide 👍 counts from students', pick('hideUpvoteCounts')),
    scoreFloor: bool(errors, 'Scores never go below 0', pick('scoreFloor')),
    downvoteMode: downvoteMode(errors, pick('downvoteMode')),
    ghostVote: bool(errors, 'Ghost 👍', pick('ghostVote')),
    ghostVoteMinutes: ghostVoteMinutes(errors, pick('ghostVoteMinutes')),
    hideVoteCounts: bool(errors, 'Hide vote counts from students', pick('hideVoteCounts')),
  };
  return errors.length ? { ok: false, errors } : { ok: true, settings };
}
