// -----------------------------------------------------------------------------
// The sauna -> one Gladys device and its states (pure).
//
// `ext:<selector>:huum:<account id>`: one device per Huum account (the API
// serves the one sauna of the account and gives it no id of its own), keyed
// by the account id of src/config.js (a frozen rule). The feature roles (the
// last part of their external ids) are published forever: never rename them.
// A republished device keeps every feature of the device already created.
//
// A sauna heater must never be turned on by an "everything on" (Google Home,
// Alexa, HomeKit, MCP, `switch.*` scenes): no switch, no writable binary. The
// heating state is read only (`unknown/binary`); turning on and turning off
// are two `button/push` features. The setpoint (`thermostat/target-temperature`)
// is writable, behind the same option as turning on (on Huum a new setpoint
// is sent as a start).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on temperature-sensor and
// thermostat; minutes on duration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DOOR_STATE, FEATURES, STATUS, TEMPERATURE } from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, statusText, word } from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The features, by role, in display order. */
export const DEFINITIONS = {
  [FEATURES.HEATING]: binary,
  [FEATURES.STATUS]: sensor({
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    keep_history: false,
  }),
  [FEATURES.STATUS_CODE]: sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 999 }),
  [FEATURES.ONLINE]: binary,
  [FEATURES.DOOR]: sensor({ category: C.OPENING_SENSOR, type: T.SENSOR.BINARY, min: 0, max: 1 }),
  [FEATURES.TEMPERATURE]: sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -50,
    max: 200,
  }),
  [FEATURES.TARGET]: {
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.TARGET_TEMPERATURE,
    unit: U.CELSIUS,
    min: TEMPERATURE.min,
    max: TEMPERATURE.max,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  },
  [FEATURES.REMAINING]: sensor({
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.MINUTES,
    min: 0,
    max: 100_000,
  }),
  [FEATURES.LIGHT]: binary,
  [FEATURES.HEAT_ON]: button,
  [FEATURES.HEAT_OFF]: button,
};

export const ROLES = Object.keys(DEFINITIONS);
/** The writable roles. */
export const COMMAND_ROLES = [FEATURES.HEAT_ON, FEATURES.HEAT_OFF, FEATURES.TARGET];

export const saunaIds = (gladys, accountId) => gladys.externalIds('huum', accountId);

/** The account id and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = /:huum:([0-9a-f]{16}):([a-z0-9-]+)$/.exec(externalId);
  return match && ROLES.includes(match[2]) ? { id: match[1], role: match[2] } : undefined;
}

/** The account id of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:huum:([0-9a-f]{16})$/.exec(String(externalId ?? '').slice(0, 300));
  return match ? match[1] : undefined;
}

/**
 * The roles of the device: those every sauna has, the light when the sauna
 * reports one, plus those of the device already created (`created`).
 */
export function rolesOf(sauna, created = new Set()) {
  const roles = new Set(ROLES.filter((role) => role !== FEATURES.LIGHT));
  if (sauna.light !== undefined || created.has(FEATURES.LIGHT)) {
    roles.add(FEATURES.LIGHT);
  }
  return ROLES.filter((role) => roles.has(role));
}

/** The Gladys device of the sauna. */
export function buildDevice(gladys, accountId, sauna, { language, created }) {
  const ids = saunaIds(gladys, accountId);
  return {
    name: sauna.name ?? word(DEVICE_NAME, language),
    external_id: ids.device,
    model: 'Huum UKU Wi-Fi',
    should_poll: false,
    features: rolesOf(sauna, created).map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
    })),
  };
}

/**
 * Minutes left in the heating session at `now`, from its planned end;
 * 0 when not heating, undefined when unknown.
 */
export function remainingMinutes(sauna, now) {
  if (sauna.code !== STATUS.HEATING) {
    return 0;
  }
  if (sauna.endDate === undefined) {
    return undefined;
  }
  return Math.max(0, Math.ceil((sauna.endDate * 1000 - now) / 60_000));
}

/**
 * The current values of the sauna: `[{ role, state }]` or `[{ role, text }]`.
 * A value outside the bounds of its feature is dropped (Gladys keeps the last
 * one). Never undefined, never NaN.
 */
export function statesOf(sauna, { now, language }) {
  const states = [];
  const add = (role, value) => {
    const { min, max } = DEFINITIONS[role];
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ role, state: value });
    }
  };
  states.push({ role: FEATURES.STATUS, text: word(statusText(sauna.code), language) });
  add(FEATURES.STATUS_CODE, sauna.code);
  add(FEATURES.HEATING, sauna.code === STATUS.HEATING ? 1 : 0);
  add(FEATURES.ONLINE, sauna.code === STATUS.OFFLINE ? 0 : 1);
  if (sauna.doorClosed !== undefined) {
    add(FEATURES.DOOR, sauna.doorClosed ? DOOR_STATE.CLOSED : DOOR_STATE.OPEN);
  }
  if (sauna.temperature !== undefined) {
    add(FEATURES.TEMPERATURE, Math.round(sauna.temperature * 10) / 10);
  }
  add(FEATURES.TARGET, sauna.target);
  add(FEATURES.REMAINING, remainingMinutes(sauna, now));
  add(FEATURES.LIGHT, sauna.light);
  return states;
}
