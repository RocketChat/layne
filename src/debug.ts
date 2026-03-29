export const debugEnabled =
  process.env.DEBUG_MODE === 'true' || process.env.DEBUG_MODE === '1';

export function debug(tag: string, message: string): void {
  if (debugEnabled) console.debug(`[${tag}:debug] ${message}`);
}
