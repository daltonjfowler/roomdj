// shared/nickgen.js: every made nickname is school-appropriate and fits.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NICK_ADJECTIVES, NICK_NOUNS, generateNick, isGeneratedNick } from '../shared/nickgen.js';
import { nickAllowed } from '../shared/nick.js';
import { NICK_MAX } from '../shared/protocol.js';

test('every pair passes the nickname word lists and fits NICK_MAX', () => {
  assert.equal(new Set(NICK_ADJECTIVES).size, NICK_ADJECTIVES.length, 'no repeated adjective');
  assert.equal(new Set(NICK_NOUNS).size, NICK_NOUNS.length, 'no repeated noun');
  const bad = [];
  for (const a of NICK_ADJECTIVES) {
    for (const n of NICK_NOUNS) {
      const nick = `${a} ${n}`;
      if (!nickAllowed(nick) || [...nick].length > NICK_MAX) bad.push(nick);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(NICK_ADJECTIVES.length * NICK_NOUNS.length >= 3000, 'enough names that a class rarely needs a reroll');
});

test('generateNick makes only list names; isGeneratedNick takes nothing else', () => {
  for (let i = 0; i < 500; i++) assert.ok(isGeneratedNick(generateNick()));
  assert.equal(generateNick(() => 0), `${NICK_ADJECTIVES[0]} ${NICK_NOUNS[0]}`);
  assert.equal(generateNick(() => 0.999999), `${NICK_ADJECTIVES.at(-1)} ${NICK_NOUNS.at(-1)}`);
  for (const typed of ['Brave', 'brave otter', 'Brave  Otter', 'Brave Otter Jr', 'Mr Otter', 'Otter Brave', 'Brave Ottter', '']) {
    assert.equal(isGeneratedNick(typed), false, typed);
  }
});
