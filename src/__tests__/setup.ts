// Loaded before every test file via vitest.config.ts setupFiles.
// Sets environment variables so modules that read them at import time
// get consistent values in tests without needing a real .env file.
process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
process.env.GITHUB_APP_ID         = '12345';
process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----';
process.env.REDIS_URL             = 'redis://localhost:6379';
process.env.PORT                  = '3001';
