// 📚 Back to work (protocol.js BACK TO WORK, shared/backtowork.js): the rest after a SUGGESTION only
// (Dalton, 2026-10-08: votes and jumps never start it, votes are never refused); refusals; the
// teacher never rests; Let back in; off clears it; the snapshots; and the room's gate (src/room.js)
// runs before anything is checked or charged, for suggest and jump only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as protocol from '../shared/protocol.js';
import { DEFAULT_SETTINGS, TEACHER_DEVICE } from '../shared/protocol.js';
import {
  backToWorkMessage, backToWorkOn, clearRests, clockLeft, letBackIn, restMs, restOf, restRefusal, restView, startRest,
} from '../shared/backtowork.js';
import { kickDevice, migrateRoomState, newRoomState, snapshotFor } from '../shared/queue.js';
import { validateSettings } from '../shared/settings.js';

const A = 'deviceAAAAAAAAAAAAAA';
const B = 'deviceBBBBBBBBBBBBBB';
const T0 = 1_000_000;
const MIN = 60_000;

function room(settings = {}) {
  const s = newRoomState('0123456789abcdef0123456789abcdef', { ...DEFAULT_SETTINGS, backToWorkMinutes: 3, ...settings }, T0); // the tests' math uses 3
  s.students[A] = { nick: 'Ana', joinedAt: 1 };
  s.students[B] = { nick: 'Ben', joinedAt: 1 };
  return s;
}

test('defaults: on, 5 minutes; settings take Off and 1/2/3/5/10 only', () => {
  assert.equal(DEFAULT_SETTINGS.backToWork, true);
  assert.equal(DEFAULT_SETTINGS.backToWorkMinutes, 5);
  assert.equal(restMs(DEFAULT_SETTINGS), 5 * MIN);
  for (const m of [1, 2, 3, 5, 10]) assert.equal(validateSettings({ backToWorkMinutes: m }).ok, true);
  for (const m of [0, 4, 15, '3', null]) assert.equal(validateSettings({ backToWorkMinutes: m }).ok, false);
  assert.equal(validateSettings({ backToWork: 'yes' }).ok, false);
  assert.equal(validateSettings({ backToWork: false }).settings.backToWork, false);
  assert.equal(validateSettings({}).settings.backToWork, true);
});

test('a suggestion: the rest starts at once (no grace), for the teacher\'s minutes', () => {
  const s = room({ backToWorkMinutes: 5 });
  startRest(s, A, T0);
  assert.deepEqual(s.rest[A], { from: T0, grace: T0, until: T0 + 5 * MIN });
  assert.deepEqual(restRefusal(s, A, T0 + 1), { left: 5 * MIN - 1 });
  assert.equal(restRefusal(s, B, T0 + 1), null, 'another student is not resting');
  assert.equal(restRefusal(s, A, T0 + 5 * MIN), null, 'over at until');
});

test('no vote grace any more: the constant is gone; a running rest is never moved', () => {
  assert.equal(protocol.BACK_TO_WORK_GRACE_MS, undefined);
  const s = room();
  startRest(s, A, T0);
  startRest(s, A, T0 + 5_000);
  assert.deepEqual(s.rest[A], { from: T0, grace: T0, until: T0 + 3 * MIN }, 'the same rest');
  // A rest saved before this change with a vote grace: a suggestion ends the grace, not the rest.
  s.rest[B] = { from: T0, grace: T0 + 20_000, until: T0 + 3 * MIN };
  assert.equal(restRefusal(s, B, T0 + 1_000), null, 'inside an old grace');
  startRest(s, B, T0 + 3_000);
  assert.deepEqual(s.rest[B], { from: T0, grace: T0 + 3_000, until: T0 + 3 * MIN });
});

test('after a rest ends, the next suggestion starts a new one; expired rests are dropped', () => {
  const s = room({ backToWorkMinutes: 1 });
  startRest(s, A, T0);
  startRest(s, B, T0);
  const later = T0 + MIN + 1;
  startRest(s, A, later);
  assert.deepEqual(s.rest[A], { from: later, grace: later, until: later + MIN });
  assert.equal(s.rest[B], undefined, 'B\'s old rest was tidied away');
});

test('the teacher never rests; off: nobody rests and nothing is refused', () => {
  const s = room();
  assert.equal(startRest(s, TEACHER_DEVICE, T0), null);
  assert.equal(restRefusal(s, TEACHER_DEVICE, T0 + 1), null);
  assert.equal(s.rest[TEACHER_DEVICE], undefined);
  const off = room({ backToWork: false });
  assert.equal(backToWorkOn(off), false);
  assert.equal(startRest(off, A, T0), null);
  assert.equal(restRefusal(off, A, T0 + 1), null);
  // Turned off while resting: the room clears every rest (and the rule reads off anyway).
  const s2 = room();
  startRest(s2, A, T0);
  s2.settings.backToWork = false;
  assert.equal(restRefusal(s2, A, T0 + 1), null);
  clearRests(s2);
  assert.deepEqual(s2.rest, {});
});

test('Let back in ends one student\'s rest; kick removes it; rename keeps it (the device rests)', () => {
  const s = room();
  startRest(s, A, T0);
  startRest(s, B, T0);
  assert.equal(letBackIn(s, A), true);
  assert.equal(restRefusal(s, A, T0 + 1), null);
  assert.equal(letBackIn(s, A), false, 'nothing to clear');
  assert.ok(restRefusal(s, B, T0 + 1));
  kickDevice(s, B);
  assert.equal(s.rest[B], undefined);
});

test('the refusal words: "📚 Back to work! You can suggest again in 2:15."', () => {
  assert.equal(clockLeft(135_000), '2:15');
  assert.equal(clockLeft(134_001), '2:15', 'rounded up');
  assert.equal(clockLeft(0), '0:00');
  assert.equal(clockLeft(-5), '0:00');
  assert.equal(backToWorkMessage(135_000), '📚 Back to work! You can suggest again in 2:15.');
});

test('snapshots: you.restUntil / restLeft for the student, students[].restUntil for the host', () => {
  const s = room();
  startRest(s, A, T0);
  const you = snapshotFor(s, A, { now: T0 + 1_000 }).you;
  assert.equal(you.restUntil, T0 + 3 * MIN);
  assert.equal(you.restGraceUntil, T0);
  assert.equal(you.restLeft, 3 * MIN - 1_000);
  assert.equal(you.restGraceLeft, 0);
  assert.equal(snapshotFor(s, B, { now: T0 }).you.restUntil, null);
  const host = snapshotFor(s, null, { now: T0 + 1_000 });
  assert.equal(host.students.find((x) => x.device === A).restUntil, T0 + 3 * MIN);
  assert.equal(host.students.find((x) => x.device === A).restLeft, 3 * MIN - 1_000);
  assert.equal(host.students.find((x) => x.device === B).restUntil, null);
  assert.deepEqual(restView(s, A, T0 + 3 * MIN), { restUntil: null, restGraceUntil: null, restLeft: 0, restGraceLeft: 0 }, 'over');
  assert.equal(restOf(s, A, T0 + 3 * MIN), null);
});

test('rooms saved before back to work: on, 3 minutes, no rests', () => {
  const old = room();
  delete old.rest;
  for (const k of ['backToWork', 'backToWorkMinutes', 'recapMusic', 'recapVolume']) delete old.settings[k];
  migrateRoomState(old);
  assert.deepEqual(old.rest, {});
  assert.equal(old.settings.backToWork, true);
  assert.equal(old.settings.backToWorkMinutes, 5);
  assert.equal(old.settings.recapMusic, true);
  assert.equal(old.settings.recapVolume, 50);
});

test('the room: the gate runs first for suggest and jump only (before the filter, credits and rate limits); votes never rest', () => {
  const src = readFileSync(new URL('../src/room.js', import.meta.url), 'utf8');
  const student = src.slice(src.indexOf('  async studentMessage(ws, a, msg)'), src.indexOf('  async jump(ws, a, id)'));
  const gate = student.indexOf('restRefusal(this.room, a.device)');
  assert.ok(gate > 0, 'studentMessage checks the rest');
  for (const call of ['this.suggest(', 'this.jump(']) assert.ok(student.indexOf(call) > gate, `${call} comes after the gate`);
  assert.match(student, /if \(msg\.t === 'suggest' \|\| msg\.t === 'jump'\) \{\s*const rest = restRefusal/, 'the gate is for suggest and jump only');
  assert.match(student, /reason: 'back_to_work'/);
  assert.doesNotMatch(student, /error: 'back_to_work'/, 'a vote is never refused by a rest');
  assert.doesNotMatch(student, /startRest/, 'a vote never starts a rest');
  const jump = src.slice(src.indexOf('  async jump(ws, a, id)'), src.indexOf('  async jump(ws, a, id)') + 900);
  assert.doesNotMatch(jump, /startRest/, 'a jump never starts a rest');
  // A suggestion rests only once it joined the queue or Needs a look, and never the teacher.
  const suggest = src.slice(src.indexOf('  async suggest(ws, a, raw)'), src.indexOf('  async hostMessage(ws, msg)'));
  assert.equal((suggest.match(/if \(!teacher\) startRest\(this\.room, a\.device\)/g) ?? []).length, 2);
  assert.ok(suggest.indexOf('startRest(this.room, a.device)') > suggest.indexOf('addToReview('));
  // The host's own picks and votes never pass the gate; Let back in is host only.
  const host = src.slice(src.indexOf('  async hostMessage(ws, msg)'));
  assert.doesNotMatch(host.slice(0, host.indexOf("case 'letBackIn'")), /restRefusal/);
  assert.match(host, /case 'letBackIn': \{[\s\S]*?letBackIn\(room, device\)/);
  assert.doesNotMatch(student, /letBackIn/);
});
