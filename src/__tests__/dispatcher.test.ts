import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScanContext, LineRangesByFile } from '../types.js';

vi.mock('../adapters/trufflehog.js', () => ({
  runTrufflehog: vi.fn().mockResolvedValue([]),
}));

vi.mock('../adapters/semgrep.js', () => ({
  runSemgrep: vi.fn().mockResolvedValue([]),
}));

vi.mock('../adapters/claude.js', () => ({
  runClaude: vi.fn().mockResolvedValue([]),
}));

vi.mock('../adapters/spectre.js', () => ({
  runSpectre: vi.fn().mockResolvedValue([]),
}));

vi.mock('../adapters/dep-doctor.js', () => ({
  runDepDoctor: vi.fn().mockResolvedValue([]),
}));

vi.mock('../config.js', () => ({
  DEFAULT_CONFIG: {
    spectre: { enabled: false, model: 'claude-haiku-4-5-20251001', fileCap: 20, minSeverity: 'high' },
  },
  loadScanConfig: vi.fn().mockResolvedValue({
    semgrep:    { enabled: true, extraArgs: ['--config', 'auto'] },
    trufflehog: { enabled: true, extraArgs: [] },
    claude:     { enabled: false, model: 'claude-haiku-4-5-20251001' },
    spectre:    { enabled: false, model: 'claude-haiku-4-5-20251001', fileCap: 20, minSeverity: 'high' },
    depDoctor:  { enabled: false, minCveSeverity: 'high', checkAbandoned: true, abandonedDays: 730, checkDeprecated: true, extraArgs: [] },
  }),
}));

const { runTrufflehog }  = await import('../adapters/trufflehog.js');
const { runSemgrep }     = await import('../adapters/semgrep.js');
const { runClaude }      = await import('../adapters/claude.js');
const { runSpectre }     = await import('../adapters/spectre.js');
const { runDepDoctor }   = await import('../adapters/dep-doctor.js');
const { loadScanConfig } = await import('../config.js');
const { dispatch }       = await import('../dispatcher.js');

const BASE_SCAN_CONTEXT: ScanContext = {
  mode:              'changed_files',
  contextLines:      8,
  headSha:           'abc123',
  baseSha:           'def456',
  repoWorkspacePath: '/tmp/ws',
  scanWorkspacePath: '/tmp/ws',
  scanFiles:         ['src/app.js', 'src/utils.js'],
  promptFiles:       [],
  changedLineRanges: new Map(),
};

const BASE = {
  scanContext:       BASE_SCAN_CONTEXT,
  changedLineRanges: new Map([['src/app.js', [{ start: 2, end: 4 }]]]) as LineRangesByFile,
  owner:             'org',
  repo:              'repo',
};

describe('dispatch()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls all five adapters', async () => {
    await dispatch(BASE);
    expect(runTrufflehog).toHaveBeenCalledOnce();
    expect(runSemgrep).toHaveBeenCalledOnce();
    expect(runClaude).toHaveBeenCalledOnce();
    expect(runSpectre).toHaveBeenCalledOnce();
    expect(runDepDoctor).toHaveBeenCalledOnce();
  });

  it('passes scanFiles and scanWorkspacePath to the trufflehog adapter', async () => {
    await dispatch(BASE);
    expect(runTrufflehog).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/tmp/ws',
      changedFiles:  ['src/app.js', 'src/utils.js'],
    }));
  });

  it('passes scanFiles and scanWorkspacePath to the semgrep adapter', async () => {
    await dispatch(BASE);
    expect(runSemgrep).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/tmp/ws',
      changedFiles:  ['src/app.js', 'src/utils.js'],
    }));
  });

  it('returns an empty array when all adapters return no findings', async () => {
    const findings = await dispatch(BASE);
    expect(findings).toEqual([]);
  });

  it('merges findings from trufflehog and semgrep into a single array', async () => {
    const th = { file: 'a.js', line: 1, severity: 'high',   message: 'secret', ruleId: 'trufflehog/aws', tool: 'trufflehog' };
    const sg = { file: 'b.py', line: 5, severity: 'medium', message: 'eval',   ruleId: 'python/eval',    tool: 'semgrep' };
    (runTrufflehog as ReturnType<typeof vi.fn>).mockResolvedValueOnce([th]);
    (runSemgrep as ReturnType<typeof vi.fn>).mockResolvedValueOnce([sg]);

    const findings = await dispatch(BASE);
    expect(findings).toHaveLength(2);
    expect(findings).toContainEqual(th);
    expect(findings).toContainEqual(sg);
  });

  it('returns findings from trufflehog even when semgrep finds nothing', async () => {
    const th = { file: 'a.js', line: 1, severity: 'high', message: 'secret', ruleId: 'trufflehog/aws', tool: 'trufflehog' };
    (runTrufflehog as ReturnType<typeof vi.fn>).mockResolvedValueOnce([th]);

    const findings = await dispatch(BASE);
    expect(findings).toEqual([th]);
  });

  it('returns findings from semgrep even when trufflehog finds nothing', async () => {
    const sg = { file: 'b.py', line: 5, severity: 'medium', message: 'eval', ruleId: 'python/eval', tool: 'semgrep' };
    (runSemgrep as ReturnType<typeof vi.fn>).mockResolvedValueOnce([sg]);

    const findings = await dispatch(BASE);
    expect(findings).toEqual([sg]);
  });

  it('still calls both adapters when scanFiles is empty', async () => {
    await dispatch({ ...BASE, scanContext: { ...BASE_SCAN_CONTEXT, scanFiles: [] } });
    expect(runTrufflehog).toHaveBeenCalledWith(expect.objectContaining({ changedFiles: [] }));
    expect(runSemgrep).toHaveBeenCalledOnce();
  });

  it('propagates errors from adapters', async () => {
    (runTrufflehog as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('trufflehog not installed'));
    await expect(dispatch(BASE)).rejects.toThrow('trufflehog not installed');
  });

  it('propagates errors from semgrep', async () => {
    (runSemgrep as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('semgrep not installed'));
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

  it('passes toolConfig.claude, changedLineRanges, and promptFiles to runClaude', async () => {
    await dispatch(BASE);
    expect(runClaude).toHaveBeenCalledWith(expect.objectContaining({
      toolConfig: { enabled: false, model: 'claude-haiku-4-5-20251001' },
      changedLineRanges: new Map([['src/app.js', [{ start: 2, end: 4 }]]]),
      promptFiles: [],
    }));
  });

  it('passes promptFiles from scan context to runClaude in diff_only mode', async () => {
    const promptFiles = [{ file: 'src/app.js', content: '@@ lines 2-4 @@\n2| foo\n3| bar' }];
    const diffContext: ScanContext = { ...BASE_SCAN_CONTEXT, mode: 'diff_only', promptFiles };
    await dispatch({ ...BASE, scanContext: diffContext });
    expect(runClaude).toHaveBeenCalledWith(expect.objectContaining({ promptFiles }));
  });

  it('merges findings from all four adapters', async () => {
    const th = { file: 'a.js', line: 1, severity: 'high',   message: 'secret',   ruleId: 'trufflehog/aws',                tool: 'trufflehog' };
    const sg = { file: 'b.py', line: 5, severity: 'medium', message: 'eval',     ruleId: 'python/eval',                   tool: 'semgrep' };
    const cl = { file: 'c.sh', line: 3, severity: 'high',   message: 'backdoor', ruleId: 'claude/reverse-shell',          tool: 'claude' };
    const sp = { file: 'd.js', line: 9, severity: 'high',   message: 'exfil',    ruleId: 'credential-exfiltration', tool: 'spectre' };
    (runTrufflehog as ReturnType<typeof vi.fn>).mockResolvedValueOnce([th]);
    (runSemgrep as ReturnType<typeof vi.fn>).mockResolvedValueOnce([sg]);
    (runClaude as ReturnType<typeof vi.fn>).mockResolvedValueOnce([cl]);
    (runSpectre as ReturnType<typeof vi.fn>).mockResolvedValueOnce([sp]);

    const findings = await dispatch(BASE);
    expect(findings).toHaveLength(4);
    expect(findings).toContainEqual(th);
    expect(findings).toContainEqual(sg);
    expect(findings).toContainEqual(cl);
    expect(findings).toContainEqual(sp);
  });

  it('passes toolConfig.spectre, changedLineRanges, and promptFiles to runSpectre', async () => {
    await dispatch(BASE);
    expect(runSpectre).toHaveBeenCalledWith(expect.objectContaining({
      toolConfig: { enabled: false, model: 'claude-haiku-4-5-20251001', fileCap: 20, minSeverity: 'high' },
      changedLineRanges: new Map([['src/app.js', [{ start: 2, end: 4 }]]]),
      promptFiles: [],
    }));
  });

  it('passes promptFiles from scan context to runSpectre in diff_only mode', async () => {
    const promptFiles = [{ file: 'src/app.js', content: '@@ -1,3 +1,4 @@\n foo\n+bar' }];
    const diffContext: ScanContext = { ...BASE_SCAN_CONTEXT, mode: 'diff_only', promptFiles };
    await dispatch({ ...BASE, scanContext: diffContext });
    expect(runSpectre).toHaveBeenCalledWith(expect.objectContaining({ promptFiles }));
  });
});
