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
 * no answer), `connectDelay` / `connectDelays` (ms before the request is
 * written, all / by command; `beforeSend` runs after it), `applyDelays` (ms,
 * by command: the controller applies it late, the answer shows the state
 * before), `delays` (ms,
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
    connectDelays: {},
    applyDelays: {},
    delays: {},
    statuses: {},
    retryAfter: undefined,
    applies: true,
    body: undefined,
    password: PASSWORD,
    log: [],
    reads: () => server.log.filter((r) => r.command === 'status').length,
    commands: () => server.log.filter((r) => r.command !== 'status').map((r) => r.command),
    async transport({
      host,
      port,
      method,
      path,
      headers,
      body,
      timeoutMs,
      startBy,
      now,
      beforeSend,
    }) {
      const command = path.split('/').at(-1);
      if (server.down) {
        throw new HuumError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      const connectDelay = server.connectDelays[command] ?? server.connectDelay;
      if (connectDelay > 0) {
        if (connectDelay >= timeoutMs) {
          await wait(timeoutMs);
          throw new HuumError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout');
        }
        await wait(connectDelay);
      }
      if (now() > startBy) {
        throw new HuumError(ERROR_KINDS.LATE, 'Too late to send');
      }
      if (beforeSend) {
        // As src/huum/http.js: a refusal there writes nothing.
        try {
          beforeSend();
        } catch (err) {
          throw Object.assign(err, { notSent: true });
        }
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
      const before = { ...sauna };
      const apply = () => {
        if (command === 'start') {
          sauna.statusCode = 231;
          sauna.targetTemperature = String(JSON.parse(body).targetTemperature);
          sauna.startDate = Math.floor(now() / 1000);
          sauna.endDate = sauna.startDate + 3 * 3600;
        } else if (command === 'stop') {
          sauna.statusCode = 232;
          sauna.endDate = Math.floor(now() / 1000);
        }
      };
      const lag = server.applyDelays[command];
      if (status === 200 && server.applies && command !== 'status') {
        if (lag > 0) {
          // A controller late to apply: the answer shows the state before.
          setTimeout(apply, lag);
        } else {
          apply();
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
      return answer(200, server.body ?? (lag > 0 ? before : { ...sauna }));
    },
  };
  Object.assign(server, over, { sauna });
  return server;
}
