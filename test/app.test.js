// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Huum cloud, with
// the exact wiring of the container (src/handlers.js) and a mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HuumApp } from '../src/app.js';
import { accountIdOf, normalizeConfig, refusedFingerprint } from '../src/config.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { NOW, PASSWORD, USER, fakeCloud, settle } from './fixtures/fakeHuum.js';

const CFG = { username: USER, password: PASSWORD };
const HEAT_CFG = { ...CFG, allow_heating: true };
const ACCOUNT = accountIdOf(USER);
const DEVICE = `ext:test-integration:huum:${ACCOUNT}`;
const feature = (role) => `${DEVICE}:${role}`;

async function setup(
  t,
  { config = CFG, server = fakeCloud(), store = memoryStore(), create = true, now = NOW } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const gladys = createFakeGladys({ config });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  const app = new HuumApp({
    gladys,
    logger,
    transport: server.transport,
    now: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms, step = 100) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle(5);
    }
  };
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  const fire = (role, value = 1) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE) ?? {
      external_id: DEVICE,
    };
    return gladys.fake.setValue(device, { external_id: feature(role) }, value);
  };
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = fire(role, value);
    await advance(wait);
    return ack;
  };
  const state = (role) =>
    gladys.fake.states.findLast((s) => s.device_feature_external_id === feature(role));
  const status = () => gladys.fake.connectionStatus;
  return {
    gladys,
    app,
    server,
    sauna: server.sauna,
    advance,
    logs,
    fire,
    press,
    store,
    state,
    status,
  };
}

test('discovery: one device keyed by the account, states published, no switch', async (t) => {
  const ctx = await setup(t);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'Sauna du jardin');
  const types = device.features.map((f) => `${f.category}/${f.type}`);
  assert.ok(!types.some((x) => x.startsWith('switch/')), 'never a switch');
  for (const f of device.features.filter((f) => !f.read_only)) {
    assert.ok(
      (f.category === 'button' && f.type === 'push') ||
        (f.category === 'thermostat' && f.type === 'target-temperature'),
      `${f.external_id} is writable`,
    );
  }
  await ctx.advance(2 * SECOND);
  assert.equal(ctx.state('temperature').state, 21);
  assert.equal(ctx.state('target-temperature').state, 80);
  assert.equal(ctx.state('heating').state, 0);
  assert.equal(ctx.state('door').state, 1);
  assert.equal(ctx.state('online').state, 1);
  assert.equal(ctx.state('status').text, 'En ligne, à l’arrêt');
  assert.equal(ctx.state('remaining').state, 0);
  assert.equal(ctx.status().connected, true);
  const badge = ctx.gladys.fake.transports.at(-1);
  assert.equal(badge.device_external_id ?? badge.external_id, DEVICE);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.CLOUD);
  const [request] = ctx.server.log;
  assert.equal(request.host, 'sauna.huum.eu');
  assert.equal(request.path, '/action/home/status');
  assert.equal(request.headers['User-Agent'], 'gladys-huum');
});

test('turning on is off by default: refused, nothing sent', async (t) => {
  const ctx = await setup(t);
  const ack = await ctx.press('heat-on');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /Autoriser le chauffage/);
  assert.deepEqual(ctx.server.commands(), []);
  const setpoint = await ctx.press('target-temperature', 70);
  assert.equal(setpoint.success, false);
  assert.deepEqual(ctx.server.commands(), []);
});

test('turning on: a fresh read, then the start at the configured setpoint, confirmed', async (t) => {
  const ctx = await setup(t, { config: { ...HEAT_CFG, start_temperature: 85 } });
  const reads = ctx.server.reads();
  const ack = await ctx.press('heat-on');
  assert.equal(ack.success, true, ack.error);
  assert.ok(ctx.server.reads() > reads, 'a fresh read before');
  assert.deepEqual(ctx.server.commands(), ['start']);
  assert.deepEqual(ctx.server.log.at(-1).body, { targetTemperature: 85 });
  await ctx.advance(2 * SECOND);
  assert.equal(ctx.state('heating').state, 1);
  assert.equal(ctx.state('remaining').state, 180);
  // Already heating: nothing sent again.
  const again = await ctx.press('heat-on');
  assert.equal(again.success, true);
  assert.deepEqual(ctx.server.commands(), ['start']);
});

test('the start setpoint never goes above the highest setpoint', async (t) => {
  const ctx = await setup(t, {
    config: { ...HEAT_CFG, start_temperature: 105, max_temperature: 90 },
  });
  assert.equal((await ctx.press('heat-on')).success, true);
  assert.deepEqual(ctx.server.log.at(-1).body, { targetTemperature: 90 });
});

test('turning on is refused: door open, unknown door, locked, offline, emergency stop', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  ctx.sauna.door = false;
  let ack = await ctx.press('heat-on');
  assert.match(String(ack.error), /porte du sauna est ouverte/);
  delete ctx.sauna.door;
  ack = await ctx.press('heat-on');
  assert.match(String(ack.error), /incomplet/);
  ctx.sauna.door = true;
  for (const code of [230, 233, 400, 999]) {
    ctx.sauna.statusCode = code;
    ack = await ctx.press('heat-on');
    assert.equal(ack.success, false, String(code));
    assert.match(String(ack.error), /ne peut pas chauffer/);
  }
  assert.deepEqual(ctx.server.commands(), []);
});

test('turning on is refused unsent when the state cannot be read in time', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  ctx.server.connectDelay = 2_500;
  const ack = await ctx.press('heat-on');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /rien envoyé/);
  assert.deepEqual(ctx.server.commands(), []);
});

test('the setpoint: only while heating, bounded, decided on a fresh read', async (t) => {
  const ctx = await setup(t, { config: { ...HEAT_CFG, max_temperature: 95 } });
  let ack = await ctx.press('target-temperature', 85);
  assert.match(String(ack.error), /ne chauffe pas/);
  assert.deepEqual(ctx.server.commands(), []);
  ctx.sauna.statusCode = 231;
  for (const bad of [96, 39, 85.5, '', null, '85°', true]) {
    ack = await ctx.press('target-temperature', bad);
    assert.equal(ack.success, false, String(bad));
    assert.match(String(ack.error), /nombre entier de 40 à 95/);
  }
  ack = await ctx.press('target-temperature', 80);
  assert.equal(ack.success, true, 'already the setpoint');
  assert.deepEqual(ctx.server.commands(), []);
  ack = await ctx.press('target-temperature', '90');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.server.commands(), ['start']);
  assert.deepEqual(ctx.server.log.at(-1).body, { targetTemperature: 90 });
});

test('turning off: always sent, also with the option off, during a pause or a stop', async (t) => {
  const ctx = await setup(t);
  ctx.sauna.statusCode = 231;
  let ack = await ctx.press('heat-off');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.server.commands(), ['stop']);
  // Not heating: still sent (never "already off").
  ack = await ctx.press('heat-off');
  assert.equal(ack.success, true);
  assert.deepEqual(ctx.server.commands(), ['stop', 'stop']);
  // A 429 pause: one request, no read before it.
  ctx.server.statuses.status = 429;
  await ctx.advance(2 * MINUTE);
  assert.ok(ctx.app.paused);
  const reads = ctx.server.reads();
  ack = await ctx.press('heat-off');
  assert.equal(ack.success, true);
  assert.equal(ctx.server.reads(), reads, 'no read');
  assert.deepEqual(ctx.server.commands(), ['stop', 'stop', 'stop']);
});

test('turning off before the first read after a restart, and while credentials are refused', async (t) => {
  const store = memoryStore({
    lastAttemptAt: NOW - 10 * SECOND,
    block: { salt: 'a'.repeat(32), refused: 'b'.repeat(64), status: 401 },
  });
  // The fingerprint differs: the block of other credentials is lifted, the read waits.
  const ctx = await setup(t, { store, create: false });
  assert.equal(ctx.server.reads(), 0, 'no read before the interval');
  const ack = ctx.fire('heat-off');
  await ctx.advance(5 * SECOND);
  assert.equal((await ack).success, true);
  assert.deepEqual(ctx.server.commands(), ['stop']);
});

test('a turn off cancels a heating command still reading', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  ctx.server.delays.status = 1_000;
  const on = ctx.fire('heat-on');
  await ctx.advance(200);
  const off = ctx.fire('heat-off');
  await ctx.advance(5 * SECOND);
  const [onAck, offAck] = await Promise.all([on, off]);
  assert.equal(onAck.success, false);
  assert.match(String(onAck.error), /extinction a été demandée/);
  assert.equal(offAck.success, true);
  assert.deepEqual(ctx.server.commands(), ['stop']);
});

test('a turn off that overtakes a start in flight is sent again after it', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  ctx.server.delays.start = 1_500;
  const on = ctx.fire('heat-on');
  await ctx.advance(500);
  assert.deepEqual(ctx.server.commands(), ['start']);
  const off = ctx.fire('heat-off');
  await ctx.advance(5 * SECOND);
  await Promise.all([on, off]);
  assert.deepEqual(ctx.server.commands(), ['start', 'stop', 'stop']);
  await ctx.advance(SECOND);
  assert.equal(ctx.sauna.statusCode, 232);
});

test('a start without the expected answer is "sent, without confirmation"; a guard follows', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  ctx.server.applies = false;
  let ack = await ctx.press('heat-on');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /Envoyée, sans confirmation/);
  assert.deepEqual(ctx.server.commands(), ['start']);
  // Not confirmed yet: a second press sends nothing.
  ack = await ctx.press('heat-on', 1, 2 * SECOND);
  assert.match(String(ack.error), /pas encore confirmée/);
  assert.deepEqual(ctx.server.commands(), ['start']);
});

test('a silent start is "sent, without confirmation"', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  ctx.server.delays.start = 10 * SECOND;
  const ack = await ctx.press('heat-on', 1, 6 * SECOND);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /Envoyée, sans confirmation \(timeout\)/);
});

test('a turn off is reaffirmed when the sauna heats again after it', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  ctx.server.applies = false;
  await ctx.press('heat-on');
  ctx.server.applies = true;
  assert.equal((await ctx.press('heat-off')).success, true);
  // The late start lands after the turn off.
  ctx.sauna.statusCode = 231;
  await ctx.advance(15 * SECOND);
  assert.deepEqual(ctx.server.commands(), ['start', 'stop', 'stop']);
  assert.equal(ctx.sauna.statusCode, 232);
});

test('credentials refused: a stop kept in /data, never tried again by itself', async (t) => {
  const server = fakeCloud();
  server.password = 'another one';
  const store = memoryStore();
  const ctx = await setup(t, { server, store });
  assert.equal(ctx.server.reads(), 1);
  assert.ok(store.data.block, 'kept in /data');
  assert.match(ctx.status().message.fr, /refusé l’adresse e-mail ou le mot de passe/);
  await ctx.advance(3 * 3600 * SECOND, 10 * SECOND);
  assert.equal(ctx.server.reads(), 1, 'never tried again by itself');
  // The test button tries once; still refused: the stop stays.
  const answer = await ctx.app.testConnection();
  assert.match(answer.fr, /Toujours refusé/);
  assert.equal(ctx.server.reads(), 2);
  assert.ok(store.data.block);
  // Within the interval: no read.
  await ctx.app.testConnection();
  assert.equal(ctx.server.reads(), 2);
  // Right credentials on the server side (the account was fixed): a success lifts it.
  server.password = PASSWORD;
  await ctx.advance(MINUTE);
  await ctx.app.testConnection();
  assert.equal(ctx.server.reads(), 3);
  assert.equal(store.data.block, null);
  assert.equal(ctx.status().connected, true);
});

test('a restart with the refused credentials does not read; new credentials do', async (t) => {
  const server = fakeCloud();
  server.password = 'another one';
  const store = memoryStore();
  const first = await setup(t, { server, store });
  first.app.stop();
  t.mock.timers.reset();
  const ctx = await setup(t, { server, store, now: NOW + 2 * MINUTE });
  assert.equal(server.reads(), 1, 'not read again after the restart');
  server.password = 'new one';
  await ctx.gladys.fake.configUpdated({ ...CFG, password: 'new one' });
  await settle();
  assert.equal(server.reads(), 2);
  assert.equal(store.data.block, null);
});

test('after a restart during a stop, the test button still waits for the interval', async (t) => {
  const salt = 'c'.repeat(32);
  const store = memoryStore({
    lastAttemptAt: NOW - 20 * SECOND,
    block: { salt, refused: refusedFingerprint(normalizeConfig(CFG), salt), status: 401 },
  });
  const ctx = await setup(t, { store, create: false });
  assert.equal(ctx.server.reads(), 0);
  const answer = await ctx.app.testConnection();
  assert.match(answer.fr, /Prochaine lecture/);
  assert.equal(ctx.server.reads(), 0, 'not sooner than the interval');
  await ctx.advance(2 * MINUTE, SECOND);
  assert.equal(ctx.server.reads(), 0, 'never by itself');
  await ctx.app.testConnection();
  assert.equal(ctx.server.reads(), 1);
  assert.equal(store.data.block, null, 'lifted by the success');
});

test('a 401 on a command refuses it and never stops the reads', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  ctx.server.statuses.start = 401;
  const ack = await ctx.press('heat-on');
  assert.match(String(ack.error), /Huum a refusé la commande \(HTTP 401\)/);
  assert.equal(ctx.app.blocked, false);
  const reads = ctx.server.reads();
  await ctx.advance(MINUTE + SECOND);
  assert.ok(ctx.server.reads() > reads);
});

test('429: a pause kept in /data, bounded, honoured after a restart', async (t) => {
  const server = fakeCloud();
  server.statuses.status = 429;
  server.retryAfter = 100_000;
  const store = memoryStore();
  const ctx = await setup(t, { server, store, config: HEAT_CFG });
  assert.equal(store.data.pause.reason, '429');
  assert.equal(store.data.pause.until, NOW + 6 * 3600 * SECOND, 'capped at 6 h');
  const ack = await ctx.press('heat-on');
  assert.match(String(ack.error), /ralentir/);
  await ctx.advance(30 * MINUTE, SECOND);
  assert.equal(server.reads(), 1, 'no read during the pause');
  ctx.app.stop();
  t.mock.timers.reset();
  await setup(t, { server, store, now: NOW + HOUR() });
  assert.equal(server.reads(), 1, 'still paused after a restart');
});

function HOUR() {
  return 60 * MINUTE;
}

test('5xx: a pause kept in /data, the next read after the backoff', async (t) => {
  const server = fakeCloud();
  server.statuses.status = 503;
  const store = memoryStore();
  const ctx = await setup(t, { server, store });
  assert.equal(store.data.pause.reason, '5xx');
  assert.match(ctx.status().message.fr, /5xx/);
  await ctx.advance(30 * SECOND, SECOND);
  assert.equal(server.reads(), 1);
  server.statuses.status = undefined;
  await ctx.advance(MINUTE, SECOND);
  assert.equal(server.reads(), 2);
  assert.equal(ctx.status().connected, true);
});

test('never read sooner than the interval: button, scan, reconnection, restart', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  assert.equal(ctx.server.reads(), 1);
  await ctx.app.testConnection();
  await ctx.app.scan();
  await ctx.app.connected(CFG);
  await ctx.app.configUpdated(CFG);
  await settle();
  assert.equal(ctx.server.reads(), 1);
  assert.equal(store.data.lastAttemptAt, NOW, 'written before the read');
  await ctx.advance(MINUTE, SECOND);
  assert.equal(ctx.server.reads(), 2);
  // A restart 10 s later waits for the interval.
  ctx.app.stop();
  t.mock.timers.reset();
  const again = await setup(t, { store, server: ctx.server, now: NOW + 70 * SECOND });
  assert.equal(ctx.server.reads(), 2);
  await again.advance(2 * MINUTE, SECOND);
  assert.ok(ctx.server.reads() >= 3);
});

test('a reconnection to Gladys sends the status and the Discovery list again, without a read', async (t) => {
  const ctx = await setup(t);
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  const discoveries = ctx.gladys.fake.requests.filter((r) => /discover/.test(r.path)).length;
  await ctx.app.connected(CFG);
  assert.equal(ctx.server.reads(), 1);
  assert.ok(ctx.gladys.fake.connectionStatuses.length > statuses, 'status sent again');
  assert.ok(
    ctx.gladys.fake.requests.filter((r) => /discover/.test(r.path)).length > discoveries,
    'Discovery sent again',
  );
});

test('a late answer for old credentials publishes nothing', async (t) => {
  const server = fakeCloud();
  const ctx = await setup(t, { server, create: false });
  server.delays.status = 5 * SECOND;
  server.sauna.saunaName = 'Old';
  await ctx.advance(MINUTE + SECOND);
  assert.equal(server.reads(), 2, 'a read in progress');
  // Other credentials (refused by the fake cloud) while the read is in progress.
  server.delays.status = 0;
  const updating = ctx.gladys.fake.configUpdated({ username: 'other@example.com', password: 'x' });
  await ctx.advance(10 * SECOND);
  await updating;
  assert.ok(
    !ctx.gladys.fake.discoveredDevices.some((d) => d.name === 'Old'),
    'the late answer published nothing',
  );
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.status().message.fr, /refusé/);
});

test('no secret in the logs nor in /data', async (t) => {
  const server = fakeCloud();
  const store = memoryStore();
  const ctx = await setup(t, { server, store, config: HEAT_CFG });
  await ctx.press('heat-on');
  await ctx.press('heat-off');
  server.password = 'refused';
  await ctx.advance(2 * MINUTE, SECOND);
  const text = JSON.stringify([ctx.logs, store.data, ctx.status()]);
  for (const secret of [PASSWORD, USER, Buffer.from(`${USER}:${PASSWORD}`).toString('base64')]) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
});

test('a device republished never loses the light feature once created', async (t) => {
  const server = fakeCloud();
  const ctx = await setup(t, { server });
  const roles = ctx.gladys.fake.discoveredDevices.at(-1).features.map((f) => f.external_id);
  assert.ok(roles.includes(feature('light')));
  delete server.sauna.light;
  await ctx.advance(MINUTE + SECOND, SECOND);
  await ctx.app.scan();
  const again = ctx.gladys.fake.discoveredDevices.at(-1).features.map((f) => f.external_id);
  assert.ok(again.includes(feature('light')), 'kept');
});

test('a command for another account is refused', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  const ack = await ctx.gladys.fake.setValue(
    { external_id: 'ext:test-integration:huum:0123456789abcdef' },
    { external_id: 'ext:test-integration:huum:0123456789abcdef:heat-off' },
    1,
  );
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /pas celui du compte/);
  const read = await ctx.gladys.fake.setValue(
    { external_id: DEVICE },
    { external_id: feature('temperature') },
    1,
  );
  assert.equal(read.success, false);
  assert.deepEqual(ctx.server.commands(), []);
});
