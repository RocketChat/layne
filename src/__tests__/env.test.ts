import { describe, it, expect, vi, afterEach } from 'vitest';

const { validateEnv } = await import('../env.js');

afterEach(() => vi.restoreAllMocks());

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
});
