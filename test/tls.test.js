// -----------------------------------------------------------------------------
// The HTTPS layer against a REAL local TLS server (a self-signed certificate
// made for the test, trusted through the `ca` option), behind a TCP relay that
// counts the connections and looks for the request in clear text: one
// connection, nothing readable on the wire, the answer read back. Review 1,
// B1: with `agent: false`, Node ignored createConnection and sent the request
// (Authorization included) in clear on a second TCP connection.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttps } from 'node:https';
import { connect as netConnect, createServer as createNet } from 'node:net';
import { request, ERROR_KINDS } from '../src/huum/http.js';
import { selfSigned } from './fixtures/selfSigned.js';

const SECRET = `Basic ${Buffer.from('sauna@example.com:correct horse').toString('base64')}`;
const { key, cert } = selfSigned('localhost', 7);

async function tlsServer(t, handler) {
  let requests = 0;
  const server = createHttps({ key, cert }, (req, res) => {
    requests += 1;
    handler(req, res);
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // The relay: every byte the client writes is looked at, then forwarded.
  const wire = { connections: 0, clear: false };
  const sockets = new Set();
  const relay = createNet((client) => {
    wire.connections += 1;
    const upstream = netConnect(server.address().port, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    client.on('data', (d) => {
      const text = d.toString('latin1');
      wire.clear ||= text.includes('/action/home/') || text.includes(SECRET);
      upstream.write(d);
    });
    upstream.on('data', (d) => client.write(d));
    upstream.on('end', () => client.end());
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => relay.listen(0, resolve));
  t.after(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.closeAllConnections();
    server.close();
    relay.close();
  });
  return { port: relay.address().port, wire, requests: () => requests };
}

const call = (port, extra = {}) =>
  request({
    host: 'localhost',
    port,
    method: 'GET',
    path: '/action/home/status',
    headers: { Authorization: SECRET },
    timeoutMs: 3_000,
    ca: cert,
    ...extra,
  });

test('tls: one connection, the request encrypted, the answer read', async (t) => {
  const seen = [];
  const srv = await tlsServer(t, (req, res) => {
    seen.push([req.method, req.url, req.headers.authorization]);
    res.end('{"statusCode":232,"door":true}');
  });
  const answer = await call(srv.port);
  assert.equal(answer.status, 200);
  assert.equal(answer.body, '{"statusCode":232,"door":true}');
  assert.deepEqual(seen, [['GET', '/action/home/status', SECRET]]);
  assert.equal(srv.wire.connections, 1, 'one TCP connection');
  assert.equal(srv.wire.clear, false, 'nothing in clear on the wire');
});

test('tls: a POST body goes through the same encrypted connection', async (t) => {
  let body = '';
  const srv = await tlsServer(t, (req, res) => {
    req.on('data', (c) => (body += c));
    req.on('end', () => res.end('{"statusCode":231}'));
  });
  const answer = await call(srv.port, {
    method: 'POST',
    path: '/action/home/start',
    body: '{"targetTemperature":80}',
  });
  assert.equal(answer.status, 200);
  assert.equal(body, '{"targetTemperature":80}');
  assert.equal(srv.wire.connections, 1);
  assert.equal(srv.wire.clear, false);
});

test('tls: an untrusted certificate is unreachable, nothing written', async (t) => {
  const srv = await tlsServer(t, (req, res) => res.end('{}'));
  await assert.rejects(call(srv.port, { ca: undefined }), { kind: ERROR_KINDS.UNREACHABLE });
  assert.equal(srv.requests(), 0);
});

test('tls: past the deadline once connected (LATE), or refused by beforeSend: nothing written', async (t) => {
  const srv = await tlsServer(t, (req, res) => res.end('{}'));
  await assert.rejects(call(srv.port, { method: 'POST', path: '/action/home/start', startBy: 0 }), {
    kind: ERROR_KINDS.LATE,
  });
  const refusal = new Error('option turned off');
  let checked = 0;
  await assert.rejects(
    call(srv.port, {
      method: 'POST',
      path: '/action/home/start',
      beforeSend: () => {
        checked += 1;
        throw refusal;
      },
    }),
    (err) => err === refusal && err.notSent === true,
  );
  assert.equal(checked, 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(srv.requests(), 0);
  assert.equal(srv.wire.clear, false);
});
