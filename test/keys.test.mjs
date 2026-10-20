import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_KEYS, KEY_ACTIONS, keyLabel, keyName, loadKeys, matchKey, saveKeys, setKey, validKey } from '../shared/keys.js';

test('defaults: every action has its own key', () => {
  assert.equal(new Set(Object.values(DEFAULT_KEYS)).size, KEY_ACTIONS.length);
  assert.deepEqual({ ...DEFAULT_KEYS }, {
    playPause: 'Space', skip: 'n', big: 'b', full: 'f', lock: 'l', mute: 'm', volUp: 'ArrowUp', volDown: 'ArrowDown',
    filler: 'g', add: 'a', settings: 's', layout: 'e', help: '?',
  });
});

test('keyName: letters lower case, Space, arrows, punctuation; modifiers, Escape, Tab, Enter, F-keys never', () => {
  assert.equal(keyName({ key: 'N' }), 'n');
  assert.equal(keyName({ key: ' ' }), 'Space');
  assert.equal(keyName({ key: 'ArrowUp' }), 'ArrowUp');
  assert.equal(keyName({ key: '?' }), '?');
  assert.equal(keyName({ key: '7' }), '7');
  for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'Escape', 'Tab', 'Enter', 'Backspace', 'F5', 'Dead', 'Unidentified', '', undefined]) {
    assert.equal(keyName({ key: k }), null, String(k));
  }
  assert.equal(validKey('Space'), true);
  assert.equal(validKey('N'), false);
  assert.equal(validKey('Escape'), false);
  assert.equal(keyLabel('ArrowDown'), '↓');
  assert.equal(keyLabel('n'), 'N');
  assert.equal(keyLabel('Space'), 'Space');
});

test('matchKey: the action for a key; never with Ctrl, Alt or Meta (Shift is part of the character)', () => {
  assert.equal(matchKey(DEFAULT_KEYS, { key: 'n' }), 'skip');
  assert.equal(matchKey(DEFAULT_KEYS, { key: 'N', shiftKey: true }), 'skip');
  assert.equal(matchKey(DEFAULT_KEYS, { key: ' ' }), 'playPause');
  assert.equal(matchKey(DEFAULT_KEYS, { key: '?', shiftKey: true }), 'help');
  assert.equal(matchKey(DEFAULT_KEYS, { key: 'ArrowDown' }), 'volDown');
  assert.equal(matchKey(DEFAULT_KEYS, { key: 'n', ctrlKey: true }), null);
  assert.equal(matchKey(DEFAULT_KEYS, { key: 's', metaKey: true }), null);
  assert.equal(matchKey(DEFAULT_KEYS, { key: 'b', altKey: true }), null);
  assert.equal(matchKey(DEFAULT_KEYS, { key: 'z' }), null);
});

test('setKey: a new key; a duplicate or an unusable key is refused', () => {
  const r = setKey(DEFAULT_KEYS, 'skip', 'k');
  assert.equal(r.ok, true);
  assert.equal(r.keys.skip, 'k');
  assert.equal(DEFAULT_KEYS.skip, 'n'); // not changed in place
  assert.equal(matchKey(r.keys, { key: 'k' }), 'skip');
  assert.equal(matchKey(r.keys, { key: 'n' }), null);
  assert.deepEqual(setKey(DEFAULT_KEYS, 'skip', 'b'), { ok: false, error: 'taken', other: 'big' });
  assert.equal(setKey(DEFAULT_KEYS, 'skip', 'n').ok, true); // its own key again
  assert.equal(setKey(DEFAULT_KEYS, 'skip', 'Escape').error, 'bad');
  assert.equal(setKey(DEFAULT_KEYS, 'nope', 'k').error, 'unknown');
});

test('storage: only changes are saved; broken, unknown, bad or clashing entries fall back to defaults', () => {
  assert.equal(saveKeys(DEFAULT_KEYS), '');
  const mine = setKey(DEFAULT_KEYS, 'skip', 'k').keys;
  assert.equal(saveKeys(mine), '{"skip":"k"}');
  assert.deepEqual(loadKeys(saveKeys(mine)), mine);
  for (const text of [null, '', 'not json', '[]', '5', '{"skip":5}', '{"skip":"Escape"}', '{"skip":"N"}', '{"wat":"k"}']) {
    assert.deepEqual(loadKeys(text), { ...DEFAULT_KEYS }, String(text));
  }
  // Two saved actions on one key: the first keeps it, the second goes back to its default.
  assert.deepEqual(loadKeys('{"skip":"k","big":"k"}'), { ...DEFAULT_KEYS, skip: 'k' });
  // A saved key that a default uses (skip on 'b' while big screen kept 'b'): all defaults, so every action works.
  assert.deepEqual(loadKeys('{"skip":"b"}'), { ...DEFAULT_KEYS });
  // A swap saved in full is fine.
  assert.deepEqual(loadKeys('{"skip":"b","big":"n"}'), { ...DEFAULT_KEYS, skip: 'b', big: 'n' });
});
