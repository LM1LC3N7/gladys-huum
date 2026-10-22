// -----------------------------------------------------------------------------
// A fake Huum cloud behind the transport the integration is given: the status
// answer shaped like the one pyhuum parses (values made up, never captured
// from a real sauna), the Basic authentication checked, and the start / stop
// commands, which change the sauna like they are expected to. Records every
// request. No network. Delays use setTimeout, so the mocked clock drives them.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, HuumError } from '../../src/huum/http.js';

export const USER = 'sauna@example.com';
export const PASSWORD = 'correct horse';
export const NOW = Date.UTC(2026, 9, 22, 18, 0, 0);

const answer = (status, body = '', headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const basic = (user, password) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/** Lets pending promises and timers of 0 ms run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * The cloud. The test may set: `down` (nothing answers), `silent` (connected,
 * no answer), `connectDelay` (ms before the request is written), `delays` (ms,
 * by command, before the answer), `statuses` (HTTP status by command),
 * `retryAfter` (header of a 429), `applies` (false: commands change nothing),
 * `body` (raw status answer), `password` (the one accepted).
 */
export function fakeCloud(over = {}) {
  const sauna = {
    statusCode: 232,
    door: true,
    temperature: '21',
    targetTemperature: '80',
    saunaName: 'Sauna du jardin',
    light: 0,
    ...(over.sauna ?? {}),
  };
  const server = {
    sauna,
    down: false,
    silent: false,
    connectDelay: 0,
    delays: {},
    statuses: {},
    retryAfter: undefined,
    applies: true,
    body: undefined,
    password: PASSWORD,
    log: [],
    reads: () => server.log.filter((r) => r.command === 'status').length,
    commands: () => server.log.filter((r) => r.command !== 'status').map((r) => r.command),
    async transport({ host, port, method, path, headers, body, timeoutMs, startBy, now }) {
      const command = path.split('/').at(-1);
      if (server.down) {
        throw new HuumError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      if (server.connectDelay > 0) {
        if (server.connectDelay >= timeoutMs) {
          await wait(timeoutMs);
          throw new HuumError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout');
        }
        await wait(server.connectDelay);
      }
      if (now() > startBy) {
        throw new HuumError(ERROR_KINDS.LATE, 'Too late to send');
      }
      server.log.push({
        host,
        port,
        method,
        path,
        command,
        headers,
        body: body === undefined ? undefined : JSON.parse(body),
        at: now(),
      });
      if (server.silent) {
        await wait(timeoutMs);
        throw new HuumError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
      }
      const authorized = headers.Authorization === basic(USER, server.password);
      const status = server.statuses[command] ?? (authorized ? 200 : 401);
      if (status === 200) {
        if (command === 'start' && server.applies) {
          sauna.statusCode = 231;
          sauna.targetTemperature = String(JSON.parse(body).targetTemperature);
          sauna.startDate = Math.floor(now() / 1000);
          sauna.endDate = sauna.startDate + 3 * 3600;
        } else if (command === 'stop' && server.applies) {
          sauna.statusCode = 232;
          sauna.endDate = Math.floor(now() / 1000);
        }
      }
      const delay = server.delays[command] ?? 0;
      if (delay >= timeoutMs) {
        await wait(timeoutMs);
        throw new HuumError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
      }
      if (delay > 0) {
        await wait(delay);
      }
      if (status !== 200) {
        return answer(
          status,
          '',
          server.retryAfter === undefined ? {} : { 'retry-after': String(server.retryAfter) },
        );
      }
      return answer(200, server.body ?? { ...sauna });
    },
  };
  Object.assign(server, over, { sauna });
  return server;
}
