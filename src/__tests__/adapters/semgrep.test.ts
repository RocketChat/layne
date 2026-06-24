import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({ execFile: mockExecFile }));
vi.mock('../../config.js', () => ({
  DEFAULT_CONFIG: Object.freeze({
    semgrep: Object.freeze({ enabled: true, extraArgs: ['--config', 'auto'] }),
    trufflehog: Object.freeze({ enabled: true, extraArgs: [] }),
  }),
}));

const { runSemgrep } = await import('../../adapters/semgrep.js');

function stubStdout(stdout: string) {
  mockExecFile.mockImplementationOnce((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, stdout, ''));
}

function stubExitWithStdout(stdout: string) {
  const err = Object.assign(new Error('exit 1'), { code: 1 });
  mockExecFile.mockImplementationOnce((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(err, stdout, ''));
}

function stubError(message: string) {
  mockExecFile.mockImplementationOnce((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
    cb(new Error(message), '', '')
  );
}

// Semgrep is given absolute file paths as scan targets and returns those
// absolute paths in its output. The adapter must strip the workspace prefix.
const SEMGREP_RESULT = {
  check_id: 'python.lang.security.audit.eval.eval-detected',
  path:     '/tmp/ws/src/app.py',
  start:    { line: 10, col: 1 },
  end:      { line: 10, col: 20 },
  extra: {
    message:  'Detected eval usage',
    severity: 'ERROR',
  },
};

const CHANGED_FILES = ['src/app.py'];

function semgrepOutput(results: unknown[]) {
  return JSON.stringify({ results, errors: [] });
}

describe('runSemgrep()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an empty array immediately when changedFiles is empty', async () => {
    const findings = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: [] });
    expect(findings).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('invokes semgrep with scan subcommand and --json flag', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });

    const [cmd, args] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('semgrep');
    expect(args).toContain('scan');
    expect(args).toContain('--json');
  });

  it('passes --config auto', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });

    const args = mockExecFile.mock.calls[0][1] as string[];
    const idx = args.indexOf('--config');
    expect(args[idx + 1]).toBe('auto');
  });

  it('passes changed files as absolute paths', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: ['src/app.py', 'lib/utils.py'] });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('/tmp/ws/src/app.py');
    expect(args).toContain('/tmp/ws/lib/utils.py');
  });

  it('does not pass --baseline-commit', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).not.toContain('--baseline-commit');
  });

  it('runs with cwd set to the workspace path', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });

    const opts = mockExecFile.mock.calls[0][2] as { cwd: string };
    expect(opts.cwd).toBe('/tmp/ws');
  });

  it('returns an empty array when results is empty', async () => {
    stubStdout(semgrepOutput([]));
    const findings = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(findings).toEqual([]);
  });

  it('parses a single finding correctly', async () => {
    stubStdout(semgrepOutput([SEMGREP_RESULT]));
    const findings = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file:     'src/app.py',
      line:     10,
      severity: 'high',
      message:  'Detected eval usage',
      ruleId:   'python.lang.security.audit.eval.eval-detected',
      tool:     'semgrep',
    });
  });

  it('strips the workspace path prefix from the file field', async () => {
    stubStdout(semgrepOutput([SEMGREP_RESULT]));
    const [finding] = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(finding.file).toBe('src/app.py');
    expect(finding.file).not.toContain('/tmp/ws');
  });

  it('maps ERROR → high severity', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'ERROR' } }]));
    const [f] = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(f.severity).toBe('high');
  });

  it('maps WARNING → medium severity', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'WARNING' } }]));
    const [f] = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(f.severity).toBe('medium');
  });

  it('maps INFO → low severity', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'INFO' } }]));
    const [f] = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(f.severity).toBe('low');
  });

  it('falls back to low for unknown severity values', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'SOMETHING' } }]));
    const [f] = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(f.severity).toBe('low');
  });

  it('parses multiple findings', async () => {
    const result2 = { ...SEMGREP_RESULT, path: '/tmp/ws/src/utils.py', start: { line: 5 } };
    stubStdout(semgrepOutput([SEMGREP_RESULT, result2]));
    const findings = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(findings).toHaveLength(2);
  });

  it('still parses findings when semgrep exits non-zero but produces stdout', async () => {
    stubExitWithStdout(semgrepOutput([SEMGREP_RESULT]));
    const findings = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(findings).toHaveLength(1);
  });

  it('returns an empty array when stdout is not valid JSON', async () => {
    stubStdout('not valid json');
    const findings = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(findings).toEqual([]);
  });

  it('throws when execFile errors with no stdout (e.g. command not found)', async () => {
    stubError('spawn semgrep ENOENT');
    await expect(runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES })).rejects.toThrow('spawn semgrep ENOENT');
  });

  it('returns empty array immediately when toolConfig.enabled is false', async () => {
    const findings = await runSemgrep({
      workspacePath: '/tmp/ws',
      changedFiles:  CHANGED_FILES,
      toolConfig:    { enabled: false, extraArgs: [] },
    });
    expect(findings).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('default toolConfig uses --config auto from DEFAULT_CONFIG', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });

    const args = mockExecFile.mock.calls[0][1] as string[];
    const idx = args.indexOf('--config');
    expect(args[idx + 1]).toBe('auto');
  });

  it('custom extraArgs replaces --config auto entirely', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({
      workspacePath: '/tmp/ws',
      changedFiles:  CHANGED_FILES,
      toolConfig:    { enabled: true, extraArgs: ['--config', 'p/owasp-top-ten'] },
    });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--config');
    expect(args).toContain('p/owasp-top-ten');
    expect(args).not.toContain('auto');
  });

  it('multiple extraArgs flags appear in correct order before --json', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({
      workspacePath: '/tmp/ws',
      changedFiles:  CHANGED_FILES,
      toolConfig:    { enabled: true, extraArgs: ['--config', 'p/custom', '--severity', 'WARNING'] },
    });

    const args = mockExecFile.mock.calls[0][1] as string[];
    const scanIdx   = args.indexOf('scan');
    const configIdx = args.indexOf('--config');
    const jsonIdx   = args.indexOf('--json');
    expect(configIdx).toBeGreaterThan(scanIdx);
    expect(jsonIdx).toBeGreaterThan(args.indexOf('WARNING'));
    expect(args[configIdx + 1]).toBe('p/custom');
    expect(args[args.indexOf('--severity') + 1]).toBe('WARNING');
  });

  it('empty extraArgs produces no extra flags between scan and --json', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({
      workspacePath: '/tmp/ws',
      changedFiles:  CHANGED_FILES,
      toolConfig:    { enabled: true, extraArgs: [] },
    });

    const args = mockExecFile.mock.calls[0][1] as string[];
    const scanIdx = args.indexOf('scan');
    const jsonIdx = args.indexOf('--json');
    expect(jsonIdx).toBe(scanIdx + 1);
  });

  describe('startLine / endLine from Semgrep end.line', () => {
    it('sets startLine and endLine from start.line and end.line on a single-line finding', async () => {
      stubStdout(semgrepOutput([SEMGREP_RESULT]));
      const [f] = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
      expect(f.startLine).toBe(10);
      expect(f.endLine).toBe(10);
    });

    it('sets startLine and endLine from start.line and end.line on a multi-line finding', async () => {
      const multiLine = { ...SEMGREP_RESULT, start: { line: 10, col: 1 }, end: { line: 14, col: 1 } };
      stubStdout(semgrepOutput([multiLine]));
      const [f] = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
      expect(f.startLine).toBe(10);
      expect(f.endLine).toBe(14);
    });

    it('falls back endLine to startLine when end is missing from Semgrep output', async () => {
      const noEnd = { check_id: SEMGREP_RESULT.check_id, path: SEMGREP_RESULT.path, start: { line: 7 }, extra: SEMGREP_RESULT.extra };
      stubStdout(semgrepOutput([noEnd]));
      const [f] = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
      expect(f.startLine).toBe(7);
      expect(f.endLine).toBe(7);
    });
  });
});
