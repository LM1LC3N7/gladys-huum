# gladys-huum

[Gladys Assistant](https://gladysassistant.com) external integration for
**Huum sauna heaters with the UKU Wi-Fi controller**, through the Huum cloud
(the account of the Huum app): status, heating, door, temperature, setpoint,
heating time left; turn off always available; turning on and the setpoint
behind an off-by-default option, refused while the door is open. **Never
tested with a real device. Not affiliated with Huum.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (HuumApp)
                                  ├─ src/huum/client.js  Huum API, parsing (own fields, exact types)
                                  ├─ src/huum/http.js    the only network access (node:tls + node:http, bounded)
                                  ├─ src/devices.js      the device and its states (pure)
                                  ├─ src/publisher.js    states within 300/min
                                  └─ src/store.js        /data/huum-state.json (no secret)
```

- **API**: `GET /action/home/status`, `POST /action/home/start`
  (`{"targetTemperature": t}`), `POST /action/home/stop` on sauna.huum.eu,
  HTTP Basic authentication with the e-mail address and password of the Huum
  account, as the `huum` Python library (MIT, frwickst/pyhuum 0.8.3, the
  library of Home Assistant's Huum integration) does. No application key, no
  imitation of the app: the User-Agent is `gladys-huum`.
- **Identity**: one device per account, `huum:<account id>`, the account id
  being the first 16 hex digits of SHA-256(`huum-account\0` + the e-mail
  address trimmed, lower case). A frozen rule: the API gives no sauna id.
- **Reads**: every 60 s (60 s – 1 h), never sooner than the interval after
  the last one: the time is kept in `/data` (written before the read, at most
  once a minute), so a restart, a reconnection to Gladys, the test button, a
  Discovery scan or a configuration saved unchanged never read earlier.
  Failures retried after 1, 2, 5, 15 min; 429 and 5xx pause, kept in `/data`.
  An answer for an old configuration publishes nothing.
- **Credentials refused** (401/403 on a read): a stop kept in `/data`, never
  tried again by itself; lifted by other credentials, or by a success of the
  test button. Only a salted fingerprint of the refused credentials is kept,
  erased at the first success. A 401/403 on a command never stops the reads.
- **Commands**: no switch. "Turn off" (a button) is never held back: no
  option, no pause, no stop, no read before it, no queue; it cancels a
  heating command not sent yet, is sent again after one in flight, and is
  reaffirmed twice at most if the sauna heats again within 2 min. "Turn on"
  (a button) and the setpoint (`thermostat/target-temperature`) are behind
  `allow_heating` (off), checked again right before sending, decided on a
  fresh read (door closed, status "online, not heating" or "heating"), sent
  within 3.5 s or refused unsent, one at a time, never retried, confirmed only
  by an answer showing the temperature asked; else "sent, without
  confirmation". The temperature never exceeds `max_temperature` (90 °C by
  default, 110 °C at most).

## Development

```bash
npm install
npm run format:check && npm run lint && npm test
npm run audit
npm run cover          # cover.png, plain Node
npx github:GladysAssistant/integration-store .
```

Tests use the SDK's fake Gladys and a fake Huum cloud (`test/fixtures`), with
a mocked clock; the HTTP layer is tested against a local server. Nothing
touches the network.

## Credits and license

Apache-2.0 (see `LICENSE`). The Huum client is a JavaScript port of parts of
the `huum` Python library (MIT, Frank Wickström): see
`THIRD_PARTY_NOTICES.md`.
