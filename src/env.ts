const REQUIRED = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
];

/**
 * Validates that all required environment variables are set.
 * Logs a clear error and calls process.exit(1) if any are missing,
 * so the process fails fast at startup rather than crashing mid-request.
 */
export function validateEnv(): void {
  const missing = REQUIRED.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`[layne] Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
    return;
  }

  const governorBackend = process.env.SPECTRE_GOVERNOR_BACKEND;
  if (governorBackend !== undefined && governorBackend !== 'in_process' && governorBackend !== 'redis') {
    console.error('[layne] SPECTRE_GOVERNOR_BACKEND must be either "in_process" or "redis"');
    process.exit(1);
  }

  const cacheMode = process.env.SPECTRE_CACHE_MODE ?? 'off';
  if (!['off', 'write-only', 'verify', 'read-write'].includes(cacheMode)) {
    console.error('[layne] SPECTRE_CACHE_MODE must be "off", "write-only", "verify", or "read-write"');
    process.exit(1);
    return;
  }
  if (cacheMode !== 'off' && Buffer.byteLength(process.env.SPECTRE_CACHE_HMAC_KEY ?? '', 'utf8') < 32) {
    console.error('[layne] SPECTRE_CACHE_HMAC_KEY must contain at least 32 bytes when the Spectre cache is enabled');
    process.exit(1);
    return;
  }
  if (cacheMode !== 'off' && !process.env.LAYNE_BUILD_SHA) {
    console.error('[layne] LAYNE_BUILD_SHA is required when the Spectre cache is enabled');
    process.exit(1);
    return;
  }
  if (cacheMode !== 'off') {
    const maxBytes = Number(process.env.SPECTRE_CACHE_MAX_BYTES);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 * 1024 || maxBytes > 1024 * 1024 * 1024) {
      console.error('[layne] SPECTRE_CACHE_MAX_BYTES must be an integer between 1048576 and 1073741824');
      process.exit(1);
    }
  }
}
