// -----------------------------------------------------------------------------
// The Huum client: answers parsed strictly (pyhuum's field names), errors
// told apart, the request it sends; and the HTTP layer against a real local
// server (plain TCP: `secure: false`), for the deadline, the size bound and
// the "may have been received" distinction.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HuumClient, authHeaders, parseStatus, retryAfterOf, text } from '../src/huum/client.js';
import { ERROR_KINDS, request } from '../src/huum/http.js';

const AUTH = { user: 'sauna@example.com', password: 'p:ss wörd' };

test('parseStatus reads pyhuum fields, numbers sent as text included', () => {
  const s = parseStatus({
    statusCode: 231,
    door: true,
    temperature: '21',
    targetTemperature: '75',
    startDate: 1631685780,
    endDate: 1631696580,
    duration: 180,
    saunaName: 'test',
    light: 1,
  });
  assert.deepEqual(s, {
    code: 231,
    name: 'test',
    doorClosed: true,
    temperature: 21,
    target: 75,
    startDate: 1631685780,
    endDate: 1631696580,
    light: 1,
  });
});

test('parseStatus: a missing or mistyped value is undefined, never a guess', () => {
  const s = parseStatus({
    statusCode: '232',
    door: 'true',
    temperature: '21°',
    targetTemperature: 75.5,
    light: 2,
    saunaName: '\u0000\u0007',
  });
  assert.equal(s.code, 232);
  assert.equal(s.doorClosed, undefined);
  assert.equal(s.temperature, undefined);
  assert.equal(s.target, undefined);
  assert.equal(s.light, undefined);
  assert.equal(s.name, undefined);
  assert.throws(() => parseStatus({ door: true }), { kind: ERROR_KINDS.PROTOCOL });
  assert.throws(() => parseStatus([]), { kind: ERROR_KINDS.PROTOCOL });
  assert.throws(() => parseStatus(null), { kind: ERROR_KINDS.PROTOCOL });
});

test('parseStatus never reads through a prototype', () => {
  const data = JSON.parse('{"__proto__": {"statusCode": 231, "door": true}}');
  assert.throws(() => parseStatus(data), { kind: ERROR_KINDS.PROTOCOL });
  const inherited = Object.create({ statusCode: 231 });
  assert.throws(() => parseStatus(inherited), { kind: ERROR_KINDS.PROTOCOL });
  assert.equal({}.statusCode, undefined);
});

test('text: bounded, without control characters', () => {
  assert.equal(text('a'.repeat(500)).length, 80);
  assert.equal(text(' Sauna\u0000 '), 'Sauna');
  assert.equal(text(42), undefined);
});

test('retryAfterOf: seconds or a date, else undefined', () => {
  assert.equal(retryAfterOf('120'), 120_000);
  assert.equal(retryAfterOf('Thu, 22 Oct 2026 18:01:00 GMT', Date.UTC(2026, 9, 22, 18)), 60_000);
  assert.equal(retryAfterOf('soon'), undefined);
  assert.equal(retryAfterOf(undefined), undefined);
});

test('the client sends Basic authentication and its own User-Agent, never retries', async () => {
  const calls = [];
  const client = new HuumClient({
    transport: async (options) => {
      calls.push(options);
      return { status: 200, headers: {}, body: JSON.stringify({ statusCode: 231, door: true }) };
    },
  });
  await client.start(AUTH, 80, { timeoutMs: 1000, startBy: Infinity });
  await client.stop(AUTH, { timeoutMs: 1000 });
  await client.status(AUTH, { timeoutMs: 1000 });
  assert.deepEqual(
    calls.map((c) => [c.method, c.host, c.path, c.body]),
    [
      ['POST', 'sauna.huum.eu', '/action/home/start', '{"targetTemperature":80}'],
      ['POST', 'sauna.huum.eu', '/action/home/stop', undefined],
      ['GET', 'sauna.huum.eu', '/action/home/status', undefined],
    ],
  );
  assert.equal(calls[0].headers['User-Agent'], 'gladys-huum');
  assert.equal(calls[0].headers.Authorization, authHeaders(AUTH).Authorization);
  assert.equal(
    Buffer.from(calls[0].headers.Authorization.slice(6), 'base64').toString('utf8'),
    'sauna@example.com:p:ss wörd',
  );
});

test('the client refuses unsent: a temperature out of range, no credentials, too late', async () => {
  let sent = 0;
  const client = new HuumClient({
    transport: async () => {
      sent += 1;
      return { status: 200, headers: {}, body: '{"statusCode":231}' };
    },
    now: () => 1000,
  });
  for (const t of [39, 111, 80.5, NaN, '80']) {
    await assert.rejects(client.start(AUTH, t, { timeoutMs: 1000 }), { notSent: true });
  }
  await assert.rejects(client.status(undefined, { timeoutMs: 1000 }), { notSent: true });
  await assert.rejects(client.start(AUTH, 80, { timeoutMs: 1000, startBy: 999 }), {
    kind: ERROR_KINDS.LATE,
  });
  assert.equal(sent, 0);
});

test('the client tells the HTTP errors apart, never keeping the body', async () => {
  const answer = (status, headers = {}) =>
    new HuumClient({
      transport: async () => ({ status, headers, body: 'secret echo' }),
    });
  await assert.rejects(answer(401).status(AUTH, {}), { kind: ERROR_KINDS.AUTH, status: 401 });
  await assert.rejects(answer(403).status(AUTH, {}), { kind: ERROR_KINDS.AUTH, status: 403 });
  await assert.rejects(answer(429, { 'retry-after': '30' }).status(AUTH, {}), {
    kind: ERROR_KINDS.RATE_LIMITED,
    retryAfter: 30_000,
  });
  await assert.rejects(answer(503).status(AUTH, {}), (err) => {
    assert.equal(err.kind, ERROR_KINDS.HTTP);
    assert.ok(!String(err.message).includes('secret'));
    return true;
  });
  await assert.rejects(answer(200).status(AUTH, {}), { kind: ERROR_KINDS.PROTOCOL });
});

/** A local HTTP server for the transport (plain TCP). */
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, close: () => server.close() };
}

test('http: a request and its answer, through a real socket', async (t) => {
  const seen = [];
  const { port, close } = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, type: req.headers['content-type'] });
      res.end('{"statusCode":232}');
    });
  });
  t.after(close);
  const answer = await request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/action/home/start',
    body: '{"targetTemperature":80}',
    secure: false,
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, '{"statusCode":232}');
  assert.deepEqual(seen, [
    {
      method: 'POST',
      url: '/action/home/start',
      body: '{"targetTemperature":80}',
      type: 'application/json',
    },
  ]);
});

test('http: past the deadline once connected, nothing is written (LATE)', async (t) => {
  let requests = 0;
  const { port, close } = await serve((req, res) => {
    requests += 1;
    res.end('{}');
  });
  t.after(close);
  await assert.rejects(
    request({ host: '127.0.0.1', port, method: 'POST', path: '/x', startBy: 0, secure: false }),
    { kind: ERROR_KINDS.LATE },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requests, 0);
});

test('http: written then silent is TIMEOUT (may have been received)', async (t) => {
  const { port, close, server } = await serve(() => {});
  t.after(() => {
    server.closeAllConnections();
    close();
  });
  await assert.rejects(
    request({ host: '127.0.0.1', port, method: 'GET', path: '/x', timeoutMs: 200, secure: false }),
    { kind: ERROR_KINDS.TIMEOUT },
  );
});

test('http: nothing listening is UNREACHABLE (nothing sent)', async () => {
  const { port, close } = await serve(() => {});
  close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    request({ host: '127.0.0.1', port, method: 'GET', path: '/x', timeoutMs: 1000, secure: false }),
    { kind: ERROR_KINDS.UNREACHABLE },
  );
});

test('http: an answer too large is cut (PROTOCOL)', async (t) => {
  const { port, close } = await serve((req, res) => {
    res.write('x'.repeat(40 * 1024));
    res.end('y'.repeat(40 * 1024));
  });
  t.after(close);
  await assert.rejects(
    request({ host: '127.0.0.1', port, method: 'GET', path: '/x', secure: false }),
    { kind: ERROR_KINDS.PROTOCOL },
  );
});
