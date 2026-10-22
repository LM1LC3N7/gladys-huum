# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It reads and commands a Huum sauna heater (UKU Wi-Fi) through the Huum cloud.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "turn off"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png (plain Node)
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   SDK handlers -> HuumApp (shared with the tests)
src/app.js                        polling, device, states, status, commands and their guards
src/devices.js                    device and states of the sauna (pure); feature roles are frozen
src/huum/client.js                Huum API calls, answer parsing (pure parser)
src/huum/http.js                  one bounded HTTPS request (node:tls + node:http), error kinds
src/store.js                      /data/huum-state.json: pause, stop, last read; no secret
src/publisher.js                  states to Gladys within 300 per minute
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       English and French runtime texts
scripts/cover.mjs                 cover.png generator (plain Node, no dependency)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** `gladys.externalIds('huum', accountId)`,
  `accountId` from `accountIdOf` (src/config.js, a frozen rule). Feature
  roles (`src/constants.js` FEATURES) and manifest keys never change.
- **The container rootfs is read-only.** Write only under `/data`. Never log,
  store or show the e-mail address, the password or the Authorization
  header; never keep the body of an HTTP error. A `secret` field is "kept by
  Gladys in its database, never shown again".
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree (never a pinned value).
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }`; the catalog
  `description` holds 10 to 100 characters per language.
- **User-facing text** is bilingual and UTF-8 without BOM, without control
  bytes (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
- **Huum.** Turning on and the setpoint stay behind `allow_heating` (off by
  default): a button and a thermostat setpoint, never a switch; decided on a
  fresh read (door closed), checked again right before sending, refused after
  3.5 s, never above `max_temperature` (110 °C at most). Turning off is never
  held back (option, heating in flight, pause, stop, before the first read),
  never preceded by a read, and is sent again / reaffirmed when a heating
  command may land after it. Huum is never read sooner than the interval
  after the last read (kept in `/data`). An answer of an old configuration
  publishes nothing (generation checked after every await). Refused
  credentials are never retried by themselves.
