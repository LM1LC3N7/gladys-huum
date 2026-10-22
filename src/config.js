// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The password of
// the Huum account is kept here in memory only: never logged, never written
// to /data, never put in a status or an error.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { LIMITS, POLL_INTERVAL, TEMPERATURE } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  username: '',
  password: '',
  allow_heating: false,
  start_temperature: TEMPERATURE.defaultStart,
  max_temperature: TEMPERATURE.defaultMax,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A text without control characters, bounded; `undefined` when refused, '' when empty. */
function clean(value, max) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  if (value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return undefined;
  }
  return value;
}

/** A whole number of °C between the bounds of the controller, else `fallback`. */
function degrees(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '' || text === null || text === undefined || typeof text === 'boolean') {
    return fallback;
  }
  const n = Number(text);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(TEMPERATURE.max, Math.max(TEMPERATURE.min, Math.round(n)));
}

/**
 * The id of the Huum account. FROZEN RULE (it makes the external id of the
 * sauna, forever): the first 16 hex digits of
 * SHA-256("huum-account\0" + the e-mail address trimmed, in lower case). The
 * Huum API gives no id of its own for the sauna: one account, one sauna.
 */
export const accountIdOf = (username) =>
  createHash('sha256')
    .update(`huum-account\0${username.trim().toLowerCase()}`, 'utf8')
    .digest('hex')
    .slice(0, 16);

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const user = clean(
    typeof c.username === 'string' ? c.username.trim() : c.username,
    LIMITS.userMax,
  );
  // The password is kept as typed: a space may be part of it.
  const password = clean(c.password, LIMITS.secretMax);
  // Basic authentication cannot carry a ":" in the user name.
  const badUser = user === undefined || (user ?? '').includes(':');
  const badSecret = password === undefined;
  const auth =
    !badUser && !badSecret && user !== '' && password !== '' ? { user, password } : undefined;
  const maxTemperature = degrees(c.max_temperature, TEMPERATURE.defaultMax);
  const interval = Number(c.poll_interval);
  return {
    /** `{ user, password }`, or undefined while one is missing or invalid. */
    auth,
    badUser,
    badSecret,
    /** The id of the account (external id of the sauna), else undefined. */
    accountId: auth ? accountIdOf(auth.user) : undefined,
    allowHeating: strictTrue(c.allow_heating),
    /** The highest setpoint ever sent, 40 to 110 °C (90 by default). */
    maxTemperature,
    /** The setpoint of the "Turn on" button, never above the highest one. */
    startTemperature: Math.min(
      degrees(c.start_temperature, TEMPERATURE.defaultStart),
      maxTemperature,
    ),
    pollInterval:
      Number.isFinite(interval) && String(c.poll_interval).trim() !== ''
        ? Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval)))
        : POLL_INTERVAL.default,
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** Whether the configuration can be used to read the sauna. */
export const usable = (config) => Boolean(config.auth);

/**
 * What identifies the credentials in memory, to tell a change (compared,
 * never logged, never stored).
 */
export const credentialsKey = (config) =>
  config.auth ? JSON.stringify([config.auth.user, config.auth.password]) : '';

/**
 * The fingerprint of credentials REFUSED by Huum, with the salt kept beside
 * it in /data: after a restart, a stop is lifted at once when other
 * credentials are configured. Only ever computed for credentials Huum
 * refused, and erased at the first accepted read: the good password never
 * leaves memory in any form.
 */
export const refusedFingerprint = (config, salt) =>
  createHash('sha256')
    .update(`huum-refused\0${salt}\0${credentialsKey(config)}`)
    .digest('hex');
