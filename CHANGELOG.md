# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Huum sauna heaters (UKU Wi-Fi controller) through the Huum cloud, with the
  e-mail address and password of the Huum account (HTTP Basic over HTTPS):
  one device per account.
- Heating (read only), status, status code, controller online, door (opening
  sensor), temperature, setpoint, heating time left, light (read only, when
  reported).
- "Turn off" button, never held back (option, heating command in flight,
  429/5xx pause, refused credentials, before the first read after a restart);
  sent again after a heating command in flight, and reaffirmed if the sauna
  heats again.
- "Turn on (heat)" button and writable setpoint, off by default ("Allow
  heating from Gladys"), decided on a fresh read, refused while the door is
  open, checked again right before sending, refused after 3.5 s; the
  temperature never above the "Highest setpoint" (90 °C by default, 110 °C
  at most); "sent, without confirmation" when the answer does not show it.
- Credentials refused: a stop kept in `/data`, never retried by itself; 429
  and 5xx pauses kept in `/data`; never read sooner than the interval, even
  after a restart.
- "Test the connection" button; documentation in English and French.
