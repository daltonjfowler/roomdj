import test from 'node:test';
import assert from 'node:assert/strict';
import { FOCUS_MINUTES, focusLeft, focusMessage, focusRefusal, setFocus } from '../shared/focus.js';
import { newRoomState, snapshotFor } from '../shared/queue.js';
import { DEFAULT_SETTINGS, TEACHER_DEVICE } from '../shared/protocol.js';

test('🎯 focus time holds every student for FOCUS_MINUTES, never the teacher, and ends on its own', () => {
  const state = { focusUntil: null };
  assert.equal(focusRefusal(state, 'dev-1', 0), null);
  assert.equal(setFocus(state, true, 1000), FOCUS_MINUTES * 60_000);
  assert.deepEqual(focusRefusal(state, 'dev-1', 61_000), { left: FOCUS_MINUTES * 60_000 - 60_000 });
  assert.equal(focusRefusal(state, TEACHER_DEVICE, 61_000), null);
  assert.equal(focusRefusal(state, 'dev-1', 1000 + FOCUS_MINUTES * 60_000), null); // over: no alarm needed
  setFocus(state, true, 1000);
  setFocus(state, false, 2000);
  assert.equal(focusLeft(state, 2000), 0);
  assert.equal(focusMessage(61_000), '🎯 Focus time! Song picks and votes are back in 2 minutes.');
  assert.equal(focusMessage(60_000), '🎯 Focus time! Song picks and votes are back in 1 minute.');
});

test('the snapshot tells every page how long focus time has left (a room saved before it reads 0)', () => {
  const state = newRoomState('r', DEFAULT_SETTINGS, 0, 10 ** 13);
  assert.equal(state.focusUntil, null);
  assert.equal(snapshotFor(state, 'dev-1', { now: 5 }).focusLeft, 0);
  setFocus(state, true, 5);
  assert.equal(snapshotFor(state, 'dev-1', { now: 5 }).focusLeft, FOCUS_MINUTES * 60_000);
  delete state.focusUntil;
  assert.equal(snapshotFor(state, 'dev-1', { now: 5 }).focusLeft, 0);
});
