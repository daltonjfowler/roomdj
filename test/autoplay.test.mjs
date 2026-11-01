import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTOPLAY_GAP_MS, autoplayDue, autoplayPicks, autoplayShelves, shuffle } from '../shared/autoplay.js';
import { DEFAULT_SETTINGS, byLabel } from '../shared/protocol.js';
import { newRoomState, migrateRoomState } from '../shared/queue.js';
import { validateSettings } from '../shared/settings.js';

const room = (settings = {}) => newRoomState('r', { ...DEFAULT_SETTINGS, autoplay: true, ...settings }, 0, 10 ** 13);

test('🎲 autoplay is due only when it is on, nothing plays, the queue is empty and the gap has passed', () => {
  const s = room();
  assert.equal(autoplayDue(s, 0, AUTOPLAY_GAP_MS), true);
  assert.equal(autoplayDue(s, 1, AUTOPLAY_GAP_MS), false); // asked just now
  assert.equal(autoplayDue(room({ autoplay: false }), 0, AUTOPLAY_GAP_MS), false);
  assert.equal(autoplayDue({ ...s, cleanup: true }, 0, AUTOPLAY_GAP_MS), false);
  assert.equal(autoplayDue({ ...s, nowPlaying: { id: 's1' } }, 0, AUTOPLAY_GAP_MS), false);
  assert.equal(autoplayDue({ ...s, queue: [{ id: 's1' }] }, 0, AUTOPLAY_GAP_MS), false);
});

test('autoplay picks from the ticked lists only (Gospel only while its switch is on), never a song waiting or played', () => {
  assert.deepEqual(autoplayShelves({ autoplayShelves: ['rock', 'gospel', 'pop', 'nope'] }), ['pop', 'rock']);
  assert.deepEqual(autoplayShelves({ autoplayShelves: ['gospel'], gospelShelf: true }), ['gospel']);
  const s = room();
  s.queue = [{ id: 's1', song: { id: 'it:1', title: 'A', artist: 'X' } }];
  s.played = ['it:2'];
  const picks = autoplayPicks(s, [{ id: 'it:1', title: 'A', artist: 'X' }, { id: 'it:2', title: 'B', artist: 'Y' }, { id: 'it:3', title: 'C', artist: 'Z' }]);
  assert.deepEqual(picks.map((x) => x.id), ['it:3']);
  assert.deepEqual(shuffle([1, 2, 3], () => 0), [2, 3, 1]);
});

test('autoplay settings: off by default, lists must be real lists, old rooms read off; its picks say 🎲 RoomDJ', () => {
  assert.equal(DEFAULT_SETTINGS.autoplay, false);
  const ok = validateSettings({ autoplay: true, autoplayShelves: ['pop', 'pop', 'rock'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.settings.autoplayShelves, ['pop', 'rock']);
  assert.equal(validateSettings({ autoplayShelves: ['nope'] }).ok, false);
  assert.equal(validateSettings({ autoplayShelves: 'pop' }).ok, false);
  const old = room();
  delete old.settings.autoplay;
  delete old.settings.autoplayShelves;
  migrateRoomState(old);
  assert.equal(old.settings.autoplay, false);
  assert.deepEqual(old.settings.autoplayShelves, DEFAULT_SETTINGS.autoplayShelves);
  assert.equal(byLabel({ by: 'RoomDJ', teacher: true, autoplay: true }), '🎲 RoomDJ');
  assert.equal(byLabel({ by: 'Ms Rivera', teacher: true }), '🍎 Ms Rivera');
});
