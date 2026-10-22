// -----------------------------------------------------------------------------
// The integration: the Huum account typed in the configuration (e-mail
// address and password, HTTP Basic), one read of the sauna every poll
// interval, its Gladys device and states, the transport badge, the "Test the
// connection" button, and the three commands. index.js only wires the SDK
// handlers to it (src/handlers.js).
//
// Reads follow the rules learnt on the previous modules:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart of the container (the time of the last
//     read is kept in /data, written BEFORE the read, at most once a
//     minute); a reconnection during a read joins nothing and reads nothing;
//   - an answer that arrives for an old configuration (generation) publishes
//     nothing and sets no status;
//   - credentials refused (401/403): a stop kept in /data, never tried again
//     by itself; lifted by other credentials, or by a success of the test
//     button (one read per interval at most); 429/5xx: a bounded pause kept
//     in /data.
//
// Commands:
//   - TURN ON and the SETPOINT (both sent to Huum as a start) are sensitive:
//     refused unless "Allow heating from Gladys" is on, checked on arrival
//     and again right before sending; decided on a fresh read only (never on
//     the state in memory), refused when a value they need is missing, when
//     the door is open, or when the sauna cannot heat; the temperature never
//     above the "Highest setpoint" (90 °C by default, 110 °C at most); sent
//     within 3.5 s of the click or refused unsent; answered by 4.3 s; one at
//     a time, never retried; confirmed only by an answer showing the sauna
//     heating at the temperature asked, else "sent, without confirmation";
//   - TURN OFF protects: never held back, outside any queue: not by the
//     option, a heating command in flight, a 429/5xx pause or a stop on
//     refused credentials (one request then), and possible before the first
//     read after a restart (the device id comes from the configuration). It
//     cancels a heating command not sent yet; a turn off sent while a heating
//     command may still land is sent again when that command settles, and
//     reaffirmed (twice at most) by the reads of the next two minutes if the
//     sauna heats again;
//   - the ack never waits for a publication to Gladys.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { credentialsKey, normalizeConfig, refusedFingerprint, usable } from './config.js';
import { FEATURES, PRESSED, SECOND, STATUS, TEMPERATURE, TIMINGS } from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  parseDeviceId,
  parseFeatureId,
  saunaIds,
  statesOf,
} from './devices.js';
import { ERRORS, T, age, join, statusText, word } from './i18n.js';
import { HuumClient, errorReason } from './huum/client.js';
import { ERROR_KINDS } from './huum/http.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

const freshSauna = () => ({
  /** The last state read (src/huum/client.js parseStatus), else undefined. */
  data: undefined,
  /** When a polling or command read last succeeded. */
  readAt: -Infinity,
  /** undefined: not read yet since the start; false: the last read failed. */
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

/** A refusal: its message is shown by Gladys; nothing was sent. */
class Refusal extends Error {}

export class HuumApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'huum' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new HuumClient({ transport, now });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    this.sauna = freshSauna();
    this.generation = 0;
    this.started = false;
    this.pausedUntil = 0;
    /** The time of the last read sent to Huum (exact; /data keeps it within a minute). */
    this.lastAttemptAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.dirty = false;
    /** When the last command left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** When the last heating command (start) left. */
    this.lastStartAt = -Infinity;
    /** Until then, a heating command sent without confirmation may still land. */
    this.unconfirmedStartUntil = -Infinity;
    /** The heating command in progress: { seq, sentAt, answered, promise }. */
    this.startEntry = undefined;
    /** Counts the turn offs: a heating command that sees it change gives way. */
    this.protectSeq = 0;
    /** A turn off to reaffirm while a heating command may land after it. */
    this.stopGuard = undefined;
    /** The temperature of the heating command sent without confirmation. */
    this.unconfirmedTarget = undefined;
    /** Stop requests in flight (every heating command waits for them). */
    this.stopsInFlight = 0;
    /** When the last turn off left (a setpoint waits 2 min after it). */
    this.lastStopAt = -Infinity;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for new credentials while running (a read may go at
   * once); otherwise (container start) the first read waits for the interval
   * after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    // The guards belong to the account they were set for: another account
    // never gets a turn off it did not ask for, nor confirms a start of the
    // old one.
    this.stopGuard = undefined;
    this.unconfirmedStartUntil = -Infinity;
    this.unconfirmedTarget = undefined;
    await this.sauna.running;
    const generation = this.generation;
    this.config = normalizeConfig(raw);
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    if (generation !== this.generation) {
      return;
    }
    if (this.memory.pause) {
      this.pausedUntil = Math.max(this.pausedUntil, this.memory.pause.until);
    }
    if (this.memory.lastAttemptAt !== null) {
      // The last read kept in /data (written at most once a minute: it may
      // have left up to a minute later). The polling and the test button wait
      // for the interval after it, a stop on refused credentials included.
      this.lastAttemptAt = Math.max(
        this.lastAttemptAt,
        Math.min(this.now(), this.memory.lastAttemptAt + TIMINGS.attemptWriteEvery),
      );
    }
    // Other credentials than the ones refused (changed while the container was down): lifted.
    const block = this.memory.block;
    if (
      block &&
      this.config.auth &&
      (!block.refused || block.refused !== refusedFingerprint(this.config, block.salt))
    ) {
      this.memory.block = null;
      await this.saveMemory();
      if (generation !== this.generation) {
        return;
      }
    }
    this.sauna = freshSauna();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!usable(this.config) || this.blocked) {
      // The devices already created are shown unreachable; the status says why.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1]);
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    return Math.min(this.interval, Math.max(0, this.due - this.now()));
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.sauna.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.sauna.followUps.clear();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.sauna.timer) {
      this.timers.clearTimeout(this.sauna.timer);
      this.sauna.timer = undefined;
    }
  }

  /** Only new credentials restart (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      next.badUser !== this.config.badUser ||
      next.badSecret !== this.config.badSecret ||
      credentialsKey(next) !== credentialsKey(this.config)
    );
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badge) and the
   * last states, without reading Huum. Pauses and stops stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** A new interval: the next read follows it, counted from the last read. */
  rescheduleOnNewInterval(previous) {
    const s = this.sauna;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      usable(this.config) &&
      !s.running &&
      s.online !== false &&
      s.timer
    ) {
      this.schedule();
    }
  }

  async configUpdated(raw = {}) {
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowHeating !== previous.allowHeating) {
      this.logger.info(`Huum heating from Gladys ${this.config.allowHeating ? 'allowed' : 'off'}`);
    }
    if (this.config.language !== previous.language) {
      this.published = undefined;
    }
    await this.publishAll();
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async saveMemory() {
    this.dirty = false;
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  // --- Credentials -----------------------------------------------------------

  /** Credentials refused: nothing is read until other credentials or a success of the button. */
  get blocked() {
    return Boolean(this.memory.block);
  }

  /** The credentials refused (401/403): a stop kept in /data, never tried again by itself. */
  async authFailed(status) {
    const salt = this.memory.block?.salt ?? randomBytes(16).toString('hex');
    this.memory.block = {
      salt,
      refused: this.config.auth ? refusedFingerprint(this.config, salt) : null,
      status: status === 403 ? 403 : 401,
    };
    this.clearTimer();
    await this.saveMemory();
    this.logger.warn(`Huum: credentials refused (HTTP ${status}); stopped until they change`);
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  get paused() {
    return this.now() < this.pausedUntil;
  }

  /** The earliest time the next polling read may go: the interval after the last one. */
  get due() {
    return this.lastAttemptAt + this.interval;
  }

  /**
   * The next read: after a pause, after its backoff, else the interval; never
   * sooner than the interval after the last read; none while stopped.
   */
  schedule(delay) {
    const s = this.sauna;
    this.clearTimer();
    if (this.blocked || !usable(this.config)) {
      return;
    }
    let wait;
    if (this.paused) {
      wait = this.pausedUntil - this.now();
    } else {
      wait = delay ?? (s.online === false ? s.wait : this.interval);
    }
    // Capped at the interval: a clock set back never stops the reads.
    wait = Math.max(wait ?? this.interval, Math.min(this.interval, this.due - this.now()), 0);
    const generation = this.generation;
    s.timer = this.timers.setTimeout(() => {
      s.timer = undefined;
      if (generation === this.generation) {
        this.tick().catch(() => this.logger.error('Huum refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. `force`: the button, during a stop. */
  tick({ force = false } = {}) {
    const s = this.sauna;
    if (!s.running) {
      s.running = this.run({ force }).finally(() => {
        s.running = undefined;
      });
    }
    return s.running;
  }

  /**
   * Keeps the time of this read; when the write of the minute is due, in
   * /data BEFORE the read (a container stopped during the read keeps it).
   */
  async noteAttempt() {
    const now = this.now();
    this.lastAttemptAt = now;
    const stored = this.memory.lastAttemptAt;
    if (stored === null || now - stored >= TIMINGS.attemptWriteEvery) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
  }

  async run({ force = false } = {}) {
    const generation = this.generation;
    if (!usable(this.config)) {
      return;
    }
    if (this.paused || (this.blocked && !force)) {
      await this.publishAll();
      if (generation === this.generation) {
        this.schedule();
      }
      return;
    }
    let delay;
    const startedAt = this.now();
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    try {
      const status = await this.client.status(this.config.auth, {
        timeoutMs: TIMINGS.readTimeout,
      });
      if (generation !== this.generation) {
        return;
      }
      if (this.memory.block) {
        // Accepted: the fingerprint of the refused credentials goes with the stop.
        this.memory.block = null;
        this.dirty = true;
        this.logger.info('Huum: credentials accepted again');
      }
      if (startedAt <= this.lastSentAt) {
        // Begun before a command left: it may show the state before it.
        this.logger.debug('Huum: read begun before a command, not applied');
        this.sauna.online = true;
        this.sauna.failures = 0;
      } else {
        this.applyRead(status);
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      delay = await this.failed(err);
      if (generation !== this.generation) {
        return;
      }
    }
    if (this.dirty) {
      await this.saveMemory();
      if (generation !== this.generation) {
        return;
      }
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** A status read (polling, fresh read of a command, or the answer of a command). */
  applyRead(status, { fromCommand = false } = {}) {
    const s = this.sauna;
    s.online = true;
    s.failures = 0;
    s.wait = undefined;
    s.error = undefined;
    s.readAt = this.now();
    s.data = status;
    this.rememberLastGood(status);
    this.observe(status, { fromCommand });
  }

  /** A salted fingerprint of the account, to tell whose last read /data keeps. */
  goodKey(salt) {
    return createHash('sha256')
      .update(`huum-good\0${salt}\0${this.config.accountId ?? ''}`)
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * The summary of a good read, in memory; written to /data with the time of
   * the next read (at most once a minute). After a restart it shows
   * "connected" until the first read (2 h at most, same account only).
   */
  rememberLastGood(status) {
    if (!this.config.accountId) {
      return;
    }
    const previous = this.memory.lastGood;
    const salt = previous?.salt ?? randomBytes(16).toString('hex');
    if (!previous || previous.account !== this.goodKey(salt)) {
      // The first good read of this account: written at the end of the read
      // (the next ones go with the time of the next read, once a minute).
      this.dirty = true;
    }
    this.memory.lastGood = {
      salt,
      account: this.goodKey(salt),
      at: this.now(),
      summary: T.summary(status),
    };
  }

  /** The last good read kept in /data for this account, recent enough, else undefined. */
  keptGood() {
    const good = this.memory.lastGood;
    if (
      !good ||
      good.account !== this.goodKey(good.salt) ||
      this.now() - good.at >= TIMINGS.lastGoodMax
    ) {
      return undefined;
    }
    return good;
  }

  /** A failed read: the delay before the next one. */
  async failed(err) {
    const s = this.sauna;
    const reason = errorReason(err);
    if (err.kind === ERROR_KINDS.AUTH) {
      s.online = false;
      s.error = reason;
      await this.authFailed(err.status);
      return undefined;
    }
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      // Huum answers: the status shows the pause.
      await this.pause(err);
      this.logger.warn(`Huum: ${reason}, pause`);
      return undefined;
    }
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(s.failures, TIMINGS.backoff.length - 1)],
    );
    s.failures += 1;
    s.online = false;
    s.wait = wait;
    s.error = reason;
    if (err.kind === ERROR_KINDS.HTTP && err.status >= 500) {
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      this.memory.pause = { until: this.pausedUntil, reason: '5xx' };
      await this.saveMemory();
    }
    this.logger.warn(`Huum: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** A 429: a bounded pause kept in /data (turning off still goes). */
  async pause(err) {
    const wait = Math.min(
      TIMINGS.rateLimitMax,
      Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
    );
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.memory.pause = { until: this.pausedUntil, reason: '429' };
    await this.saveMemory();
  }

  pauseMessage() {
    if (!this.paused) {
      return undefined;
    }
    const wait = age(this.pausedUntil - this.now());
    return this.memory.pause?.reason === '5xx' ? T.serverError(wait) : T.rateLimited(wait);
  }

  /** `[connected, message]` of the configuration screen. */
  status() {
    const s = this.sauna;
    const c = this.config;
    if (!c.auth) {
      if (c.badUser) {
        return [false, T.badUser];
      }
      return [false, c.badSecret ? T.badSecret : T.noCredentials];
    }
    if (this.blocked) {
      return [false, T.refused(this.memory.block.status)];
    }
    const pause = this.pauseMessage();
    if (pause) {
      return [false, pause];
    }
    if (s.online === false) {
      return [false, T.unreachable(s.error ?? 'error', age(s.wait ?? this.interval))];
    }
    if (s.online === undefined || !s.data) {
      const good = this.keptGood();
      if (s.timer && good) {
        // After a restart: the last good read kept in /data, until the next read.
        return [true, join(T.connected(good.summary), T.lastRead(age(this.now() - good.at)))];
      }
      return [false, s.timer ? T.waiting(age(Math.max(0, this.due - this.now()))) : T.connecting];
    }
    return [true, T.connected(T.summary(s.data))];
  }

  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  // --- Gladys ----------------------------------------------------------------

  /** The device external id of the configured account, else undefined. */
  get deviceId() {
    return this.config.accountId ? saunaIds(this.gladys, this.config.accountId).device : undefined;
  }

  /** The roles of the device already created in Gladys for the account. */
  createdRoles() {
    const device = (this.gladys.devices ?? []).find((d) => d.external_id === this.deviceId);
    const roles = new Set();
    for (const f of device?.features ?? []) {
      const parsed = parseFeatureId(f?.external_id);
      if (parsed) {
        roles.add(parsed.role);
      }
    }
    return roles;
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    this.queueStates();
    await this.flush();
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadge();
    if (generation !== this.generation) {
      return;
    }
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const data = this.sauna.data;
    if (!data || !this.config.accountId) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, this.config.accountId, data, {
        language: this.config.language,
        created: this.createdRoles(),
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    const data = this.sauna.data;
    if (!data || !this.config.accountId) {
      return;
    }
    const ids = saunaIds(this.gladys, this.config.accountId);
    for (const { role, ...value } of statesOf(data, {
      now: this.now(),
      language: this.config.language,
    })) {
      const id = ids.feature(role);
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  /** The badge of every Huum device created: the account's, and those of other accounts. */
  async publishBadge() {
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const id = parseDeviceId(device?.external_id);
      if (!id || saunaIds(this.gladys, id).device !== device.external_id) {
        continue;
      }
      const reachable =
        id === this.config.accountId &&
        this.sauna.online !== false &&
        !this.blocked &&
        this.sauna.data?.code !== STATUS.OFFLINE;
      entries.push({
        external_id: device.external_id,
        transport: reachable ? DEVICE_TRANSPORTS.CLOUD : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  /**
   * A read now, unless the last one is more recent than the interval (then
   * its result). During a stop on refused credentials, that read is the one
   * new try: the stop is lifted only by a success.
   */
  async testConnection() {
    if (!usable(this.config) || this.paused) {
      return this.status()[1];
    }
    const s = this.sauna;
    const current = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status()[1];
    if (s.running) {
      await s.running;
      return current();
    }
    if (this.now() < this.due) {
      const last = this.status()[1];
      const waited = T.waiting(age(this.due - this.now()));
      return Number.isFinite(this.lastAttemptAt) && s.online !== undefined
        ? join(join(last, T.lastRead(age(this.now() - this.lastAttemptAt))), waited)
        : join(last, waited);
    }
    const wasBlocked = this.blocked;
    this.clearTimer();
    await this.tick({ force: true });
    if (wasBlocked && this.blocked) {
      return join(T.stillRefused, current());
    }
    return current();
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  /** A setpoint from Gladys: a whole number of °C (75 or "75"), else undefined. */
  static setpointOf(value) {
    let n;
    if (typeof value === 'number') {
      n = value;
    } else if (typeof value === 'string' && /^\s*\d{1,3}(?:\.0+)?\s*$/.test(value)) {
      n = Number(value);
    }
    return Number.isInteger(n) ? n : undefined;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (!this.config.auth) {
      throw this.refusal(ERRORS.noConfig);
    }
    if (target.id !== this.config.accountId) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (target.role === FEATURES.TARGET) {
      const temperature = HuumApp.setpointOf(value);
      if (
        temperature === undefined ||
        temperature < TEMPERATURE.min ||
        temperature > this.config.maxTemperature
      ) {
        throw this.refusal(ERRORS.badSetpoint(TEMPERATURE.min, this.config.maxTemperature));
      }
      return this.heat(target.id, received, { setpoint: true, temperature });
    }
    // Strictly 1: null, '', true, 0 or "on" never press a button.
    if (value !== PRESSED && value !== String(PRESSED)) {
      throw this.refusal(ERRORS.badButton);
    }
    if (target.role === FEATURES.HEAT_OFF) {
      return this.turnOff(received);
    }
    return this.heat(target.id, received, { setpoint: false });
  }

  /**
   * The checks of a heating command, on the latest configuration: on
   * arrival, after the fresh read, and right before its first byte
   * (beforeSend). A turn off in flight, or not confirmed yet (its guard),
   * refuses every heating command; a setpoint is also refused for 2 min
   * after a turn off when nothing was turned on since (a setpoint never
   * turns the sauna on again).
   */
  checkHeat(generation, id, entry, order) {
    if (!this.config.allowHeating) {
      throw this.refusal(ERRORS.heatingDisabled);
    }
    if (generation !== this.generation || !this.config.auth || id !== this.config.accountId) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (this.paused) {
      const wait = age(this.pausedUntil - this.now());
      throw this.refusal(
        this.memory.pause?.reason === '5xx' ? ERRORS.serverPaused(wait) : ERRORS.paused(wait),
      );
    }
    if (this.blocked) {
      throw this.refusal(ERRORS.blocked);
    }
    if (entry && entry.seq !== this.protectSeq) {
      throw this.refusal(ERRORS.stopMeanwhile);
    }
    if (this.stopsInFlight > 0 || this.stopGuardActive()) {
      throw this.refusal(ERRORS.stopPending);
    }
    if (
      order?.setpoint &&
      this.now() - this.lastStopAt < TIMINGS.setpointAfterStop &&
      this.lastStartAt <= this.lastStopAt
    ) {
      throw this.refusal(ERRORS.justStopped);
    }
  }

  /** Turn on, or a new setpoint: one at a time. */
  async heat(id, received, order) {
    const generation = this.generation;
    this.checkHeat(generation, id, undefined, order);
    if (this.startEntry) {
      throw this.refusal(ERRORS.busy);
    }
    const entry = { seq: this.protectSeq, sentAt: undefined, answered: false, promise: undefined };
    this.startEntry = entry;
    entry.promise = this.sendHeat(id, received, generation, entry, order);
    try {
      return await entry.promise;
    } finally {
      entry.answered = true;
      if (this.startEntry === entry) {
        this.startEntry = undefined;
      }
    }
  }

  /** The fresh read of a command, within `budget` ms; applied when no command left meanwhile. */
  async freshRead(budget, startBy) {
    const readStart = this.now();
    const generation = this.generation;
    const status = await this.client.status(this.config.auth, { timeoutMs: budget, startBy });
    if (generation === this.generation && readStart > this.lastSentAt) {
      this.applyRead(status, { fromCommand: true });
      // Shown in the background: the ack never waits for Gladys.
      this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
    }
    return status;
  }

  /** The answer of a command, shown in the background (never for an old configuration). */
  showAnswer(status, generation) {
    if (generation !== this.generation) {
      return;
    }
    this.applyRead(status, { fromCommand: true });
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
  }

  /**
   * Nothing to send, as a read of less than 10 s shows it (a scene pressing
   * in a loop never reads the cloud at each press). Deciding to SEND always
   * takes a fresh read.
   */
  nothingToSend(order) {
    const s = this.sauna;
    if (!s.data || this.now() - s.readAt >= TIMINGS.recentRead || s.data.code !== STATUS.HEATING) {
      return false;
    }
    return !order.setpoint || s.data.target === order.temperature;
  }

  async sendHeat(id, received, generation, entry, order) {
    if (this.nothingToSend(order)) {
      this.checkHeat(generation, id, entry, order);
      return undefined;
    }
    const sendBy = received + TIMINGS.commandSendBy;
    const budget = Math.min(TIMINGS.commandReadMax, sendBy - TIMINGS.commandMinSend - this.now());
    if (budget < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    let fresh;
    try {
      fresh = await this.freshRead(budget, sendBy - TIMINGS.commandMinSend);
    } catch (err) {
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        await this.pause(err);
        this.updateStatus().catch(() => {});
      }
      // A 401/403 here refuses this command only: it never stops the reads.
      throw this.refusal(ERRORS.unknownState(errorReason(err)));
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    // Decided on the fresh read only, never on the state in memory.
    if (fresh.doorClosed === undefined) {
      throw this.refusal(ERRORS.missing);
    }
    let temperature;
    if (order.setpoint) {
      if (fresh.code !== STATUS.HEATING) {
        throw this.refusal(ERRORS.notHeating);
      }
      if (fresh.target === undefined) {
        throw this.refusal(ERRORS.missing);
      }
      temperature = order.temperature;
      if (fresh.target === temperature) {
        // Already the setpoint read: nothing to send (a turn off meanwhile still refuses).
        this.checkHeat(generation, id, entry, order);
        return undefined;
      }
      // A setpoint is a start for Huum: near the end of the session it would
      // start a whole new one.
      if (fresh.endDate === undefined) {
        throw this.refusal(ERRORS.missing);
      }
      if (fresh.endDate * 1000 - this.now() < TIMINGS.sessionEndMargin) {
        throw this.refusal(ERRORS.sessionEnding);
      }
    } else {
      if (fresh.code === STATUS.HEATING) {
        // Already heating, as read: nothing sent (a turn off meanwhile still refuses).
        this.checkHeat(generation, id, entry, order);
        return undefined;
      }
      if (fresh.code !== STATUS.IDLE) {
        throw this.refusal(ERRORS.cannotStart(statusText(fresh.code)));
      }
      temperature = this.config.startTemperature;
    }
    if (!fresh.doorClosed) {
      throw this.refusal(ERRORS.doorOpen);
    }
    // The checks again: right now, then right before the first byte.
    const lastChecks = () => {
      this.checkHeat(generation, id, entry, order);
      if (this.startMayLand) {
        throw this.refusal(ERRORS.inProgress);
      }
      if (temperature > this.config.maxTemperature) {
        throw this.refusal(ERRORS.badSetpoint(TEMPERATURE.min, this.config.maxTemperature));
      }
      if (this.now() > sendBy) {
        throw this.refusal(ERRORS.tooSlow);
      }
    };
    lastChecks();
    const timeoutMs = Math.max(200, received + TIMINGS.commandAnswerBy - this.now());
    const previous = { sentAt: this.lastSentAt, startAt: this.lastStartAt };
    let answer;
    try {
      answer = await this.client.start(this.config.auth, temperature, {
        startBy: sendBy,
        timeoutMs,
        // beforeSend: the option, a turn off, the deadline, checked once
        // connected; the start counts as sent from that moment only.
        beforeSend: () => {
          lastChecks();
          this.lastSentAt = this.now();
          this.lastStartAt = this.now();
          entry.sentAt = this.now();
          this.logger.info(`Huum: heat at ${temperature} °C`);
        },
      });
    } catch (err) {
      if (err instanceof Refusal) {
        // Refused by the last checks: nothing written.
        throw err;
      }
      const reason = errorReason(err);
      this.logger.warn(`Huum: heating command failed (${reason})`);
      if (err.kind === ERROR_KINDS.LATE || err.kind === ERROR_KINDS.UNREACHABLE || err.notSent) {
        // Nothing left: the times of the last request and start are as before.
        entry.sentAt = undefined;
        this.lastSentAt = previous.sentAt;
        this.lastStartAt = previous.startAt;
        throw this.refusal(err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        await this.pause(err);
        this.updateStatus().catch(() => {});
        throw this.refusal(ERRORS.refused(reason));
      }
      if (err.kind === ERROR_KINDS.AUTH || (err.kind === ERROR_KINDS.HTTP && err.status < 500)) {
        // Received and refused. A 401/403 here never stops the reads.
        this.followUp();
        throw this.refusal(ERRORS.refused(reason));
      }
      // A 5xx, a silence, a broken answer: it may have reached Huum.
      this.unconfirmed(temperature);
      this.followUp();
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    this.showAnswer(answer, generation);
    this.followUp();
    if (answer.code !== STATUS.HEATING || answer.target !== temperature) {
      this.unconfirmed(temperature);
      throw this.refusal(
        ERRORS.sentUnconfirmed(ERRORS.answered(statusText(answer.code))[this.lang]),
      );
    }
    // Confirmed by the answer: heating at the temperature asked.
    this.unconfirmedStartUntil = -Infinity;
    this.unconfirmedTarget = undefined;
    if (
      order.setpoint &&
      answer.endDate !== undefined &&
      answer.endDate - fresh.endDate > TIMINGS.relaunchSlack / 1000
    ) {
      // Huum started a new session for the setpoint: said in the log and the ack data.
      const message = ERRORS.relaunched(
        new Date(answer.endDate * 1000).toISOString().slice(11, 16),
      );
      this.logger.warn(`Huum: ${message.en}`);
      return { message: message[this.lang] };
    }
    return undefined;
  }

  /** A heating command that may land later: its guard, with the temperature asked. */
  unconfirmed(temperature) {
    this.unconfirmedStartUntil = this.now() + TIMINGS.guard;
    this.unconfirmedTarget = temperature;
  }

  /** A heating command may still land: in flight (sent, not answered), or sent without confirmation. */
  get startMayLand() {
    return (
      (this.startEntry?.sentAt !== undefined && !this.startEntry.answered) ||
      this.now() < this.unconfirmedStartUntil
    );
  }

  stopGuardActive() {
    if (this.stopGuard && this.now() >= this.stopGuard.until) {
      this.stopGuard = undefined;
    }
    return Boolean(this.stopGuard);
  }

  /** Keeps (or sets) the guard of a turn off sent at `sentAt`: the reads reaffirm it. */
  guardStop(sentAt) {
    if (!this.stopGuardActive()) {
      this.stopGuard = {
        sentAt,
        until: this.now() + TIMINGS.guard,
        reasserts: 0,
        key: credentialsKey(this.config),
      };
    }
  }

  /**
   * One stop request, counted while in flight (every heating command waits
   * for it). `background`: a resend or a reaffirmation, whose 429 opens the
   * pause like any other path.
   */
  sendStop(auth, { background = false } = {}) {
    this.stopsInFlight += 1;
    const sending = this.client.stop(auth, { timeoutMs: TIMINGS.protectTimeout });
    sending
      .finally(() => {
        this.stopsInFlight -= 1;
      })
      .catch(() => {});
    if (!background) {
      return sending;
    }
    return sending.catch(async (err) => {
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        await this.pause(err);
        this.updateStatus().catch(() => {});
      }
      throw err;
    });
  }

  /**
   * TURN OFF: never held back, one request, no read before it (it decides
   * nothing: it is always sent, never answered "already off"). Confirmed
   * only by an answer showing the sauna stopped (232, or 400 emergency stop);
   * any turn off that may have left without that gets a guard: the reads of
   * the next 2 min send it again (twice at most) if the sauna heats.
   */
  async turnOff(received) {
    // A heating command not sent yet gives way.
    this.protectSeq += 1;
    const generation = this.generation;
    const overtaken = this.startEntry;
    const sentAt = this.now();
    this.lastSentAt = sentAt;
    this.lastStopAt = sentAt;
    if (this.startMayLand) {
      this.guardStop(sentAt);
    }
    this.logger.info('Huum: turn off');
    const sending = this.sendStop(this.config.auth);
    if (overtaken?.sentAt !== undefined && !overtaken.answered) {
      this.stopAgain(overtaken, sentAt);
    }
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.now());
    let late;
    const outcome = await new Promise((resolve) => {
      late = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      sending.then(
        (answer) => resolve({ answer }),
        (err) => resolve({ err }),
      );
    });
    this.timers.clearTimeout(late);
    this.followUp();
    if (outcome.late) {
      // Still going after the ack (bounded by its own timeout): shown and logged when it ends.
      this.guardStop(sentAt);
      sending.then(
        (answer) => this.showAnswer(answer, generation),
        (err) => this.logger.warn(`Huum: turn off failed after the ack (${errorReason(err)})`),
      );
      throw this.refusal(ERRORS.sentUnconfirmed(ERRORS.noAnswerYet[this.lang]));
    }
    if (outcome.err) {
      const err = outcome.err;
      const reason = errorReason(err);
      this.logger.warn(`Huum: turn off failed (${reason})`);
      if (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.LATE || err.notSent) {
        throw this.refusal(ERRORS.notSent(reason));
      }
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        await this.pause(err);
        this.updateStatus().catch(() => {});
        throw this.refusal(ERRORS.refused(reason));
      }
      if (err.kind === ERROR_KINDS.AUTH || (err.kind === ERROR_KINDS.HTTP && err.status < 500)) {
        throw this.refusal(ERRORS.refused(reason));
      }
      // A silence, a 5xx, a broken answer: it may have reached Huum.
      this.guardStop(sentAt);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    const answer = outcome.answer;
    this.showAnswer(answer, generation);
    if (answer.code !== STATUS.IDLE && answer.code !== STATUS.EMERGENCY_STOP) {
      // Heating, offline, locked, unknown: not confirmed; the reads send it again if it heats.
      this.guardStop(sentAt);
      throw this.refusal(
        ERRORS.sentUnconfirmed(ERRORS.answered(statusText(answer.code))[this.lang]),
      );
    }
    return undefined;
  }

  get lang() {
    return this.config.language === 'en' ? 'en' : 'fr';
  }

  /**
   * A turn off that overtook a heating command already sent: sent once more
   * when that command settles (no read, no option check: it repeats a turn
   * off decided). A failure keeps the reaffirmation by the reads (the guard).
   */
  stopAgain(startEntry, stopAt) {
    const auth = this.config.auth;
    startEntry.promise
      .catch(() => {})
      .then(async () => {
        if (this.lastStartAt > stopAt || credentialsKey(this.config) !== credentialsKey({ auth })) {
          return;
        }
        this.logger.warn('Huum: turn off sent again after the heating command in flight');
        this.lastSentAt = this.now();
        await this.sendStop(auth, { background: true });
      })
      .catch((err) => {
        this.logger.warn(`Huum: turn off again failed (${errorReason(err)})`);
        if (credentialsKey(this.config) === credentialsKey({ auth })) {
          this.guardStop(stopAt);
        }
        this.followUp();
      })
      .catch(() => {});
  }

  /**
   * A read through the guards: a heating command confirmed (heating at the
   * temperature asked); a turn off confirmed (stopped, nothing in flight), or
   * reaffirmed if heating came back (same account only).
   */
  observe(status, { fromCommand = false } = {}) {
    if (
      status.code === STATUS.HEATING &&
      this.now() < this.unconfirmedStartUntil &&
      status.target === this.unconfirmedTarget
    ) {
      // Heating at the temperature asked: the command landed, it cannot land any more.
      this.unconfirmedStartUntil = -Infinity;
      this.unconfirmedTarget = undefined;
    }
    if (!this.stopGuardActive()) {
      return;
    }
    const guard = this.stopGuard;
    if (guard.key !== credentialsKey(this.config)) {
      this.stopGuard = undefined;
      return;
    }
    if (status.code !== STATUS.HEATING) {
      if (
        (status.code === STATUS.IDLE || status.code === STATUS.EMERGENCY_STOP) &&
        this.stopsInFlight === 0 &&
        !this.startMayLand
      ) {
        // Stopped, and nothing may land any more: the turn off is confirmed.
        this.stopGuard = undefined;
      }
      return;
    }
    const startInFlight = this.startEntry?.sentAt !== undefined && !this.startEntry.answered;
    if (
      !fromCommand &&
      this.lastStartAt <= guard.sentAt &&
      !startInFlight &&
      guard.reasserts < TIMINGS.stopReasserts
    ) {
      guard.reasserts += 1;
      this.logger.warn('Huum: the sauna heats again after a turn off, turn off sent again');
      this.lastSentAt = this.now();
      this.sendStop(this.config.auth, { background: true })
        .then(() => this.followUp())
        .catch((err) => this.logger.warn(`Huum: turn off reaffirmed failed (${errorReason(err)})`));
    }
  }

  /**
   * Spaced reads after a command: its effect, then a check. One series
   * pending at a time (a scene pressing in a loop never multiplies them).
   */
  followUp() {
    const generation = this.generation;
    const s = this.sauna;
    for (const handle of s.followUps) {
      this.timers.clearTimeout(handle);
    }
    s.followUps.clear();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        s.followUps.delete(handle);
        if (generation === this.generation && !this.paused && !this.blocked) {
          Promise.resolve(s.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('Huum refresh failed'));
        }
      }, delay);
      s.followUps.add(handle);
    }
  }
}
