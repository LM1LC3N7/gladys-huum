import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, STATUS } from '../src/constants.js';
import {
  DEFINITIONS,
  ROLES,
  buildDevice,
  parseDeviceId,
  parseFeatureId,
  remainingMinutes,
  rolesOf,
  statesOf,
} from '../src/devices.js';

const gladys = {
  externalIds: (platform, id) => ({
    device: `ext:test:${platform}:${id}`,
    feature: (role) => `ext:test:${platform}:${id}:${role}`,
  }),
};
const ID = '0123456789abcdef';
const NOW = Date.UTC(2026, 9, 22, 18);

// The units the core lists for these categories (DEVICE_FEATURE_UNITS_BY_CATEGORY).
const CORE_UNITS = {
  'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'],
  thermostat: ['celsius', 'fahrenheit'],
  duration: ['microseconds', 'milliseconds', 'seconds', 'minutes', 'hours', 'days'],
};

test('the frozen roles', () => {
  assert.deepEqual(ROLES, [
    'heating',
    'status',
    'status-code',
    'online',
    'door',
    'temperature',
    'target-temperature',
    'remaining',
    'light',
    'heat-on',
    'heat-off',
  ]);
});

test('no switch; writable: two buttons and the setpoint; units from the core', () => {
  for (const [role, d] of Object.entries(DEFINITIONS)) {
    assert.notEqual(d.category, 'switch', role);
    if (!d.read_only) {
      assert.ok(
        (d.category === 'button' && d.type === 'push') ||
          (d.category === 'thermostat' && d.type === 'target-temperature'),
        role,
      );
    }
    if (d.unit) {
      assert.ok(CORE_UNITS[d.category]?.includes(d.unit), `${role}: ${d.category}/${d.unit}`);
    }
  }
  assert.equal(DEFINITIONS[FEATURES.TARGET].max, 110);
  assert.equal(DEFINITIONS[FEATURES.DOOR].category, 'opening-sensor');
});

test('feature ids parse back; anything else is refused', () => {
  assert.deepEqual(parseFeatureId(`ext:test:huum:${ID}:heat-off`), { id: ID, role: 'heat-off' });
  assert.equal(parseFeatureId(`ext:test:huum:${ID}:other`), undefined);
  assert.equal(parseFeatureId(`ext:test:huum:XYZ:heat-off`), undefined);
  assert.equal(parseFeatureId(42), undefined);
  assert.equal(parseDeviceId(`ext:test:huum:${ID}`), ID);
  assert.equal(parseDeviceId(`ext:test:huum:${ID}:door`), undefined);
});

test('the light only when reported, or already created', () => {
  assert.ok(!rolesOf({ code: 232 }).includes('light'));
  assert.ok(rolesOf({ code: 232, light: 0 }).includes('light'));
  assert.ok(rolesOf({ code: 232 }, new Set(['light'])).includes('light'));
  const device = buildDevice(gladys, ID, { code: 232 }, { language: 'en', created: new Set() });
  assert.equal(device.name, 'Huum sauna');
  assert.equal(device.external_id, `ext:test:huum:${ID}`);
});

test('states: never undefined nor NaN, out of bounds dropped', () => {
  const states = statesOf(
    {
      code: STATUS.HEATING,
      doorClosed: false,
      temperature: 64.25,
      target: 300,
      endDate: NOW / 1000 + 90,
    },
    { now: NOW, language: 'en' },
  );
  const by = Object.fromEntries(states.map((s) => [s.role, s.state ?? s.text]));
  assert.equal(by.heating, 1);
  assert.equal(by.door, 0);
  assert.equal(by.temperature, 64.3);
  assert.equal(by['target-temperature'], undefined, 'out of bounds');
  assert.equal(by.remaining, 2);
  assert.equal(by.status, 'Heating');
  for (const s of states) {
    assert.ok(s.text !== undefined || Number.isFinite(s.state), s.role);
  }
  assert.equal(remainingMinutes({ code: STATUS.IDLE }, NOW), 0);
  assert.equal(remainingMinutes({ code: STATUS.HEATING }, NOW), undefined);
  assert.equal(remainingMinutes({ code: STATUS.HEATING, endDate: NOW / 1000 - 60 }, NOW), 0);
  const unknown = statesOf({ code: 999 }, { now: NOW, language: 'fr' });
  assert.equal(unknown.find((s) => s.role === 'status').text, 'Statut inconnu (999)');
});
