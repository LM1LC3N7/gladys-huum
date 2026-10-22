// -----------------------------------------------------------------------------
// The Huum cloud API, ported from the `huum` Python library 0.8.3 (MIT,
// frwickst/pyhuum, see THIRD_PARTY_NOTICES.md): `/action/home/<command>` on
// sauna.huum.eu with HTTP Basic authentication. Reads are never retried here
// (the app spaces its new tries); a command is never retried at all (it may
// have reached Huum).
//
// The answers come from the network: only own fields of plain objects are
// read, each with its exact type (a missing or mistyped value is undefined,
// never a default, so that a command is refused rather than decided on a
// guess). Huum sends some numbers as text ("21"): a decimal text is read as a
// number, nothing else. JSON.parse keeps `__proto__` as a plain own key: it
// never reaches a prototype, and it is never read.
// -----------------------------------------------------------------------------

import { API, LIMITS, PATHS, TEMPERATURE } from '../constants.js';
import { ERROR_KINDS, HuumError, request as httpRequest } from './http.js';

const own = (object, key) =>
  object !== null && typeof object === 'object' && Object.hasOwn(object, key)
    ? object[key]
    : undefined;
const plain = (data) => data !== null && typeof data === 'object' && !Array.isArray(data);

/** A finite number, or a short decimal text ("21", "75.5"), else undefined. */
function numeric(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.length <= 20 && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** A number within bounds, else undefined. */
const bounded = (value, min, max) => {
  const n = numeric(value);
  return n !== undefined && n >= min && n <= max ? n : undefined;
};

/** A whole number within bounds, else undefined. */
const whole = (value, min, max) => {
  const n = bounded(value, min, max);
  return Number.isInteger(n) ? n : undefined;
};

/** A short text from Huum, without control characters, else undefined. */
export function text(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.textLength);
}

const notObject = () => new HuumError(ERROR_KINDS.PROTOCOL, 'Not a JSON object');

/**
 * A status answer (also the answer of start and stop) -> what the
 * integration uses. Without a valid `statusCode` it is not a status.
 */
export function parseStatus(data) {
  if (!plain(data)) {
    throw notObject();
  }
  const code = whole(own(data, 'statusCode'), 0, 999);
  if (code === undefined) {
    throw new HuumError(ERROR_KINDS.PROTOCOL, 'No status code');
  }
  const door = own(data, 'door');
  const light = whole(own(data, 'light'), 0, 1);
  return {
    code,
    name: text(own(data, 'saunaName')),
    /** true: closed, false: open, undefined: unknown. */
    doorClosed: typeof door === 'boolean' ? door : undefined,
    temperature: bounded(own(data, 'temperature'), -50, 200),
    target: whole(own(data, 'targetTemperature'), 0, 200),
    /** Unix seconds of the start and of the planned end of the heating session. */
    startDate: whole(own(data, 'startDate'), 1, 4_102_444_800),
    endDate: whole(own(data, 'endDate'), 1, 4_102_444_800),
    light,
  };
}

/** Retry-After (seconds or an HTTP date) in ms, else undefined. */
export function retryAfterOf(header, now = Date.now()) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 64) {
    return undefined;
  }
  if (/^\s*\d{1,9}\s*$/.test(value)) {
    return Number(value) * 1000;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The error of a non-2xx answer (the body is never kept: it may echo a secret). */
function statusError(response, now) {
  const status = response.status;
  if (status === 429) {
    return new HuumError(ERROR_KINDS.RATE_LIMITED, 'HTTP 429', {
      status,
      retryAfter: retryAfterOf(response.headers?.['retry-after'], now),
    });
  }
  if (status === 401 || status === 403) {
    return new HuumError(ERROR_KINDS.AUTH, `HTTP ${status}`, { status });
  }
  return new HuumError(ERROR_KINDS.HTTP, `HTTP ${status}`, { status });
}

/** The reason of an error for a log or a message: its kind and status, never the answer. */
export function errorReason(err) {
  if (
    err?.kind === ERROR_KINDS.HTTP ||
    err?.kind === ERROR_KINDS.RATE_LIMITED ||
    err?.kind === ERROR_KINDS.AUTH
  ) {
    return `HTTP ${err.status}`;
  }
  return typeof err?.kind === 'string' ? err.kind : 'error';
}

function json(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new HuumError(ERROR_KINDS.PROTOCOL, 'Not JSON');
  }
}

/** The Basic authorization header of `auth` (never logged). */
export const authHeaders = (auth) => ({
  Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`, 'utf8').toString('base64')}`,
});

export class HuumClient {
  constructor({ transport = httpRequest, now = Date.now } = {}) {
    this.transport = transport;
    this.now = now;
  }

  async call(auth, method, path, { body, timeoutMs, startBy = Infinity }) {
    if (!auth) {
      throw Object.assign(new Error('No credentials'), { notSent: true });
    }
    const response = await this.transport({
      host: API.host,
      port: API.port,
      method,
      path,
      headers: { ...authHeaders(auth), 'User-Agent': API.userAgent },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      startBy,
      now: this.now,
    });
    if (response.status < 200 || response.status > 299) {
      throw statusError(response, this.now());
    }
    return parseStatus(json(response));
  }

  /** The state of the sauna. */
  async status(auth, { timeoutMs, startBy }) {
    return this.call(auth, 'GET', PATHS.status, { timeoutMs, startBy });
  }

  /**
   * Heats at `temperature` °C (also how a new setpoint is given), never
   * retried. Refused unsent when the temperature is not a whole number of
   * the controller's range, or (LATE) when the request could not be written
   * by `startBy`.
   */
  async start(auth, temperature, { timeoutMs, startBy }) {
    if (
      !Number.isInteger(temperature) ||
      temperature < TEMPERATURE.min ||
      temperature > TEMPERATURE.max
    ) {
      throw Object.assign(new Error('Temperature out of range'), { notSent: true });
    }
    if (this.now() > startBy) {
      throw new HuumError(ERROR_KINDS.LATE, 'Too late to send');
    }
    return this.call(auth, 'POST', PATHS.start, {
      body: { targetTemperature: temperature },
      timeoutMs,
      startBy,
    });
  }

  /** Stops heating, never retried here. */
  async stop(auth, { timeoutMs }) {
    return this.call(auth, 'POST', PATHS.stop, { timeoutMs });
  }
}
