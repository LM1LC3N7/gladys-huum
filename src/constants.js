// -----------------------------------------------------------------------------
// Huum constants, limits and timings.
//
// A Huum sauna heater with its UKU Wi-Fi controller is reached through the
// Huum cloud, as the `huum` Python library (MIT, frwickst/pyhuum 0.8.3, the
// library of the Huum integration of Home Assistant) calls it:
//   GET  https://sauna.huum.eu/action/home/status   the state of the sauna
//   POST https://sauna.huum.eu/action/home/start    {"targetTemperature": t}: heats (or a new setpoint)
//   POST https://sauna.huum.eu/action/home/stop     stops heating
// with HTTP Basic authentication (the e-mail address and password of the Huum
// app). Each answer is the status of the sauna. There is no application key:
// the integration says who it is (User-Agent `gladys-huum`), it never poses as
// the Huum app.
// -----------------------------------------------------------------------------

export const API = {
  host: 'sauna.huum.eu',
  port: 443,
  userAgent: 'gladys-huum',
};

export const PATHS = {
  status: '/action/home/status',
  start: '/action/home/start',
  stop: '/action/home/stop',
};

/** `statusCode` of the status answer (pyhuum `SaunaStatus`). */
export const STATUS = {
  OFFLINE: 230,
  HEATING: 231,
  IDLE: 232,
  LOCKED: 233,
  EMERGENCY_STOP: 400,
};

/**
 * The temperatures the controller accepts (pyhuum MIN_TEMP, MAX_TEMP), in °C.
 * The integration never asks for more than the "Highest setpoint" of the
 * configuration (90 °C by default), itself never above 110 °C.
 */
export const TEMPERATURE = {
  min: 40,
  max: 110,
  defaultStart: 80,
  defaultMax: 90,
};

/** Feature roles (the last part of the feature external ids): frozen forever. */
export const FEATURES = {
  HEATING: 'heating',
  STATUS: 'status',
  STATUS_CODE: 'status-code',
  ONLINE: 'online',
  DOOR: 'door',
  TEMPERATURE: 'temperature',
  TARGET: 'target-temperature',
  REMAINING: 'remaining',
  LIGHT: 'light',
  HEAT_ON: 'heat-on',
  HEAT_OFF: 'heat-off',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** OPENING_SENSOR_STATE of the core: 0 open, 1 closed. */
export const DOOR_STATE = { OPEN: 0, CLOSED: 1 };

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 60,
  max: 3600,
  default: 60,
};

export const LIMITS = {
  /** Gladys: 300 states per minute, for the whole integration (some room kept). */
  statesPerMinute: 280,
  statesPerRequest: 100,
  /** A status answer is well under 2 KB. */
  responseBytes: 64 * 1024,
  /** Longest text kept from an answer (the sauna name). */
  textLength: 80,
  /** E-mail address and password of the Huum account. */
  userMax: 254,
  secretMax: 256,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One read of the polling. */
  readTimeout: 15 * SECOND,
  /** Failed reads: 1, 2, 5, then 15 minutes, never shorter than the interval. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 15 * MINUTE],
  /** 429: Retry-After bounded to 1 min .. 6 h, 5 min without. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** The time of the last read is written to /data at most this often. */
  attemptWriteEvery: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): heating or a setpoint must leave
   * by 3.5 s after the click, or it is refused unsent; every answer is awaited
   * until 4.3 s, after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read of a command: 2 s at most, and 0.3 s left to send after it. */
  commandReadMax: 2_000,
  commandMinRead: 300,
  commandMinSend: 300,
  /** A turn off keeps going after the ack, this long at most. */
  protectTimeout: 15 * SECOND,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [10 * SECOND, 40 * SECOND],
  /** A command not seen yet keeps its guard this long. */
  guard: 2 * MINUTE,
  /** A turn off sent again at most this often while a heating may still land after it. */
  stopReasserts: 2,
};
