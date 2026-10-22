// -----------------------------------------------------------------------------
// One HTTPS/1.1 request to the Huum cloud (node:tls + node:http, no
// keep-alive, no redirect followed, the certificate checked against the
// system's authorities, bounded time and size). The TLS connection is opened
// first; only once it is up, and only if the deadline of a command
// (`startBy`) has not passed meanwhile, is the request written: a slow
// connection never lets a command leave late.
//
// Every failure becomes a HuumError whose kind says whether the request may
// have reached Huum: 'unreachable' / 'late' (nothing written) or 'timeout'
// (written, then silent or cut: it may have been received). The
// Authorization header is never logged, never put in an error.
//
// The answer is copied into one buffer of at most LIMITS.responseBytes,
// allocated once: no per-chunk buffer kept, no concatenation.
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { LIMITS } from '../constants.js';

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection (or TLS failed). Nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Written, then silent or cut: the request may have been received. */
  TIMEOUT: 'timeout',
  /** An HTTP status other than 2xx (`status` holds it). */
  HTTP: 'http',
  /** 401 or 403: the credentials refused (`status` holds it). */
  AUTH: 'auth',
  /** 429 (`retryAfter` in ms when Huum gave one). */
  RATE_LIMITED: 'rate_limited',
  /** Too large, not JSON, not the expected shape. */
  PROTOCOL: 'protocol',
  /** The deadline of a command passed before its request was written: nothing was sent. */
  LATE: 'late',
});

export class HuumError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'HuumError';
    this.kind = kind;
    for (const [key, value] of Object.entries(details)) {
      this[key] = value;
    }
  }
}

/**
 * @param {{ host: string, port: number, method: string, path: string,
 *   headers?: object, body?: string, timeoutMs?: number, startBy?: number,
 *   now?: () => number, secure?: boolean }} options
 *   `secure: false` (plain TCP) is for the tests only.
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function request({
  host,
  port,
  method,
  path,
  headers = {},
  body,
  timeoutMs = 10_000,
  startBy = Infinity,
  now = Date.now,
  secure = true,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let written = false;
    let req;
    const socket = secure
      ? tlsConnect({ host, port, servername: host, ALPNProtocols: ['http/1.1'] })
      : netConnect({ host, port });
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const fail = (kind, message) => {
      req?.destroy();
      socket.destroy();
      finish(reject, new HuumError(kind, message));
    };
    const lost = (err) =>
      written
        ? fail(ERROR_KINDS.TIMEOUT, `Connection lost: ${err?.code ?? 'error'}`)
        : fail(ERROR_KINDS.UNREACHABLE, `Unreachable: ${err?.code ?? 'error'}`);
    // A plain (ref'd) timer: the exchange keeps the process alive until it ends.
    const timer = setTimeout(
      () =>
        written
          ? fail(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
          : fail(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'),
      timeoutMs,
    );
    socket.on('error', lost);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      if (settled) {
        return;
      }
      if (now() > startBy) {
        // Connected too late for a command: nothing is written.
        fail(ERROR_KINDS.LATE, 'Too late to send');
        return;
      }
      written = true;
      const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
      req = httpRequest(
        {
          host,
          port,
          method,
          path,
          agent: false,
          createConnection: () => socket,
          headers: {
            Connection: 'close',
            Accept: 'application/json',
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
              : {}),
            ...headers,
          },
        },
        (res) => {
          let buffer;
          let size = 0;
          res.on('data', (chunk) => {
            if (settled) {
              return;
            }
            if (size + chunk.length > LIMITS.responseBytes) {
              fail(ERROR_KINDS.PROTOCOL, 'Answer too large');
              return;
            }
            buffer ??= Buffer.allocUnsafe(LIMITS.responseBytes);
            chunk.copy(buffer, size);
            size += chunk.length;
          });
          res.on('end', () => {
            socket.destroy();
            finish(resolve, {
              status: res.statusCode ?? 0,
              headers: res.headers ?? {},
              body: buffer ? buffer.toString('utf8', 0, size) : '',
            });
          });
          res.on('error', lost);
        },
      );
      req.on('error', lost);
      req.end(payload);
    });
  });
}
