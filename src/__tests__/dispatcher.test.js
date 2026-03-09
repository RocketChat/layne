import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../adapters/trufflehog.js', () => ({
  runTrufflehog: vi.fn().mockResolvedValue([]),
}));

vi.mock('../adapters/semgrep.js', () => ({
  runSemgrep: vi.fn().mockResolvedValue([]),
}));

const { runTrufflehog } = await import('../adapters/trufflehog.js');
const { runSemgrep }    = await import('../adapters/semgrep.js');
const { dispatch }      = await import('../dispatcher.js');

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

  it('calls both adapters', async () => {
    await dispatch(BASE);
    expect(runTrufflehog).toHaveBeenCalledOnce();
    expect(runSemgrep).toHaveBeenCalledOnce();
  });

  it('passes changedFiles to the trufflehog adapter', async () => {
    await dispatch(BASE);
    expect(runTrufflehog).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/tmp/ws',
      changedFiles:  ['src/app.js', 'src/utils.js'],
    }));
  });

  it('passes FETCH_HEAD as the baseline to semgrep', async () => {
    await dispatch(BASE);
    expect(runSemgrep).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/tmp/ws',
      baseline:      'FETCH_HEAD',
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
});
