// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container):
//   - the end of a pause (429, or a 5xx), so a restart never asks Huum again
//     before its time;
//   - the stop after credentials refused by Huum, so a restart never tries
//     them again (only new credentials, or a success of the test button, lift
//     it);
//   - the time of the last read (written at most once a minute, BEFORE the
//     read), so a restart never reads sooner than the interval.
// NO SECRET: neither the e-mail address nor the password. The only thing
// derived from credentials is the salted fingerprint of credentials Huum
// REFUSED (src/config.js), erased at the first accepted read. The file is
// readable by the container user only (0600), bounded and repaired when read
// back (a hand-edited or damaged file never stops the integration for good).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/huum-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 16 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const HEX = /^[0-9a-f]{32,64}$/;

/**
 * The persisted state, repaired and bounded:
 * `{ pause: { until, reason } | null, block: { salt, refused, status } | null,
 *   lastAttemptAt: number | null }`.
 */
export function normalizeMemory(raw, now) {
  const data = object(raw);
  const pause = object(data.pause);
  const block = object(data.block);
  return {
    pause:
      Number.isFinite(pause.until) && pause.until > now
        ? {
            // Capped from now: a clock jump or an edited file never pauses longer than 6 h.
            until: Math.min(pause.until, now + TIMINGS.rateLimitMax),
            reason: pause.reason === '5xx' ? '5xx' : '429',
          }
        : null,
    block:
      typeof block.salt === 'string' && HEX.test(block.salt)
        ? {
            salt: block.salt,
            refused:
              typeof block.refused === 'string' && HEX.test(block.refused) ? block.refused : null,
            status: block.status === 403 ? 403 : 401,
          }
        : null,
    // A time in the future (a clock set back) counts as now: never a longer wait than the interval.
    lastAttemptAt:
      Number.isFinite(data.lastAttemptAt) && data.lastAttemptAt > 0
        ? Math.min(data.lastAttemptAt, now)
        : null,
  };
}
