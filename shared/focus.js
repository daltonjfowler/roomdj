// 🎯 Focus time (protocol.js FOCUS; Dalton, 2026-11-01: "lock out all students for 5 minute
// button"): one tap on the teacher page pauses every student's suggestions, jumps and votes for
// FOCUS_MINUTES; the music keeps playing. It ends on its own (pages count down from focusLeft, the
// server checks the time on every message, so no alarm is needed) or when the teacher ends it.
// The teacher (TEACHER_DEVICE) is never held. Pure functions on the room state (RoomState.focusUntil,
// ms or null), shared by the Room and the Node tests.

import { TEACHER_DEVICE } from './protocol.js';

export const FOCUS_MINUTES = 5;

/** ms left of focus time (0 = none). */
export function focusLeft(state, now = Date.now()) {
  const until = state?.focusUntil;
  return Number.isSafeInteger(until) && until > now ? until - now : 0;
}

/** Start focus time (on: true) for FOCUS_MINUTES from now, or end it (on: false). Returns ms left. */
export function setFocus(state, on, now = Date.now()) {
  state.focusUntil = on === true ? now + FOCUS_MINUTES * 60_000 : null;
  return focusLeft(state, now);
}

/** Should this device's suggest, jump or vote be refused now? null, or { left } (ms). */
export function focusRefusal(state, device, now = Date.now()) {
  if (device === TEACHER_DEVICE) return null;
  const left = focusLeft(state, now);
  return left > 0 ? { left } : null;
}

export function focusMessage(left) {
  const mins = Math.max(1, Math.ceil(left / 60_000));
  return `🎯 Focus time! Song picks and votes are back in ${mins} minute${mins === 1 ? '' : 's'}.`;
}
