# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- Code clean-up: a setpoint that makes Huum start a new session is reported
  in the log only (as documented); a return value the SDK never used is
  removed. No change of behaviour.

## [0.1.1] - 2026-10-22

### Added

- Huum sauna heaters (UKU Wi-Fi controller) through the Huum cloud, with the
  e-mail address and password of the Huum account (HTTP Basic over HTTPS):
  one device per account.
- Heating (read only), status, status code, controller online, door (opening
  sensor), temperature, setpoint, heating time left, light (read only, when
  reported).
- "Turn off" button, never held back (option, heating command in flight,
  429/5xx pause, refused credentials, before the first read after a restart);
  sent again after a heating command in flight; confirmed only when the
  sauna answers "online, not heating" or "emergency stop", otherwise
  reaffirmed (twice at most) by the reads of the next 2 min that see it heat.
- "Turn on (heat)" button and writable setpoint, off by default ("Allow
  heating from Gladys"), decided on a fresh read, refused while the door is
  open or a turn off is in flight or unconfirmed, the option and the turn off
  checked again at the moment the command is written, refused after 3.5 s;
  the temperature never above the "Highest setpoint" (90 °C by default,
  110 °C at most); the setpoint refused near the end of the session and for
  2 min after a turn off, a new session started by Huum logged; "sent,
  without confirmation" when the answer does not show it.
- Credentials refused: a stop kept in `/data`, never retried by itself; 429
  and 5xx pauses kept in `/data`; never read sooner than the interval, even
  after a restart; the last good read shown after a restart.
- Requests over HTTPS on one TLS connection, tested against a real local
  TLS server.
- "Test the connection" button; documentation in English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-huum/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-huum/releases/tag/v0.1.1
