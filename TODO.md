# TODO — Huum v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (lot 13) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-22): one sauna per Huum account (e-mail
      address and password, HTTP Basic over HTTPS), status read every
      interval (never sooner, even after a restart), heating, status, door,
      temperature, setpoint, time left, light; turn off never held back;
      turn on and setpoint behind `allow_heating` (off), decided on a fresh
      read, door closed, bounded by `max_temperature`; 429/5xx pauses and the
      stop on refused credentials persisted; test button; docs en/fr; cover.
      Tested against made-up answers only. The store validator was not run by
      the dev session (it needs the real terminal).
- [ ] **Milestone 2 — real sauna**: run against a real Huum account (see "To
      check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: light/fan toggle (`GET /action/home/light`, a
      toggle: needs a guard set before the first byte, kept in /data, and a
      state read back), steamer humidity (`humidity` with the UKU 4.2 limits
      of pyhuum `HUMIDITY_THRESHOLDS`), session duration, scene trigger
      "sauna ready" (temperature reached).

## To check on a real sauna

- The exact answer of `status`, `start` and `stop` (pyhuum's tests show the
  new status at once, with `statusCode` 231 after a start): whether the
  answer of a start can still say 232 for a few seconds (then every start
  would be "sent, without confirmation").
- Whether a start while heating (a new setpoint) restarts the session timer
  (`endDate`).
- Whether `temperature` and `targetTemperature` always come as text, and
  whether `door` is always a boolean (a door unknown refuses heating).
- What a 403 means for this API (pyhuum maps it to `Forbidden`): treated like
  a 401 (a stop) on reads.
- `remoteSafetyState` and `paymentEndDate`: not used.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and `docker_image` (`ghcr.io/lm1lc3n7/gladys-huum:0.1.0`); the
  first patch release gives 0.1.1.
- **Reference**: huum 0.8.3 (MIT, LICENSE file read: Copyright (c) 2021 Frank
  Wickström), frwickst/pyhuum, cloned read only in `_ref/huum-ref`. Credited
  in `THIRD_PARTY_NOTICES.md`, copied into the image. No application key nor
  app User-Agent in the library: none here either (`gladys-huum`).
- **Neighbours followed**: LM1LC3N7/gladys-edilkamin (flame appliance: lighting
  off by default, two buttons, setpoint behind the option) and
  LM1LC3N7/gladys-robonect (lot 12 rules: attempt time in /data before the
  read, protective command outside any queue, reaffirmation, generation).
  gladys-balboa (spa) was not needed: its protocol is local.
- **Identity**: one device per account. FROZEN RULE: the first 16 hex digits
  of SHA-256(`huum-account\0` + the e-mail address trimmed, lower case). The
  API serves "the" sauna of the account and gives no id of its own; a
  readable fallback is not needed (the e-mail address is always there when a
  read is possible). Not salted: it must survive a loss of /data. Another
  e-mail address makes another device; the old one is shown unreachable.
- **Turning on and the setpoint behind one option** (`allow_heating`, off):
  on Huum a new setpoint is a `start`, which lights a sauna that stopped
  meanwhile; so the setpoint is only accepted while a fresh read shows the
  sauna heating, door closed. Turning on asks for `start_temperature` (80 °C
  by default). Both are capped by `max_temperature` (90 °C by default, never
  above 110 °C, the controller's limit). The setpoint feature keeps 40-110 as
  its bounds (frozen at creation); the configuration narrows them.
- **Door**: an `opening-sensor` (1 closed, 0 open, the core's
  OPENING_SENSOR_STATE). Open or unknown refuses heating, as the Huum app and
  pyhuum's default check do. Status codes other than 232 ("online, not
  heating") refuse turning on: 230 offline, 233 locked by another user, 400
  emergency stop, anything unknown.
- **Turning off** decides nothing: no read before it, always `POST stop`, one
  request even during a pause or a stop; confirmed when the answer shows a
  status other than heating. It counts at its arrival (`protectSeq`): a
  heating command not sent yet refuses. One in flight gets a second stop
  when it settles (unless a newer start was asked); reads of the next 2 min
  that show heating send it again, twice at most.
- **Refused credentials** (401/403 on a read): a FINAL stop (lot 12 rule:
  "never retried by itself"), kept in /data with a salted fingerprint of the
  refused credentials. The test button makes the one new try (at most one
  per interval); the stop goes only on a success. Other credentials lift it
  at once (also after a restart). A 401/403 on a command refuses that command
  only.
- **No light command in v1**: `GET /light` is a toggle; a toggle needs a
  guard (lot 12) and the light state read back. Read only for now.
- **No scene trigger, no widget** in v1.
- **Poll interval**: 60 s by default, 60 s to 1 h (a cloud account).
- **Follow-up reads** 10 s and 40 s after a command, outside the interval
  (as on gladys-robonect): one series pending at a time.
- **HTTPS**: node:tls with the system authorities (no pinning: a public
  cloud). The request is written only once TLS is up and before the deadline
  of a command; the answer is bounded to 64 KB in one buffer.
- **Cover**: `scripts/cover.mjs` (plain Node), 800×534.
