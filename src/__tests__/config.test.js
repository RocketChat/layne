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

  it('returns defaults when layne.json is missing (readFile throws)', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.semgrep).toEqual(DEFAULT_CONFIG.semgrep);
    expect(config.trufflehog).toEqual(DEFAULT_CONFIG.trufflehog);
  });

  it('returns defaults when layne.json contains malformed JSON', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('not valid json {{{');
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.semgrep).toEqual(DEFAULT_CONFIG.semgrep);
    expect(config.trufflehog).toEqual(DEFAULT_CONFIG.trufflehog);
  });

  it('returns defaults when layne.json top-level value is an array', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify([{ foo: 'bar' }]));
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.semgrep).toEqual(DEFAULT_CONFIG.semgrep);
    expect(config.trufflehog).toEqual(DEFAULT_CONFIG.trufflehog);
  });

  it('returns defaults when layne.json top-level value is a number', async () => {
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

  it('reads layne.json only once across two loadScanConfig calls (cache)', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({}));
    await loadScanConfig({ owner: 'org', repo: 'a' });
    await loadScanConfig({ owner: 'org', repo: 'b' });
    expect(vi.mocked(readFile)).toHaveBeenCalledTimes(1);
  });

  // --- notifications ---

  it('returns an empty notifications object when no $global and no repo notifications block', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      'acme/frontend': { semgrep: { extraArgs: ['--config', 'p/owasp-top-ten'] } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.notifications).toEqual({});
  });

  it('returns an empty notifications object for an unknown repo with no $global', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({}));
    const config = await loadScanConfig({ owner: 'org', repo: 'unknown' });
    expect(config.notifications).toEqual({});
  });

  it('inherits $global notifications when the repo has no notifications block', async () => {
    const globalRc = { enabled: true, webhookUrl: '$ROCKETCHAT_WEBHOOK_URL' };
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':        { notifications: { rocketchat: globalRc } },
      'acme/frontend':  { semgrep: { extraArgs: ['--config', 'auto'] } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.notifications).toEqual({ rocketchat: globalRc });
  });

  it('repo-level notifications override $global for the same notifier key', async () => {
    const globalRc = { enabled: true, webhookUrl: '$GLOBAL_HOOK' };
    const repoRc   = { enabled: true, webhookUrl: '$REPO_HOOK', template: 'custom' };
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { notifications: { rocketchat: globalRc } },
      'acme/payments': { notifications: { rocketchat: repoRc } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'payments' });
    expect(config.notifications.rocketchat).toEqual(repoRc);
  });

  it('repo-level notifications do not affect global notifiers for different keys', async () => {
    const globalSlack = { enabled: true, webhookUrl: '$SLACK_HOOK' };
    const repoRc      = { enabled: true, webhookUrl: '$REPO_HOOK' };
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { notifications: { slack: globalSlack } },
      'acme/payments': { notifications: { rocketchat: repoRc } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'payments' });
    expect(config.notifications.slack).toEqual(globalSlack);
    expect(config.notifications.rocketchat).toEqual(repoRc);
  });

  it('a repo can opt out of a global notifier by setting enabled: false', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { notifications: { rocketchat: { enabled: true, webhookUrl: '$GLOBAL_HOOK' } } },
      'acme/frontend': { notifications: { rocketchat: { enabled: false } } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.notifications.rocketchat.enabled).toBe(false);
  });

  it('$global without a notifications key does not affect config', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global': { semgrep: { extraArgs: ['--config', 'p/custom'] } },
    }));
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.notifications).toEqual({});
  });

  // --- labels ---

  it('returns an empty labels object when no $global and no repo labels block', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      'acme/frontend': { semgrep: { extraArgs: ['--config', 'auto'] } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.labels).toEqual({});
  });

  it('returns an empty labels object for an unknown repo with no $global', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({}));
    const config = await loadScanConfig({ owner: 'org', repo: 'unknown' });
    expect(config.labels).toEqual({});
  });

  it('inherits $global labels when the repo has no labels block', async () => {
    const globalLabels = { onFailure: ['needs-security-review'], removeOnSuccess: ['needs-security-review'] };
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { labels: globalLabels },
      'acme/frontend': { semgrep: { extraArgs: ['--config', 'auto'] } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.labels).toEqual(globalLabels);
  });

  it('per-repo labels override $global at the whole-key level', async () => {
    const globalLabels = { onFailure: ['needs-security-review'], removeOnSuccess: ['needs-security-review'] };
    const repoLabels   = { onFailure: ['security-critical'],     removeOnSuccess: ['security-critical'] };
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { labels: globalLabels },
      'acme/payments': { labels: repoLabels },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'payments' });
    expect(config.labels).toEqual(repoLabels);
  });

  it('$global without a labels key does not affect config', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global': { notifications: { rocketchat: { enabled: true } } },
    }));
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.labels).toEqual({});
  });

  // --- trigger ---

  it('returns the default pull_request trigger when no trigger is configured', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({}));
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.trigger).toEqual({ on: 'pull_request' });
  });

  it('returns a workflow_run trigger configured at the repo level', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      'acme/frontend': {
        trigger: { on: 'workflow_run', workflow: 'Tests Done' },
      },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.trigger).toEqual({ on: 'workflow_run', workflow: 'Tests Done' });
  });

  it('inherits $global trigger when the repo has no trigger block', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { trigger: { on: 'workflow_run', workflow: 'CI' } },
      'acme/frontend': { semgrep: { extraArgs: ['--config', 'auto'] } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.trigger).toEqual({ on: 'workflow_run', workflow: 'CI' });
  });

  it('repo-level trigger overrides $global trigger', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { trigger: { on: 'workflow_run', workflow: 'CI' } },
      'acme/frontend': { trigger: { on: 'pull_request' } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.trigger.on).toBe('pull_request');
  });

  it('preserves custom conclusions in the trigger', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      'acme/frontend': {
        trigger: { on: 'workflow_run', workflow: 'CI', conclusions: ['success', 'failure'] },
      },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.trigger.conclusions).toEqual(['success', 'failure']);
  });

  // --- comment ---

  it('returns comment.enabled=false by default', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({}));
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.comment).toEqual({ enabled: false, template: null });
  });

  it('inherits $global comment when the repo has no comment block', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { comment: { enabled: true } },
      'acme/frontend': { semgrep: { extraArgs: ['--config', 'auto'] } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.comment.enabled).toBe(true);
  });

  it('repo-level comment overrides $global comment', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { comment: { enabled: true, template: 'global tpl' } },
      'acme/payments': { comment: { enabled: false } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'payments' });
    expect(config.comment.enabled).toBe(false);
    expect(config.comment.template).toBe('global tpl'); // inherited from global
  });

  it('repo-level template overrides $global template', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { comment: { enabled: true, template: 'global tpl' } },
      'acme/payments': { comment: { template: 'repo tpl' } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'payments' });
    expect(config.comment.template).toBe('repo tpl');
  });

  // --- exceptionApprovers ---

  it('returns empty exceptionApprovers by default', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({}));
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.exceptionApprovers).toEqual({ users: [], teams: [] });
  });

  it('inherits $global exceptionApprovers when the repo has no exceptionApprovers block', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { exceptionApprovers: { users: ['admin'], teams: ['org/security'] } },
      'acme/frontend': { semgrep: { extraArgs: ['--config', 'auto'] } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.exceptionApprovers).toEqual({ users: ['admin'], teams: ['org/security'] });
  });

  it('repo-level exceptionApprovers replaces $global', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { exceptionApprovers: { users: ['admin'], teams: ['org/security'] } },
      'acme/payments': { exceptionApprovers: { users: ['payments-lead'], teams: [] } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'payments' });
    expect(config.exceptionApprovers).toEqual({ users: ['payments-lead'], teams: [] });
  });

  it('repo can disable exceptionApprovals by setting empty arrays', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':        { exceptionApprovers: { users: ['admin'], teams: ['org/security'] } },
      'acme/internal': { exceptionApprovers: { users: [], teams: [] } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'internal' });
    expect(config.exceptionApprovers).toEqual({ users: [], teams: [] });
  });

  // --- mode and contextLines ---

  it('returns changed_files mode and contextLines 8 by default', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({}));
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.mode).toBe('changed_files');
    expect(config.contextLines).toBe(8);
  });

  it('inherits $global mode and contextLines when the repo has no mode', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { mode: 'diff_only', contextLines: 5 },
      'acme/frontend': { semgrep: { extraArgs: ['--config', 'auto'] } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.mode).toBe('diff_only');
    expect(config.contextLines).toBe(5);
  });

  it('repo-level mode overrides $global mode', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { mode: 'diff_only' },
      'acme/payments': { mode: 'changed_files' },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'payments' });
    expect(config.mode).toBe('changed_files');
  });

  it('repo-level contextLines overrides $global contextLines', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { contextLines: 10 },
      'acme/frontend': { contextLines: 3 },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.contextLines).toBe(3);
  });

  it('repo can set mode to diff_only while global stays changed_files', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      'acme/monorepo': { mode: 'diff_only', contextLines: 4 },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'monorepo' });
    expect(config.mode).toBe('diff_only');
    expect(config.contextLines).toBe(4);
  });

  // --- timeoutMinutes ---

  it('returns timeoutMinutes 10 by default', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({}));
    const config = await loadScanConfig({ owner: 'org', repo: 'repo' });
    expect(config.timeoutMinutes).toBe(10);
  });

  it('inherits $global timeoutMinutes when the repo has no timeoutMinutes', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { timeoutMinutes: 20 },
      'acme/frontend': { semgrep: { extraArgs: ['--config', 'auto'] } },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'frontend' });
    expect(config.timeoutMinutes).toBe(20);
  });

  it('repo-level timeoutMinutes overrides $global timeoutMinutes', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({
      '$global':       { timeoutMinutes: 20 },
      'acme/monorepo': { timeoutMinutes: 30 },
    }));
    const config = await loadScanConfig({ owner: 'acme', repo: 'monorepo' });
    expect(config.timeoutMinutes).toBe(30);
  });
});
