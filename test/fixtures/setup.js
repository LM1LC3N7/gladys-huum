// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake Huum cloud, with
// the exact wiring of the container and a mocked clock (shared by the tests).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HuumApp } from '../../src/app.js';
import { accountIdOf } from '../../src/config.js';
import { SECOND } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { NOW, PASSWORD, USER, fakeCloud, settle } from './fakeHuum.js';

export const CFG = { username: USER, password: PASSWORD };
export const HEAT_CFG = { ...CFG, allow_heating: true };
export const ACCOUNT = accountIdOf(USER);
export const DEVICE = `ext:test-integration:huum:${ACCOUNT}`;
export const feature = (role) => `${DEVICE}:${role}`;

export async function setup(
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
