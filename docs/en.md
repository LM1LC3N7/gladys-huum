# Huum for Gladys

This integration shows a **Huum sauna heater with its UKU Wi-Fi controller**
in Gladys, through the Huum cloud (the account of the Huum app). **Never
tested with a real device.** Not affiliated with Huum.

> **Safety.** A sauna gets very hot. Never start heating from afar without
> making sure nobody is inside and nothing lies on the stove. Turning on from
> Gladys is **off by default** and refused while the door is open; turning off
> always works.

## What you get

A sauna in the Discovery tab, with:

- **Heating** (yes/no, read only) and the **status** as text ("Heating",
  "Online, not heating", "Offline", "In use by another user (locked)",
  "Emergency stop"), the status code, controller online;
- **door** (opening sensor: open/closed);
- measured **temperature** and **setpoint**;
- **heating time left** (minutes), from the end of the session planned by
  Huum;
- the **light** (read only), when your sauna reports one;
- two buttons: **Turn on (heat)** and **Turn off**.

No switch: an "everything on" from Google Home, Alexa, HomeKit, MCP or a scene
can never start the sauna.

## Setup

1. In Gladys, open the Huum integration and enter the **e-mail address** and
   the **password** of your Huum account (those of the app).
2. Save, then add the sauna from the **Discovery** tab.
3. To start heating from Gladys, turn on **Allow heating from Gladys**, and
   set the **setpoint of the "Turn on" button** (80 °C by default) and the
   **highest setpoint** (90 °C by default, 110 °C at most, the limit of the
   controller).

The password is kept by Gladys in its database, never shown again, sent only
to the Huum cloud (sauna.huum.eu, over HTTPS, HTTP Basic authentication). It
is never written to the logs nor to `/data`.

The sauna is read every 60 s (60 s to 1 h), **never more often**, even after
a restart of the integration, a reconnection to Gladys, the "Test the
connection" button or a Discovery scan.

The device belongs to the Huum **account**: the API gives the sauna no id of
its own (one account, one sauna). Another e-mail address therefore makes a new
device; the old one is shown unreachable.

## The commands

- **Turn off** always works: even with heating from Gladys off, during a
  pause asked by Huum, after refused credentials, or right after a restart,
  before the first read. It is always sent (never "already off"), cancels a
  heating command not sent yet, is sent again after a heating command still on
  its way, and reaffirmed (twice at most) if the sauna heats again within two
  minutes.
- **Turn on (heat)** and the **setpoint** are refused while "Allow heating
  from Gladys" is off. On, they read the sauna first (never the state in
  memory) and refuse when the door is open or unknown, when the sauna cannot
  heat (offline, locked by another account, emergency stop, unknown status),
  when a turn off was asked meanwhile, or when the command cannot leave within
  3.5 s. One at a time, never sent twice.
- **Turn on** asks for the setpoint of the "Turn on" button, never above the
  highest setpoint. Already heating: nothing is sent.
- **The setpoint** is only changed while heating (Huum takes a new setpoint as
  a new start). A whole number from 40 °C to the highest setpoint.
- A command is confirmed only when Huum's answer shows the sauna heating at
  the temperature asked (or not heating, for a turn off). Otherwise: "Sent,
  without confirmation", and the integration reads the sauna again 10 s and
  40 s later.

## When something goes wrong

- **Credentials refused** (HTTP 401 or 403): the integration stops and
  **never** tries them again by itself (no loop). Fix them and save, or, if
  they are right, use "Test the connection": the button makes one read, and
  the stop is lifted only if it succeeds. The stop survives a restart; only a
  salted fingerprint of the refused credentials is kept in `/data`, erased at
  the first success.
- **429** (Huum asks to slow down): a pause of 1 min to 6 h (Retry-After),
  kept in `/data`. **5xx**: a pause kept in `/data`. Network error: new tries
  after 1, 2, 5 then 15 min, never faster than the interval.
- A heating command refused by Huum (401, 403) never stops the reads.

## Limits

- The API is not publicly documented (Huum gave it to the authors of the
  pyhuum library). It may change.
- No light command yet (a toggle: to do with a guard), no humidity (steamer),
  no session timer.
- One sauna per account.

## Data

`/data/huum-state.json` holds only: the end of a pause, the stop on refused
credentials (with the salted fingerprint of those credentials), the time of
the last read. Neither the e-mail address nor the password.

Based on the huum Python library (MIT, frwickst/pyhuum), ported to
JavaScript: see `THIRD_PARTY_NOTICES.md`.
