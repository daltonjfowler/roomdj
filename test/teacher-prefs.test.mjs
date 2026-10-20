import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/protocol.js';
import { validateSettings } from '../shared/settings.js';

test('periodMinutes: 70 by default, a whole number from 10 to 240; old saved settings without it read as 70', () => {
  assert.equal(DEFAULT_SETTINGS.periodMinutes, 70);
  assert.equal(validateSettings({}).settings.periodMinutes, 70);
  assert.equal(validateSettings({ periodMinutes: 10 }).settings.periodMinutes, 10);
  assert.equal(validateSettings({ periodMinutes: 240 }).settings.periodMinutes, 240);
  for (const bad of [9, 241, 45.5, 'x', null, true]) assert.equal(validateSettings({ periodMinutes: bad }).ok, false, String(bad));
});
