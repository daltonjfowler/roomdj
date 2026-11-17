// Classroom controls (shared/classroom.js): ⭐ passes, ⏸ timeouts, 🚪 the join door.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PASS_MAX, TIMEOUT_CLASS, addKnock, answerKnock, givePass, knockStatus, passesOf, setTimeoutFor, timeoutLeft, timeoutRefusal, usePass } from '../shared/classroom.js';
import { TEACHER_DEVICE } from '../shared/protocol.js';

const room = () => ({ students: { ava: { nick: 'Ava' }, ben: { nick: 'Ben' } }, kicked: [], admitted: ['ava', 'ben'], queue: [], until: 10_000_000 });

test('⭐ a pass is given, capped, and used on the next song that gets in (jumped, after earlier jumps)', () => {
  const s = room();
  assert.deepEqual(givePass(s, 'ava'), { ok: true, passes: 1 });
  for (let i = 1; i < PASS_MAX; i++) givePass(s, 'ava');
  assert.deepEqual(givePass(s, 'ava'), { ok: false, reason: 'max' });
  assert.deepEqual(givePass(s, 'nobody'), { ok: false, reason: 'gone' });
  assert.deepEqual(givePass(s, TEACHER_DEVICE), { ok: false, reason: 'gone' });
  s.queue.push({ id: 'x', device: 'ben', jumped: { at: 5000 } });
  const item = { id: 'a', device: 'ava', by: 'Ava' };
  assert.equal(usePass(s, item, 1000), true);
  assert.equal(item.jumped.pass, true);
  assert.ok(item.jumped.at > 5000, 'after the song jumped before it');
  assert.equal(passesOf(s, 'ava'), PASS_MAX - 1);
  assert.equal(usePass(s, { id: 'b', device: 'ben' }), false, 'no pass, nothing changes');
  assert.equal(usePass(s, { id: 't', device: TEACHER_DEVICE }), false);
});

test('⏸ a timeout blocks until it ends; class = until class ends; 0 ends it; never the teacher', () => {
  const s = room();
  assert.equal(setTimeoutFor(s, 'ava', 10, 0).ok, true);
  assert.equal(timeoutLeft(s, 'ava', 60_000), 9 * 60_000);
  assert.ok(timeoutRefusal(s, 'ava', 60_000));
  assert.equal(timeoutRefusal(s, 'ava', 10 * 60_000), null, 'over at the exact moment');
  assert.equal(setTimeoutFor(s, 'ben', TIMEOUT_CLASS, 0).left, 10_000_000);
  assert.equal(setTimeoutFor(s, 'ben', 0).left, 0);
  assert.equal(timeoutRefusal(s, 'ben', 1), null);
  assert.deepEqual(setTimeoutFor(s, 'ava', 7), { ok: false, reason: 'bad' });
  assert.equal(timeoutRefusal(s, TEACHER_DEVICE), null);
});

test('🚪 knocks: let in = admitted, turned away = kicked, each once', () => {
  const s = room();
  addKnock(s, 'new1', 1);
  addKnock(s, 'new1', 2);
  addKnock(s, 'new2', 3);
  assert.equal(s.knocks.length, 2);
  assert.equal(knockStatus(s, 'new1'), 'waiting');
  assert.equal(answerKnock(s, 'new1', true), true);
  assert.equal(knockStatus(s, 'new1'), 'in');
  assert.equal(answerKnock(s, 'new2', false), true);
  assert.equal(knockStatus(s, 'new2'), 'no');
  assert.equal(answerKnock(s, 'new2', true), false, 'no longer knocking');
  assert.equal(knockStatus(s, 'stranger'), 'gone');
});
