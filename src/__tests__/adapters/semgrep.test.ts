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

function stubExitWithStdout(stdout: string, exitCode = 1) {
  const err = Object.assign(new Error(`exit ${exitCode}`), { code: exitCode });
  mockExecFile.mockImplementationOnce((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(err, stdout, ''));
}

function stubError(message: string, code?: string) {
  mockExecFile.mockImplementationOnce((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
    cb(Object.assign(new Error(message), code ? { code } : {}), '', '')
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

function semgrepOutput(results: unknown[], errors: unknown[] = []) {
  return JSON.stringify({ results, errors });
}

describe('runSemgrep()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns complete with no findings when enabled and changedFiles is empty', async () => {
    const result = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: [] });
    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
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

  it('returns complete with no findings when results is empty', async () => {
    stubStdout(semgrepOutput([]));
    const result = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
  });

  it('parses a single finding correctly', async () => {
    stubStdout(semgrepOutput([SEMGREP_RESULT]));
    const { findings, status } = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });

    expect(status).toEqual({ outcome: 'complete' });
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
    const { findings: [finding] } = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(finding.file).toBe('src/app.py');
    expect(finding.file).not.toContain('/tmp/ws');
  });

  it('maps ERROR → high severity', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'ERROR' } }]));
    const { findings: [f] } = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(f.severity).toBe('high');
  });

  it('maps WARNING → medium severity', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'WARNING' } }]));
    const { findings: [f] } = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(f.severity).toBe('medium');
  });

  it('maps INFO → low severity', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'INFO' } }]));
    const { findings: [f] } = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(f.severity).toBe('low');
  });

  it('falls back to low for unknown severity values', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'SOMETHING' } }]));
    const { findings: [f] } = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(f.severity).toBe('low');
  });

  it('parses multiple findings', async () => {
    const result2 = { ...SEMGREP_RESULT, path: '/tmp/ws/src/utils.py', start: { line: 5 } };
    stubStdout(semgrepOutput([SEMGREP_RESULT, result2]));
    const { findings } = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(findings).toHaveLength(2);
  });

  it('returns complete findings for Semgrep exit code 1', async () => {
    stubExitWithStdout(semgrepOutput([SEMGREP_RESULT]), 1);
    const result = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(result.findings).toHaveLength(1);
    expect(result.status).toEqual({ outcome: 'complete' });
  });

  it('returns incomplete when stdout is not valid JSON', async () => {
    stubStdout('not valid json');
    const result = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(result).toEqual({
      findings: [],
      status: { outcome: 'incomplete', reason: 'invalid-output' },
    });
  });

  it('retains valid findings but returns incomplete when scanner errors are reported', async () => {
    stubStdout(semgrepOutput([SEMGREP_RESULT], [{ message: 'partial scan failure' }]));
    const result = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(result.findings).toHaveLength(1);
    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'scanner-errors-reported' });
  });

  it('retains findings but returns incomplete for an unexpected exit code', async () => {
    stubExitWithStdout(semgrepOutput([SEMGREP_RESULT]), 2);
    const result = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(result.findings).toHaveLength(1);
    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'unexpected-exit' });
  });

  it('returns incomplete when the Semgrep executable is unavailable', async () => {
    stubError('spawn semgrep ENOENT', 'ENOENT');
    const result = await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });
    expect(result).toEqual({
      findings: [],
      status: { outcome: 'incomplete', reason: 'tool-unavailable' },
    });
  });

  it('passes the signal to semgrep and propagates parent cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('scan cancelled');
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], opts: { signal?: AbortSignal }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(opts.signal).toBe(controller.signal);
      controller.abort(reason);
      cb(new Error('process aborted'), semgrepOutput([SEMGREP_RESULT]), '');
    });

    await expect(runSemgrep({
      workspacePath: '/tmp/ws',
      changedFiles: CHANGED_FILES,
      signal: controller.signal,
    })).rejects.toBe(reason);
  });

  it('returns disabled immediately when toolConfig.enabled is false', async () => {
    const result = await runSemgrep({
      workspacePath: '/tmp/ws',
      changedFiles:  CHANGED_FILES,
      toolConfig:    { enabled: false, extraArgs: [] },
    });
    expect(result).toEqual({ findings: [], status: { outcome: 'disabled' } });
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
});
