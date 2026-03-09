import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockToken = 'ghs_fakeInstallationToken';
const mockOctokitInstance = { requests: [] };

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(() =>
    vi.fn().mockResolvedValue({ token: mockToken })
  ),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => mockOctokitInstance),
}));

const { createAppAuth }              = await import('@octokit/auth-app');
const { Octokit }                    = await import('@octokit/rest');
const { getInstallationOctokit, getInstallationToken } = await import('../auth.js');

describe('auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getInstallationToken()', () => {
    it('returns the token string from the auth provider', async () => {
      const token = await getInstallationToken(12345);
      expect(token).toBe(mockToken);
    });

    it('requests an installation token with the provided installation ID', async () => {
      const mockAuthFn = vi.fn().mockResolvedValue({ token: mockToken });
      createAppAuth.mockReturnValueOnce(mockAuthFn);

      // Re-import to get a fresh module with the new mock
      vi.resetModules();
      const { getInstallationToken: freshFn } = await import('../auth.js');
      await freshFn(99999);

      expect(mockAuthFn).toHaveBeenCalledWith({ type: 'installation', installationId: 99999 });
    });
  });

  describe('getInstallationOctokit()', () => {
    it('returns an Octokit instance', async () => {
      const octokit = await getInstallationOctokit(12345);
      expect(octokit).toBe(mockOctokitInstance);
    });

    it('constructs Octokit with the installation token as the auth value', async () => {
      await getInstallationOctokit(12345);
      expect(Octokit).toHaveBeenCalledWith({ auth: mockToken });
    });
  });

  describe('private key newline handling', () => {
    it('replaces literal \\n sequences in the env var with real newlines', async () => {
      vi.resetModules();
      process.env.GITHUB_APP_PRIVATE_KEY = 'line1\\nline2\\nline3';

      const { createAppAuth: freshCreateAppAuth } = await import('@octokit/auth-app');
      const { getInstallationToken: freshFn } = await import('../auth.js');

      // Trigger lazy initialization so createAppAuth is actually called
      await freshFn(1);

      const callArgs = freshCreateAppAuth.mock.calls[0][0];
      expect(callArgs.privateKey).toBe('line1\nline2\nline3');
    });
  });
});
