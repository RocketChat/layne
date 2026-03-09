const REQUIRED = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
];

/**
 * Validates that all required environment variables are set.
 * Logs a clear error and calls process.exit(1) if any are missing,
 * so the process fails fast at startup rather than crashing mid-request.
 */
export function validateEnv() {
  const missing = REQUIRED.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`[layne] Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}
