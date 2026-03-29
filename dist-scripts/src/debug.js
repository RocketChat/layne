export const debugEnabled = process.env.DEBUG_MODE === 'true' || process.env.DEBUG_MODE === '1';
export function debug(tag, message) {
    if (debugEnabled)
        console.debug(`[${tag}:debug] ${message}`);
}
//# sourceMappingURL=debug.js.map