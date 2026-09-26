import { describe, it, expect, vi, afterEach } from 'vitest';

const { validateEnv } = await import('../env.js');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Spy on process.exit so it doesn't actually kill the test process.
function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
}

describe('validateEnv()', () => {
  it('does not call process.exit when all required vars are set', () => {
    const exit = mockExit();
    validateEnv();
    expect(exit).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) when GITHUB_APP_ID is missing', () => {
    const saved = process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_ID;

    const exit = mockExit();
    validateEnv();
    expect(exit).toHaveBeenCalledWith(1);

    process.env.GITHUB_APP_ID = saved;
  });

  it('calls process.exit(1) when GITHUB_APP_PRIVATE_KEY is missing', () => {
    const saved = process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_PRIVATE_KEY;

    const exit = mockExit();
    validateEnv();
    expect(exit).toHaveBeenCalledWith(1);

    process.env.GITHUB_APP_PRIVATE_KEY = saved;
  });

  it('calls process.exit(1) when GITHUB_WEBHOOK_SECRET is missing', () => {
    const saved = process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;

    const exit = mockExit();
    validateEnv();
    expect(exit).toHaveBeenCalledWith(1);

    process.env.GITHUB_WEBHOOK_SECRET = saved;
  });

  it('calls process.exit(1) when multiple vars are missing', () => {
    const savedId  = process.env.GITHUB_APP_ID;
    const savedKey = process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;

    const exit = mockExit();
    validateEnv();
    expect(exit).toHaveBeenCalledWith(1);

    process.env.GITHUB_APP_ID          = savedId;
    process.env.GITHUB_APP_PRIVATE_KEY = savedKey;
  });

  it('calls process.exit(1) for an unknown Spectre governor backend', () => {
    vi.stubEnv('SPECTRE_GOVERNOR_BACKEND', 'in-process');
    const exit = mockExit();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    validateEnv();

    expect(error).toHaveBeenCalledWith('[layne] SPECTRE_GOVERNOR_BACKEND must be either "in_process" or "redis"');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it.each(['in_process', 'redis'])('accepts the %s Spectre governor backend', (backend) => {
    vi.stubEnv('SPECTRE_GOVERNOR_BACKEND', backend);
    const exit = mockExit();

    validateEnv();

    expect(exit).not.toHaveBeenCalled();
  });

  it('requires signing key and bounded byte budget when Spectre cache is enabled', () => {
    vi.stubEnv('SPECTRE_CACHE_MODE', 'read-write');
    vi.stubEnv('SPECTRE_CACHE_HMAC_KEY', '');
    vi.stubEnv('SPECTRE_CACHE_MAX_BYTES', '134217728');
    vi.stubEnv('LAYNE_BUILD_SHA', 'test-build');
    const exit = mockExit();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    validateEnv();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it.each(['off', 'write-only', 'verify', 'read-write'])('accepts Spectre cache mode %s', (mode) => {
    vi.stubEnv('SPECTRE_CACHE_MODE', mode);
    vi.stubEnv('SPECTRE_CACHE_HMAC_KEY', 'a'.repeat(32));
    vi.stubEnv('SPECTRE_CACHE_MAX_BYTES', '134217728');
    vi.stubEnv('LAYNE_BUILD_SHA', 'test-build');
    const exit = mockExit();

    validateEnv();

    expect(exit).not.toHaveBeenCalled();
  });
});
