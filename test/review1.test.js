// -----------------------------------------------------------------------------
// Review 1 (xhigh): one test per point, the scenarios of the review turned
// round (what must happen now). B1 (HTTPS on the wire) is in test/tls.test.js.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { NOW, fakeCloud } from './fixtures/fakeHuum.js';
import { CFG, HEAT_CFG, setup } from './fixtures/setup.js';

const nowSec = () => Math.floor(Date.now() / 1000);

/** A sauna heating at 80 °C for one more hour. */
function heating(ctx) {
  ctx.sauna.statusCode = 231;
  ctx.sauna.targetTemperature = '80';
  ctx.sauna.endDate = nowSec() + 3600;
}

test('I1 (S3a, S3b): no heating command while a turn off is not confirmed', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  heating(ctx);
  // A controller 3 s late: the answer of the stop still shows the heating.
  ctx.server.applyDelays.stop = 3 * SECOND;
  const off = await ctx.press('heat-off', 1, SECOND);
  assert.match(String(off.error), /Envoyée, sans confirmation/);
  const setpoint = await ctx.press('target-temperature', 85, SECOND);
  assert.match(String(setpoint.error), /extinction est en cours ou pas encore confirmée/);
  const on = await ctx.press('heat-on', 1, SECOND);
  assert.equal(on.success, false, 'never "success" without sending');
  assert.match(String(on.error), /extinction est en cours ou pas encore confirmée/);
  assert.deepEqual(ctx.server.commands(), ['stop']);
  // A read shows the sauna stopped, nothing in flight: the turn off is confirmed.
  await ctx.advance(10 * SECOND, SECOND);
  assert.equal(ctx.sauna.statusCode, 232);
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal((await ctx.press('heat-on')).success, true);
});

test('I1: a setpoint is refused for 2 min after a turn off', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  heating(ctx);
  assert.equal((await ctx.press('heat-off', 1, SECOND)).success, true);
  // Heating again (from the Huum app): a setpoint must not follow the turn off.
  heating(ctx);
  const ack = await ctx.press('target-temperature', 85, SECOND);
  assert.match(String(ack.error), /consigne refusée pendant 2 min/);
  assert.deepEqual(ctx.server.commands(), ['stop']);
  await ctx.advance(2 * MINUTE, SECOND);
  assert.equal((await ctx.press('target-temperature', 85)).success, true);
  assert.deepEqual(ctx.server.commands(), ['stop', 'start']);
});

test('I2 (S1a, S1b): no setpoint at the end of a session, nor without its end', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  heating(ctx);
  ctx.sauna.endDate = nowSec() + 60;
  let ack = await ctx.press('target-temperature', 85);
  assert.match(String(ack.error), /séance se termine/);
  delete ctx.sauna.endDate;
  ack = await ctx.press('target-temperature', 85);
  assert.match(String(ack.error), /incomplet/);
  // The session ended before the fresh read: not heating any more.
  ctx.sauna.statusCode = 232;
  ack = await ctx.press('target-temperature', 85);
  assert.match(String(ack.error), /ne chauffe pas/);
  assert.deepEqual(ctx.server.commands(), []);
});

test('I2: a setpoint that starts a new session says so', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  heating(ctx);
  ctx.sauna.endDate = nowSec() + 20 * 60;
  const ack = await ctx.press('target-temperature', 85);
  assert.equal(ack.success, true, ack.error);
  assert.ok(
    ctx.logs.some((l) => /started a new session, until \d\d:\d\d UTC/.test(l)),
    'logged',
  );
});

test('I3 (S2a): an unconfirmed setpoint is confirmed only at the temperature asked', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  heating(ctx);
  ctx.server.statuses.start = 503;
  const ack = await ctx.press('target-temperature', 90);
  assert.match(String(ack.error), /Envoyée, sans confirmation \(HTTP 503\)/);
  assert.equal(ctx.app.startMayLand, true);
  // The follow-up read: heating, but at the old setpoint.
  await ctx.advance(10 * SECOND, SECOND);
  assert.equal(ctx.app.startMayLand, true, 'not confirmed by the old setpoint');
  // A turn off now keeps its guard: the late start is turned off again.
  ctx.server.statuses.start = undefined;
  assert.equal((await ctx.press('heat-off', 1, SECOND)).success, true);
  heating(ctx);
  ctx.sauna.targetTemperature = '90';
  await ctx.advance(40 * SECOND, SECOND);
  assert.deepEqual(ctx.server.commands(), ['start', 'stop', 'stop']);
  assert.equal(ctx.sauna.statusCode, 232);
});

test('I4 (S11a): a turn off without answer is reaffirmed while the sauna heats', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  heating(ctx);
  ctx.server.applies = false;
  ctx.server.delays.stop = 10 * SECOND;
  const ack = await ctx.press('heat-off');
  assert.match(String(ack.error), /Envoyée, sans confirmation \(pas encore de réponse\)/);
  await ctx.advance(3 * MINUTE, SECOND);
  assert.deepEqual(ctx.server.commands(), ['stop', 'stop', 'stop'], 'twice more at most');
});

test('I4 (S11b): a turn off answered 503 is reaffirmed', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  heating(ctx);
  ctx.server.statuses.stop = 503;
  const ack = await ctx.press('heat-off');
  assert.match(String(ack.error), /Envoyée, sans confirmation \(HTTP 503\)/);
  await ctx.advance(3 * MINUTE, SECOND);
  assert.deepEqual(ctx.server.commands(), ['stop', 'stop', 'stop']);
});

test('I5 (S5): a turn off is confirmed only by 232 or 400', async (t) => {
  const ctx = await setup(t);
  ctx.server.applies = false;
  for (const code of [230, 233, 999, 231]) {
    ctx.sauna.statusCode = code;
    const ack = await ctx.press('heat-off', 1, SECOND);
    assert.equal(ack.success, false, String(code));
    assert.match(String(ack.error), /Envoyée, sans confirmation \(le sauna répond/);
  }
  for (const code of [232, 400]) {
    ctx.sauna.statusCode = code;
    const ack = await ctx.press('heat-off', 1, SECOND);
    assert.equal(ack.success, true, String(code));
  }
});

test('I6 (S4a): the option turned off while the start connects: nothing written', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  ctx.server.connectDelays.start = 800;
  const on = ctx.fire('heat-on');
  await ctx.advance(300);
  await ctx.gladys.fake.configUpdated(CFG);
  await ctx.advance(5 * SECOND);
  const ack = await on;
  assert.match(String(ack.error), /Autoriser le chauffage/);
  assert.deepEqual(ctx.server.commands(), []);
  assert.equal(ctx.sauna.statusCode, 232);
});

test('I6 (S4b): a turn off while the start connects: the start is never written', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  ctx.server.connectDelays.start = 800;
  const on = ctx.fire('heat-on');
  await ctx.advance(300);
  const off = ctx.fire('heat-off');
  await ctx.advance(5 * SECOND);
  const [onAck, offAck] = await Promise.all([on, off]);
  assert.match(String(onAck.error), /extinction a été demandée/);
  assert.equal(offAck.success, true);
  assert.deepEqual(ctx.server.commands(), ['stop']);
  assert.equal(ctx.sauna.statusCode, 232);
});

test('M1 (S6): the guards of an account never reach another one', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  heating(ctx);
  ctx.server.applies = false;
  await ctx.press('heat-off', 1, SECOND);
  assert.ok(ctx.app.stopGuard, 'guard of account A');
  const updating = ctx.gladys.fake.configUpdated({ username: 'b@example.com', password: 'x' });
  await ctx.advance(SECOND);
  await updating;
  assert.equal(ctx.app.stopGuard, undefined);
  ctx.server.password = 'x';
  await ctx.advance(3 * MINUTE, SECOND);
  assert.deepEqual(ctx.server.commands(), ['stop'], 'no stop sent for account B');
});

test('M2 (S7): after a restart, the last good read shows "connected"', async (t) => {
  const store = memoryStore();
  const server = fakeCloud();
  const config = { ...CFG, poll_interval: 3600 };
  const first = await setup(t, { store, server, config });
  assert.ok(store.data.lastGood, 'kept in /data at the first good read');
  assert.ok(!JSON.stringify(store.data).includes('example.com'), 'no e-mail in /data');
  first.app.stop();
  t.mock.timers.reset();
  const ctx = await setup(t, { store, server, config, now: NOW + 70 * SECOND });
  assert.equal(server.reads(), 1, 'no read before the interval');
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.fr, /Connecté : En ligne, à l’arrêt.*Dernière lecture/);
});

test('M3: a 429 on a reaffirmed turn off opens the pause', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  heating(ctx);
  ctx.server.applies = false;
  await ctx.press('heat-off', 1, SECOND);
  ctx.server.statuses.stop = 429;
  await ctx.advance(10 * SECOND, SECOND);
  assert.deepEqual(ctx.server.commands(), ['stop', 'stop']);
  assert.equal(ctx.app.paused, true);
  assert.equal(ctx.store.data.pause.reason, '429');
});

test('M4 (S9): pressing "Turn on" in a loop while heating does not read at each press', async (t) => {
  const ctx = await setup(t, { config: HEAT_CFG });
  heating(ctx);
  await ctx.advance(MINUTE, SECOND);
  const reads = ctx.server.reads();
  for (let i = 0; i < 30; i += 1) {
    const ack = await ctx.press('heat-on', 1, SECOND);
    assert.equal(ack.success, true);
  }
  assert.ok(ctx.server.reads() - reads <= 4, `${ctx.server.reads() - reads} reads in 30 s`);
  assert.deepEqual(ctx.server.commands(), []);
});
