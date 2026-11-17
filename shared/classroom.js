// Classroom controls (Dalton, 2026-11-16; protocol.js PASSES, TIMEOUTS, JOIN DOOR). Pure functions on the room
// state, shared by the Room, the pages and the Node tests.
//   ⭐ Skip-the-line pass: the teacher gives a student a pass (RoomState.passes[device], at most PASS_MAX); the
//      next song of theirs that gets into the queue is jumped (it plays after the teacher's pushed songs and the
//      songs jumped before it, before every other song), and the pass is used.
//   ⏸ Time out: the teacher pauses one student (RoomState.timeouts[device] = until, ms): no suggest, jump or vote
//      until then (refused before anything is checked or charged). TIMEOUT_CLASS = until the room's class end.
//   🚪 Join door: while RoomState.joinClosed, a device that is not admitted yet only knocks (RoomState.knocks);
//      the teacher lets it in or turns it away (turned away = kicked: it can never join this room). Every
//      browser or private tab is a new device, so this is what stops one student joining several times.

import { TEACHER_DEVICE } from './protocol.js';

export const PASS_MAX = 3;
export const TIMEOUT_MINUTES = Object.freeze([5, 10, 15]);
export const TIMEOUT_CLASS = 'class';
export const KNOCKS_MAX = 30;

// ---- ⭐ passes ----

/** Passes this device holds (0 when none). */
export const passesOf = (state, device) => {
  const n = state?.passes?.[device];
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/** The teacher gives one pass. → { ok: true, passes } | { ok: false, reason: 'gone' | 'max' } */
export function givePass(state, device) {
  if (device === TEACHER_DEVICE || !Object.hasOwn(state.students ?? {}, device) || (state.kicked ?? []).includes(device)) return { ok: false, reason: 'gone' };
  const n = passesOf(state, device);
  if (n >= PASS_MAX) return { ok: false, reason: 'max' };
  state.passes ??= {};
  state.passes[device] = n + 1;
  return { ok: true, passes: n + 1 };
}

/**
 * A song of this item's student just got into the queue: if they hold a pass, it is used and the song is
 * jumped (after the songs jumped before it). Call before sortQueue. Returns true when a pass was used.
 */
export function usePass(state, item, now = Date.now()) {
  const device = item?.device;
  if (!device || device === TEACHER_DEVICE || item.jumped || item.teacher) return false;
  const n = passesOf(state, device);
  if (!n) return false;
  const last = Math.max(0, ...(state.queue ?? []).map((i) => i.jumped?.at ?? 0));
  item.jumped = { by: item.by ?? '', device, at: Math.max(now, last + 1), pass: true };
  if (n > 1) state.passes[device] = n - 1;
  else delete state.passes[device];
  return true;
}

// ---- ⏸ timeouts ----

/** ms left of this device's timeout (0 = none). */
export function timeoutLeft(state, device, now = Date.now()) {
  const until = state?.timeouts?.[device];
  return Number.isSafeInteger(until) && until > now ? until - now : 0;
}

/**
 * Start a timeout (minutes: one of TIMEOUT_MINUTES, or TIMEOUT_CLASS = until class ends) or end it (0).
 * → { ok: true, left } | { ok: false, reason: 'gone' | 'bad' }
 */
export function setTimeoutFor(state, device, minutes, now = Date.now()) {
  if (device === TEACHER_DEVICE || !Object.hasOwn(state.students ?? {}, device)) return { ok: false, reason: 'gone' };
  state.timeouts ??= {};
  if (minutes === 0) {
    delete state.timeouts[device];
    return { ok: true, left: 0 };
  }
  let until;
  if (minutes === TIMEOUT_CLASS) until = Number.isSafeInteger(state.until) ? state.until : now + 60 * 60_000;
  else if (TIMEOUT_MINUTES.includes(minutes)) until = now + minutes * 60_000;
  else return { ok: false, reason: 'bad' };
  state.timeouts[device] = until;
  return { ok: true, left: timeoutLeft(state, device, now) };
}

/** Should this device's suggest, jump or vote be refused now? null, or { left } (ms). */
export function timeoutRefusal(state, device, now = Date.now()) {
  if (device === TEACHER_DEVICE) return null;
  const left = timeoutLeft(state, device, now);
  return left > 0 ? { left } : null;
}

export function timeoutMessage(left) {
  const mins = Math.max(1, Math.ceil(left / 60_000));
  return `⏸ Your teacher paused you. Song picks and votes are back in ${mins} minute${mins === 1 ? '' : 's'}.`;
}

// ---- 🚪 join door ----

/**
 * 🚪 Close joining automatically (settings.autoCloseJoinMinutes, minutes after the room opened; Dalton 2026-11-16):
 * when it is due, or null (off, already done, or the teacher used the switch: their choice wins from then on).
 */
export function joinClosesAt(state) {
  const m = state?.settings?.autoCloseJoinMinutes;
  if (!Number.isInteger(m) || m <= 0 || state.joinAutoDone === true || state.joinClosed === true || !Number.isSafeInteger(state.createdAt)) return null;
  return state.createdAt + m * 60_000;
}

/** Is joining closed now (the switch, or the automatic close being due)? */
export function joinClosedNow(state, now = Date.now()) {
  if (state?.joinClosed === true) return true;
  const at = joinClosesAt(state);
  return at !== null && now >= at;
}

/** Make a due automatic close real (once). Returns true when it closed joining now. */
export function applyAutoClose(state, now = Date.now()) {
  const at = joinClosesAt(state);
  if (at === null || now < at) return false;
  state.joinClosed = true;
  state.joinAutoDone = true;
  return true;
}

/** The teacher's switch: open or closed, and the automatic close is done (their choice wins). */
export function setJoinClosed(state, on) {
  state.joinClosed = on === true;
  state.joinAutoDone = true;
}

/** A short tag the teacher can tell knocks apart by (the device id's last 4 letters). */
export const deviceTag = (device) => String(device ?? '').slice(-4).toUpperCase();

/** A device that is not admitted asks to join while joining is closed. Returns the knock list. */
export function addKnock(state, device, now = Date.now()) {
  state.knocks ??= [];
  if (!state.knocks.some((k) => k.device === device)) {
    state.knocks.push({ device, at: now });
    if (state.knocks.length > KNOCKS_MAX) state.knocks.splice(0, state.knocks.length - KNOCKS_MAX);
  }
  return state.knocks;
}

/** Let a knocking device in (it is admitted) or turn it away (kicked). → true when it was knocking. */
export function answerKnock(state, device, letIn) {
  const before = (state.knocks ?? []).length;
  state.knocks = (state.knocks ?? []).filter((k) => k.device !== device);
  if (state.knocks.length === before) return false;
  if (letIn) {
    state.admitted ??= [];
    if (!state.admitted.includes(device)) state.admitted.push(device);
  } else if (!(state.kicked ??= []).includes(device)) state.kicked.push(device);
  return true;
}

/** What a knocking page learns when it checks: 'in' | 'no' | 'waiting' | 'gone' (its knock is not there). */
export function knockStatus(state, device) {
  if ((state.kicked ?? []).includes(device)) return 'no';
  if ((state.admitted ?? []).includes(device)) return 'in';
  return (state.knocks ?? []).some((k) => k.device === device) ? 'waiting' : 'gone';
}
