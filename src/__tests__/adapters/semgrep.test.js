import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({ execFile: mockExecFile }));

const { runSemgrep } = await import('../../adapters/semgrep.js');

function stubStdout(stdout) {
  mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => cb(null, stdout, ''));
}

function stubExitWithStdout(stdout) {
  const err = Object.assign(new Error('exit 1'), { code: 1 });
  mockExecFile.mockImplementationOnce((cmd, args, opts, cb) => cb(err, stdout, ''));
}

function stubError(message) {
  mockExecFile.mockImplementationOnce((cmd, args, opts, cb) =>
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

function semgrepOutput(results) {
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

    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('semgrep');
    expect(args).toContain('scan');
    expect(args).toContain('--json');
  });

  it('passes --config auto', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });

    const args = mockExecFile.mock.calls[0][1];
    const idx = args.indexOf('--config');
    expect(args[idx + 1]).toBe('auto');
  });

  it('passes changed files as absolute paths', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: ['src/app.py', 'lib/utils.py'] });

    const args = mockExecFile.mock.calls[0][1];
    expect(args).toContain('/tmp/ws/src/app.py');
    expect(args).toContain('/tmp/ws/lib/utils.py');
  });

  it('does not pass --baseline-commit', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });

    const args = mockExecFile.mock.calls[0][1];
    expect(args).not.toContain('--baseline-commit');
  });

  it('runs with cwd set to the workspace path', async () => {
    stubStdout(semgrepOutput([]));
    await runSemgrep({ workspacePath: '/tmp/ws', changedFiles: CHANGED_FILES });

    const opts = mockExecFile.mock.calls[0][2];
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
});
