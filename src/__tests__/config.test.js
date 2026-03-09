import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises');

describe('loadScanConfig()', () => {
  let readFile;
  let loadScanConfig;
  let DEFAULT_CONFIG;

  beforeEach(async () => {
    vi.resetModules();
    const fsMod = await import('fs/promises');
    readFile = fsMod.readFile;
    vi.mocked(readFile).mockReset();

    const configMod = await import('../config.js');
    loadScanConfig = configMod.loadScanConfig;
    DEFAULT_CONFIG = configMod.DEFAULT_CONFIG;
  });

  it('returns defaults when repos.json is missing (readFile throws)', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.semgrep).toEqual(DEFAULT_CONFIG.semgrep);
    expect(config.trufflehog).toEqual(DEFAULT_CONFIG.trufflehog);
  });

  it('returns defaults when repos.json contains malformed JSON', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('not valid json {{{');
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.semgrep).toEqual(DEFAULT_CONFIG.semgrep);
    expect(config.trufflehog).toEqual(DEFAULT_CONFIG.trufflehog);
  });

  it('returns defaults when repos.json top-level value is an array', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify([{ foo: 'bar' }]));
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.semgrep).toEqual(DEFAULT_CONFIG.semgrep);
    expect(config.trufflehog).toEqual(DEFAULT_CONFIG.trufflehog);
  });

  it('returns defaults when repos.json top-level value is a number', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('42');
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.semgrep).toEqual(DEFAULT_CONFIG.semgrep);
    expect(config.trufflehog).toEqual(DEFAULT_CONFIG.trufflehog);
  });

  it('returns defaults for an unknown repo', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      'other/repo': { semgrep: { extraArgs: ['--config', 'p/custom'] } },
    }));
    const config = await loadScanConfig({ owner: 'org', repo: 'unknown' });
    expect(config.semgrep).toEqual(DEFAULT_CONFIG.semgrep);
    expect(config.trufflehog).toEqual(DEFAULT_CONFIG.trufflehog);
  });

  it('returns merged config for a known repo', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      'acme/frontend': {
        semgrep: { extraArgs: ['--config', 'p/owasp-top-ten'] },
        trufflehog: { extraArgs: ['--only-verified'] },
      },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.semgrep).toEqual({ enabled: true, extraArgs: ['--config', 'p/owasp-top-ten'] });
    expect(config.trufflehog).toEqual({ enabled: true, extraArgs: ['--only-verified'] });
  });

  it('extraArgs fully replaces the default (no concatenation)', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      'acme/frontend': {
        semgrep: { extraArgs: ['--config', 'p/custom'] },
      },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.semgrep.extraArgs).toEqual(['--config', 'p/custom']);
    expect(config.semgrep.extraArgs).not.toContain('auto');
  });

  it('partial override: only semgrep key → trufflehog stays default', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      'acme/backend': {
        semgrep: { extraArgs: ['--config', 'p/python'] },
      },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'backend' });
    expect(config.semgrep.extraArgs).toEqual(['--config', 'p/python']);
    expect(config.trufflehog).toEqual(DEFAULT_CONFIG.trufflehog);
  });

  it('preserves enabled: false through merge', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      'acme/internal-tool': {
        trufflehog: { enabled: false },
      },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'internal-tool' });
    expect(config.trufflehog.enabled).toBe(false);
    expect(config.trufflehog.extraArgs).toEqual([]);
  });

  it('reads repos.json only once across two loadScanConfig calls (cache)', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({}));
    await loadScanConfig({ owner: 'org', repo: 'a' });
    await loadScanConfig({ owner: 'org', repo: 'b' });
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1);
  });
});
