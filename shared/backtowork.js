// 📚 Back to work (protocol.js BACK TO WORK): after a student's SUCCESSFUL SUGGESTION (only that:
// Dalton, 2026-10-08), that device rests for the teacher's backToWorkMinutes. Votes and jumps never
// start a rest, and votes are never refused by one. Pure functions on the room state
// (RoomState.rest), so the Room and the Node tests share the rule; the student page shows the
// screen, the server refuses suggestions (and jumps) until it ends.
//
// RoomState.rest: { [device]: { from, grace, until } } (ms). `from`: the suggestion that started it;
// `grace`: always `from` now (there is no vote grace any more; kept so saved rooms and older pages
// read the same shape); `until`: when the rest is over.

import { BACK_TO_WORK_MINUTES, DEFAULT_SETTINGS, TEACHER_DEVICE } from './protocol.js';

/** Is the back-to-work screen on in this room? (saved settings and rooms without it: on). */
export function backToWorkOn(state) {
  return state?.settings?.backToWork !== false;
}

/** The rest length in ms (a bad value reads as the default minutes). */
export function restMs(settings) {
  const m = BACK_TO_WORK_MINUTES.includes(settings?.backToWorkMinutes) ? settings.backToWorkMinutes : DEFAULT_SETTINGS.backToWorkMinutes;
  return m * 60_000;
}

/** This device's rest while it lasts, else null (off, the teacher, none, or over). */
export function restOf(state, device, now = Date.now()) {
  if (!backToWorkOn(state) || device === TEACHER_DEVICE) return null;
  const r = state?.rest?.[device];
  return r && now < r.until ? r : null;
}

/**
 * Should this device's suggest (or jump) be refused now? null = go ahead; else { left } (ms until
 * the rest ends). Votes are never refused by a rest. A rest saved before this change may still have
 * a vote's grace: inside it the device may still act.
 */
export function restRefusal(state, device, now = Date.now()) {
  const r = restOf(state, device, now);
  if (!r || now < r.grace) return null;
  return { left: r.until - now };
}

/**
 * A successful suggestion (it joined the queue or waits in Needs a look) starts the device's rest
 * at once. A rest already running is never moved (and any old vote grace ends). Expired rests are
 * dropped on the way (the room state stays small). Returns the device's rest (or null).
 */
export function startRest(state, device, now = Date.now()) {
  if (!backToWorkOn(state) || device === TEACHER_DEVICE) return null;
  state.rest ??= {};
  for (const [d, r] of Object.entries(state.rest)) if (now >= r.until) delete state.rest[d];
  const r = state.rest[device];
  if (r) {
    r.grace = Math.min(r.grace, now);
    return r;
  }
  state.rest[device] = { from: now, grace: now, until: now + restMs(state.settings) };
  return state.rest[device];
}

/** The teacher's "Let back in": true when the device was resting. */
export function letBackIn(state, device) {
  if (!state?.rest?.[device]) return false;
  delete state.rest[device];
  return true;
}

/** Every rest goes (backToWork turned off). */
export function clearRests(state) {
  state.rest = {};
}

/** "2:15" for ms left (whole seconds, rounded up). */
export function clockLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The refusal's words (students read them). */
export function backToWorkMessage(left) {
  return `📚 Back to work! You can suggest again in ${clockLeft(left)}.`;
}

/** What a snapshot says about one device's rest (protocol.js State you.rest*). */
export function restView(state, device, now = Date.now()) {
  const r = restOf(state, device, now);
  if (!r) return { restUntil: null, restGraceUntil: null, restLeft: 0, restGraceLeft: 0 };
  return { restUntil: r.until, restGraceUntil: r.grace, restLeft: r.until - now, restGraceLeft: Math.max(0, r.grace - now) };
}
