/**
 * Lightweight debug logger controlled by the DEBUG_MODE environment variable.
 *
 * Set DEBUG_MODE=true (or DEBUG_MODE=1) in your environment to enable verbose
 * logging across all Layne components. When disabled (the default), debug()
 * calls are no-ops and produce no output.
 *
 * Usage:
 *   import { debug } from './debug.js';
 *   debug('semgrep', 'scanning 3 file(s): src/app.js, lib/utils.js');
 *   // → [semgrep:debug] scanning 3 file(s): src/app.js, lib/utils.js
 */
export const debugEnabled =
  process.env.DEBUG_MODE === 'true' || process.env.DEBUG_MODE === '1';

export function debug(tag, message) {
  if (debugEnabled) console.debug(`[${tag}:debug] ${message}`);
}
