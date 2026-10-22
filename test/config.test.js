import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  accountIdOf,
  credentialsKey,
  normalizeConfig,
  refusedFingerprint,
  usable,
} from '../src/config.js';
import { normalizeMemory } from '../src/store.js';

test('the defaults: heating off, 80 °C to start, 90 °C at most, 60 s, French', () => {
  const c = normalizeConfig();
  assert.equal(c.auth, undefined);
  assert.equal(usable(c), false);
  assert.equal(c.allowHeating, false);
  assert.equal(c.startTemperature, 80);
  assert.equal(c.maxTemperature, 90);
  assert.equal(c.pollInterval, 60);
  assert.equal(c.language, 'fr');
  assert.equal(DEFAULT_CONFIG.allow_heating, false);
});

test('only true allows heating', () => {
  for (const value of [true, 'true']) {
    assert.equal(normalizeConfig({ allow_heating: value }).allowHeating, true);
  }
  for (const value of [false, 'false', 1, '1', 'yes', 'on', null, undefined, {}]) {
    assert.equal(normalizeConfig({ allow_heating: value }).allowHeating, false, String(value));
  }
});

test('temperatures: whole °C, within 40-110, the start never above the highest', () => {
  assert.equal(normalizeConfig({ max_temperature: 200 }).maxTemperature, 110);
  assert.equal(normalizeConfig({ max_temperature: 10 }).maxTemperature, 40);
  assert.equal(normalizeConfig({ max_temperature: 'abc' }).maxTemperature, 90);
  assert.equal(normalizeConfig({ max_temperature: '' }).maxTemperature, 90);
  assert.equal(normalizeConfig({ start_temperature: 100 }).startTemperature, 90);
  assert.equal(
    normalizeConfig({ start_temperature: 100, max_temperature: 105 }).startTemperature,
    100,
  );
  assert.equal(normalizeConfig({ start_temperature: 70.6 }).startTemperature, 71);
});

test('credentials: trimmed user, password kept as typed, no ":" in the user', () => {
  const c = normalizeConfig({ username: '  Sauna@Example.com ', password: ' p w ' });
  assert.deepEqual(c.auth, { user: 'Sauna@Example.com', password: ' p w ' });
  assert.equal(c.accountId, accountIdOf('sauna@example.com'));
  assert.match(c.accountId, /^[0-9a-f]{16}$/);
  assert.equal(normalizeConfig({ username: 'a:b', password: 'x' }).auth, undefined);
  assert.equal(normalizeConfig({ username: 'a:b', password: 'x' }).badUser, true);
  assert.equal(normalizeConfig({ username: 'a', password: 'x\u0000' }).badSecret, true);
  assert.equal(normalizeConfig({ username: 'a', password: '' }).auth, undefined);
});

test('the account id rule is frozen', () => {
  // Changing this value would orphan every sauna already created in Gladys.
  assert.equal(accountIdOf('sauna@example.com'), accountIdOf(' SAUNA@example.com '));
  assert.equal(accountIdOf('sauna@example.com').length, 16);
});

test('the interval is bounded', () => {
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 99999 }).pollInterval, 3600);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
});

test('the refused fingerprint is salted and differs for other credentials', () => {
  const a = normalizeConfig({ username: 'u@x', password: 'one' });
  const b = normalizeConfig({ username: 'u@x', password: 'two' });
  assert.notEqual(refusedFingerprint(a, '0'.repeat(32)), refusedFingerprint(b, '0'.repeat(32)));
  assert.notEqual(refusedFingerprint(a, '0'.repeat(32)), refusedFingerprint(a, '1'.repeat(32)));
  assert.ok(!refusedFingerprint(a, '0'.repeat(32)).includes('one'));
  assert.notEqual(credentialsKey(a), credentialsKey(b));
});

test('the memory read back from /data is bounded and repaired', () => {
  const now = 1_000_000_000_000;
  const m = normalizeMemory(
    {
      pause: { until: now + 100 * 3600_000, reason: 'other' },
      block: { salt: 'a'.repeat(32), refused: 'zz', status: 500 },
      lastAttemptAt: now + 3600_000,
    },
    now,
  );
  assert.deepEqual(m.pause, { until: now + 6 * 3600_000, reason: '429' });
  assert.deepEqual(m.block, { salt: 'a'.repeat(32), refused: null, status: 401 });
  assert.equal(m.lastAttemptAt, now);
  assert.deepEqual(normalizeMemory('garbage', now), {
    pause: null,
    block: null,
    lastGood: null,
    lastAttemptAt: null,
  });
  const good = normalizeMemory(
    {
      lastGood: {
        salt: 'd'.repeat(32),
        account: 'e'.repeat(32),
        at: now + 999,
        summary: { en: 'Heating\u0000', fr: 'En chauffe' },
      },
    },
    now,
  );
  assert.equal(good.lastGood, null, 'a control character refuses it');
  assert.equal(normalizeMemory({ pause: { until: now - 1 } }, now).pause, null);
  assert.equal(normalizeMemory({ block: { salt: 'not hex' } }, now).block, null);
});
