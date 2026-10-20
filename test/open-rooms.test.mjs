// The board's sign-in (protocol.js BOARD SIGN-IN; src/open-rooms.js): each teacher's KV signpost of
// open rooms. Added on open, refreshed on reclaim/times, removed on close, nothing past its until.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KV_OPEN_ROOMS, addOpenRoom, liveOpenRooms, openRoomsTtl, readOpenRooms, removeOpenRoom, updateOpenRooms,
} from '../src/open-rooms.js';
import { OPEN_ROOMS_MAX } from '../shared/protocol.js';
import { teacherKvKey } from '../src/teacher-kv.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

test('add: the newest room first, the same room only once', () => {
  let list = addOpenRoom([], { room: A, until: NOW + HOUR, at: NOW - 10 }, NOW);
  list = addOpenRoom(list, { room: B, until: NOW + 2 * HOUR, at: NOW }, NOW);
  assert.deepEqual(list.map((e) => e.room), [B, A]);
  list = addOpenRoom(list, { room: A, until: NOW + 3 * HOUR, at: NOW + 5 }, NOW);
  assert.deepEqual(list.map((e) => e.room), [A, B], 'opened again = newest again');
  assert.equal(list.filter((e) => e.room === A).length, 1);
  assert.equal(list[0].until, NOW + 3 * HOUR);
});

test('add with keepAt (reclaim, times changed): the until moves, the order does not', () => {
  let list = addOpenRoom([], { room: A, until: NOW + HOUR, at: NOW - 10 }, NOW);
  list = addOpenRoom(list, { room: B, until: NOW + HOUR, at: NOW }, NOW);
  list = addOpenRoom(list, { room: A, until: NOW + 5 * HOUR, at: NOW + 99 }, NOW, { keepAt: true });
  assert.deepEqual(list.map((e) => [e.room, e.until, e.at]), [[B, NOW + HOUR, NOW], [A, NOW + 5 * HOUR, NOW - 10]]);
  const fresh = addOpenRoom([], { room: C, until: NOW + HOUR, at: NOW }, NOW, { keepAt: true });
  assert.deepEqual(fresh, [{ room: C, until: NOW + HOUR, at: NOW }], 'keepAt on a room not listed yet adds it');
});

test('remove: the room goes, the others stay', () => {
  const list = [{ room: A, until: NOW + HOUR, at: NOW }, { room: B, until: NOW + HOUR, at: NOW - 1 }];
  assert.deepEqual(removeOpenRoom(list, A, NOW).map((e) => e.room), [B]);
  assert.deepEqual(removeOpenRoom(list, C, NOW).map((e) => e.room), [A, B], 'not there: unchanged');
  assert.deepEqual(removeOpenRoom([{ room: A, until: NOW + HOUR, at: NOW }], A, NOW), []);
});

test('until: a room past its until is dropped (stale)', () => {
  const list = [
    { room: A, until: NOW - 1, at: NOW - HOUR },
    { room: B, until: NOW, at: NOW - 2 },
    { room: C, until: NOW + 1, at: NOW - 3 },
  ];
  assert.deepEqual(liveOpenRooms(list, NOW).map((e) => e.room), [C]);
  assert.deepEqual(addOpenRoom(list, { room: A, until: NOW + HOUR, at: NOW }, NOW).map((e) => e.room), [A, C]);
});

test('bad entries are dropped, never trusted', () => {
  for (const bad of [null, 'x', 5, {}, { room: 'nope', until: NOW + HOUR, at: NOW }, { room: A.toUpperCase(), until: NOW + HOUR, at: NOW },
    { room: A, until: 'later', at: NOW }, { room: A, until: NOW + HOUR }, { room: `${A}0`, until: NOW + HOUR, at: NOW }]) {
    assert.deepEqual(liveOpenRooms([bad], NOW), [], JSON.stringify(bad));
  }
  assert.deepEqual(liveOpenRooms(null, NOW), []);
  assert.deepEqual(liveOpenRooms({ room: A }, NOW), []);
  const extra = liveOpenRooms([{ room: A, until: NOW + HOUR, at: NOW, secret: 'x' }], NOW);
  assert.deepEqual(extra, [{ room: A, until: NOW + HOUR, at: NOW }], 'only room, until, at are kept');
});

test(`at most ${OPEN_ROOMS_MAX} rooms (the newest)`, () => {
  let list = [];
  for (let i = 0; i < OPEN_ROOMS_MAX + 4; i++) list = addOpenRoom(list, { room: i.toString(16).padStart(32, '0'), until: NOW + HOUR, at: NOW + i }, NOW);
  assert.equal(list.length, OPEN_ROOMS_MAX);
  assert.equal(list[0].room, (OPEN_ROOMS_MAX + 3).toString(16).padStart(32, '0'));
});

test('KV time to live: until the latest until, at least 60 s', () => {
  assert.equal(openRoomsTtl([{ room: A, until: NOW + HOUR, at: NOW }, { room: B, until: NOW + 2 * HOUR, at: NOW }], NOW), 2 * 3600 + 60);
  assert.equal(openRoomsTtl([{ room: A, until: NOW + 1000, at: NOW }], NOW), 61);
  assert.equal(openRoomsTtl([], NOW), 60);
});

/** A tiny KV: get(key, 'json'), put(key, value, opts), delete(key). */
function fakeKv() {
  const data = new Map();
  return {
    data,
    async get(k) { return data.has(k) ? JSON.parse(data.get(k).value) : null; },
    async put(k, value, opts) { data.set(k, { value, opts }); },
    async delete(k) { data.delete(k); },
  };
}

test('KV: per teacher profile (the legacy teacher on the plain key), deleted when empty', async () => {
  const env = { CLASS_KV: fakeKv() };
  const t1 = { id: 'teacher-1', name: 'Teacher 1', legacy: true };
  const t2 = { id: 'teacher-2', name: 'Teacher 2', legacy: false };
  const later = Date.now() + HOUR;
  await updateOpenRooms(env, t1, (l) => addOpenRoom(l, { room: A, until: later }));
  await updateOpenRooms(env, t2, (l) => addOpenRoom(l, { room: B, until: later }));
  assert.ok(env.CLASS_KV.data.has(KV_OPEN_ROOMS), 'Teacher 1 (legacy): the plain key');
  assert.equal(teacherKvKey(KV_OPEN_ROOMS, t2), 'p:teacher-2:openRooms');
  assert.ok(env.CLASS_KV.data.has('p:teacher-2:openRooms'));
  assert.ok(env.CLASS_KV.data.get(KV_OPEN_ROOMS).opts.expirationTtl >= 3600);
  assert.deepEqual((await readOpenRooms(env, t1)).map((e) => e.room), [A]);
  assert.deepEqual((await readOpenRooms(env, t2)).map((e) => e.room), [B], 'never another teacher\'s rooms');
  assert.deepEqual((await readOpenRooms(env, null)).map((e) => e.room), [A], 'a room from before profiles = legacy');
  await updateOpenRooms(env, t1, (l) => removeOpenRoom(l, A));
  assert.ok(!env.CLASS_KV.data.has(KV_OPEN_ROOMS), 'empty: the key is deleted');
  assert.deepEqual(await readOpenRooms(env, t1), []);
  assert.deepEqual((await readOpenRooms(env, t2)).map((e) => e.room), [B]);
});

test('KV trouble never throws (a board just does not find the room)', async () => {
  const env = { CLASS_KV: { get: async () => { throw new Error('down'); }, put: async () => { throw new Error('down'); }, delete: async () => {} } };
  const errors = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await readOpenRooms(env, null), []);
    await updateOpenRooms(env, null, (l) => addOpenRoom(l, { room: A, until: Date.now() + HOUR }));
  } finally {
    console.error = errors;
  }
  assert.deepEqual(await readOpenRooms({}, null), [], 'no KV bound');
});
