import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({ execFile: mockExecFile }));

const { runSemgrep } = await import('../../adapters/semgrep.js');

function stubStdout(stdout) {
  mockExecFile.mockImplementationOnce((cmd, args, cb) => cb(null, stdout, ''));
}

function stubExitWithStdout(stdout) {
  const err = Object.assign(new Error('exit 1'), { code: 1 });
  mockExecFile.mockImplementationOnce((cmd, args, cb) => cb(err, stdout, ''));
}

function stubError(message) {
  mockExecFile.mockImplementationOnce((cmd, args, cb) =>
    cb(new Error(message), '', '')
  );
}

// Semgrep is given the workspace path as its scan target and returns
// that prefix in all output paths. The adapter must strip it.
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

function semgrepOutput(results) {
  return JSON.stringify({ results, errors: [] });
}

describe('runSemgrep()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invokes semgrep with scan subcommand and --json flag', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });

    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('semgrep');
    expect(args).toContain('scan');
    expect(args).toContain('--json');
  });

  it('passes --config auto', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });

    const args = mockExecFile.mock.calls[0][1];
    const idx = args.indexOf('--config');
    expect(args[idx + 1]).toBe('auto');
  });

  it('passes --baseline-commit with the provided baseline ref', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });

    const args = mockExecFile.mock.calls[0][1];
    const idx = args.indexOf('--baseline-commit');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('FETCH_HEAD');
  });

  it('omits --baseline-commit when no baseline is provided', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws' });

    const args = mockExecFile.mock.calls[0][1];
    expect(args).not.toContain('--baseline-commit');
  });

  it('passes the workspacePath as the last argument', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/my-workspace', baseline: 'FETCH_HEAD' });

    const args = mockExecFile.mock.calls[0][1];
    expect(args[args.length - 1]).toBe('/tmp/my-workspace');
  });

  it('returns an empty array when results is empty', async () => {
    stubStdout(semgrepOutput([]));
    const findings = await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });
    expect(findings).toEqual([]);
  });

  it('parses a single finding correctly', async () => {
    stubStdout(semgrepOutput([SEMGREP_RESULT]));
    const findings = await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });

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
    const [finding] = await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });
    expect(finding.file).toBe('src/app.py');
    expect(finding.file).not.toContain('/tmp/ws');
  });

  it('maps ERROR → high severity', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'ERROR' } }]));
    const [f] = await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });
    expect(f.severity).toBe('high');
  });

  it('maps WARNING → medium severity', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'WARNING' } }]));
    const [f] = await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });
    expect(f.severity).toBe('medium');
  });

  it('maps INFO → low severity', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'INFO' } }]));
    const [f] = await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });
    expect(f.severity).toBe('low');
  });

  it('falls back to low for unknown severity values', async () => {
    stubStdout(semgrepOutput([{ ...SEMGREP_RESULT, extra: { ...SEMGREP_RESULT.extra, severity: 'SOMETHING' } }]));
    const [f] = await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });
    expect(f.severity).toBe('low');
  });

  it('parses multiple findings', async () => {
    const result2 = { ...SEMGREP_RESULT, path: 'src/utils.py', start: { line: 5 } };
    stubStdout(semgrepOutput([SEMGREP_RESULT, result2]));
    const findings = await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });
    expect(findings).toHaveLength(2);
  });

  it('still parses findings when semgrep exits non-zero but produces stdout', async () => {
    stubExitWithStdout(semgrepOutput([SEMGREP_RESULT]));
    const findings = await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });
    expect(findings).toHaveLength(1);
  });

  it('returns an empty array when stdout is not valid JSON', async () => {
    stubStdout('not valid json');
    const findings = await runSemgrep({ workspacePath: '/tmp/ws', baseline: 'FETCH_HEAD' });
    expect(findings).toEqual([]);
  });

  it('throws when execFile errors with no stdout (e.g. command not found)', async () => {
    stubError('spawn semgrep ENOENT');
    await expect(runSemgrep({ workspacePath: '/tmp/ws' })).rejects.toThrow('spawn semgrep ENOENT');
  });
});
