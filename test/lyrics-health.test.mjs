import test from 'node:test';
import assert from 'node:assert/strict';
import { nextHealth } from '../src/lyrics.js';

test("LRCLIB's health: failing since the first failure, back to working on the next answer", () => {
  let h = nextHealth(null, true, '', 10);
  assert.deepEqual(h, { okAt: 10, failAt: 0, why: '', since: 0 });
  h = nextHealth(h, false, 'LRCLIB 503', 20);
  h = nextHealth(h, false, 'LRCLIB timed out', 30);
  assert.deepEqual(h, { okAt: 10, failAt: 30, why: 'LRCLIB timed out', since: 20 });
  h = nextHealth(h, true, '', 40);
  assert.deepEqual(h, { okAt: 40, failAt: 30, why: 'LRCLIB timed out', since: 0 });
});
