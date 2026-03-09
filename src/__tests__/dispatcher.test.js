import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../adapters/trufflehog.js', () => ({
  runTrufflehog: vi.fn().mockResolvedValue([]),
}));

vi.mock('../adapters/semgrep.js', () => ({
  runSemgrep: vi.fn().mockResolvedValue([]),
}));

vi.mock('../adapters/claude.js', () => ({
  runClaude: vi.fn().mockResolvedValue([]),
}));

vi.mock('../config.js', () => ({
  loadScanConfig: vi.fn().mockResolvedValue({
    semgrep:    { enabled: true, extraArgs: ['--config', 'auto'] },
    trufflehog: { enabled: true, extraArgs: [] },
    claude:     { enabled: false, model: 'claude-haiku-4-5-20251001' },
  }),
}));

const { runTrufflehog }  = await import('../adapters/trufflehog.js');
const { runSemgrep }     = await import('../adapters/semgrep.js');
const { runClaude }      = await import('../adapters/claude.js');
const { loadScanConfig } = await import('../config.js');
const { dispatch }       = await import('../dispatcher.js');

const BASE = {
  workspacePath: '/tmp/ws',
  changedFiles:  ['src/app.js', 'src/utils.js'],
  baseSha:       'abc123',
  baseRef:       'main',
  labels:        [],
  owner:         'org',
  repo:          'repo',
};

describe('dispatch()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls all three adapters', async () => {
    await dispatch(BASE);
    expect(runTrufflehog).toHaveBeenCalledOnce();
    expect(runSemgrep).toHaveBeenCalledOnce();
    expect(runClaude).toHaveBeenCalledOnce();
  });

  it('passes changedFiles to the trufflehog adapter', async () => {
    await dispatch(BASE);
    expect(runTrufflehog).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/tmp/ws',
      changedFiles:  ['src/app.js', 'src/utils.js'],
    }));
  });

  it('passes changedFiles to the semgrep adapter', async () => {
    await dispatch(BASE);
    expect(runSemgrep).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/tmp/ws',
      changedFiles:  ['src/app.js', 'src/utils.js'],
    }));
  });

  it('returns an empty array when both adapters return no findings', async () => {
    const findings = await dispatch(BASE);
    expect(findings).toEqual([]);
  });

  it('merges findings from both adapters into a single array', async () => {
    const th = { file: 'a.js', line: 1, severity: 'high',   message: 'secret', ruleId: 'trufflehog/aws', tool: 'trufflehog' };
    const sg = { file: 'b.py', line: 5, severity: 'medium', message: 'eval',   ruleId: 'python/eval',    tool: 'semgrep' };
    runTrufflehog.mockResolvedValueOnce([th]);
    runSemgrep.mockResolvedValueOnce([sg]);

    const findings = await dispatch(BASE);
    expect(findings).toHaveLength(2);
    expect(findings).toContainEqual(th);
    expect(findings).toContainEqual(sg);
  });

  it('returns findings from trufflehog even when semgrep finds nothing', async () => {
    const th = { file: 'a.js', line: 1, severity: 'high', message: 'secret', ruleId: 'trufflehog/aws', tool: 'trufflehog' };
    runTrufflehog.mockResolvedValueOnce([th]);

    const findings = await dispatch(BASE);
    expect(findings).toEqual([th]);
  });

  it('returns findings from semgrep even when trufflehog finds nothing', async () => {
    const sg = { file: 'b.py', line: 5, severity: 'medium', message: 'eval', ruleId: 'python/eval', tool: 'semgrep' };
    runSemgrep.mockResolvedValueOnce([sg]);

    const findings = await dispatch(BASE);
    expect(findings).toEqual([sg]);
  });

  it('still calls both adapters when changedFiles is empty', async () => {
    await dispatch({ ...BASE, changedFiles: [] });
    expect(runTrufflehog).toHaveBeenCalledWith(expect.objectContaining({ changedFiles: [] }));
    expect(runSemgrep).toHaveBeenCalledOnce();
  });

  it('propagates errors from adapters', async () => {
    runTrufflehog.mockRejectedValueOnce(new Error('trufflehog not installed'));
    await expect(dispatch(BASE)).rejects.toThrow('trufflehog not installed');
  });

  it('propagates errors from semgrep', async () => {
    runSemgrep.mockRejectedValueOnce(new Error('semgrep not installed'));
    await expect(dispatch(BASE)).rejects.toThrow('semgrep not installed');
  });

  it('calls loadScanConfig with owner and repo from the dispatch args', async () => {
    await dispatch(BASE);
    expect(loadScanConfig).toHaveBeenCalledWith({ owner: 'org', repo: 'repo' });
  });

  it('passes toolConfig.semgrep from scanConfig to runSemgrep', async () => {
    await dispatch(BASE);
    expect(runSemgrep).toHaveBeenCalledWith(expect.objectContaining({
      toolConfig: { enabled: true, extraArgs: ['--config', 'auto'] },
    }));
  });

  it('passes toolConfig.trufflehog from scanConfig to runTrufflehog', async () => {
    await dispatch(BASE);
    expect(runTrufflehog).toHaveBeenCalledWith(expect.objectContaining({
      toolConfig: { enabled: true, extraArgs: [] },
    }));
  });

  it('passes toolConfig.claude from scanConfig to runClaude', async () => {
    await dispatch(BASE);
    expect(runClaude).toHaveBeenCalledWith(expect.objectContaining({
      toolConfig: { enabled: false, model: 'claude-haiku-4-5-20251001' },
    }));
  });

  it('merges findings from all three adapters', async () => {
    const th = { file: 'a.js', line: 1, severity: 'high',   message: 'secret',   ruleId: 'trufflehog/aws',         tool: 'trufflehog' };
    const sg = { file: 'b.py', line: 5, severity: 'medium', message: 'eval',     ruleId: 'python/eval',            tool: 'semgrep' };
    const cl = { file: 'c.sh', line: 3, severity: 'high',   message: 'backdoor', ruleId: 'claude/reverse-shell',   tool: 'claude' };
    runTrufflehog.mockResolvedValueOnce([th]);
    runSemgrep.mockResolvedValueOnce([sg]);
    runClaude.mockResolvedValueOnce([cl]);

    const findings = await dispatch(BASE);
    expect(findings).toHaveLength(3);
    expect(findings).toContainEqual(th);
    expect(findings).toContainEqual(sg);
    expect(findings).toContainEqual(cl);
  });
});
