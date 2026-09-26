import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({ execFile: mockExecFile }));
vi.mock('../../config.js', () => ({
  DEFAULT_CONFIG: Object.freeze({
    semgrep: Object.freeze({ enabled: true, extraArgs: ['--config', 'auto'] }),
    trufflehog: Object.freeze({ enabled: true, extraArgs: [] }),
  }),
}));

const { runTrufflehog } = await import('../../adapters/trufflehog.js');

// Helper to make execFile resolve with the given stdout.
function stubStdout(stdout: string) {
  mockExecFile.mockImplementationOnce((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, stdout, ''));
}

// Helper to make execFile resolve with a non-zero exit but still produce stdout
// (e.g. Trufflehog exits 183 when secrets are found).
function stubExitWithStdout(stdout: string, exitCode = 183) {
  const err = Object.assign(new Error(`exit ${exitCode}`), { code: exitCode });
  mockExecFile.mockImplementationOnce((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(err, stdout, ''));
}

// Helper to make execFile fail with no stdout (command not found, etc.).
function stubError(message: string) {
  mockExecFile.mockImplementationOnce((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) =>
    cb(new Error(message), '', '')
  );
}

// Trufflehog receives absolute paths and returns them in its output.
// The adapter must strip the workspace prefix before returning findings.
const FINDING_LINE = JSON.stringify({
  SourceMetadata: { Data: { Filesystem: { file: '/tmp/ws/src/config.js', line: 42 } } },
  DetectorName: 'AWS',
  Raw: 'AKIAIOSFODNN7EXAMPLE',
  Verified: true,
});

const CHANGED = ['src/config.js', 'src/db.js'];

describe('runTrufflehog()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns complete with no findings when enabled and changedFiles is empty', async () => {
    const result = await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: [] });
    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns complete with no findings when enabled and changedFiles is omitted', async () => {
    const result = await runTrufflehog({ workspacePath: '/tmp/ws' });
    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('invokes trufflehog with filesystem subcommand and --json flag', async () => {
    stubStdout('');
    await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: CHANGED });

    const [cmd, args] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('trufflehog');
    expect(args).toContain('filesystem');
    expect(args).toContain('--json');
    expect(args).toContain('--no-update');
  });

  it('passes changed files as absolute paths (not --directory)', async () => {
    stubStdout('');
    await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: CHANGED });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).not.toContain('--directory');
    expect(args).toContain('/tmp/ws/src/config.js');
    expect(args).toContain('/tmp/ws/src/db.js');
  });

  it('returns complete with no findings when stdout is empty', async () => {
    stubStdout('');
    const result = await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: CHANGED });
    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
  });

  it('parses a single finding from one JSON line', async () => {
    stubStdout(FINDING_LINE);
    const { findings, status } = await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: CHANGED });

    expect(status).toEqual({ outcome: 'complete' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file:     'src/config.js',
      line:     42,
      severity: 'high',
      message:  'AWS secret detected',
      ruleId:   'trufflehog/aws',
      tool:     'trufflehog',
    });
  });

  it('strips the workspace path prefix from the file field', async () => {
    stubStdout(FINDING_LINE);
    const { findings: [finding] } = await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: CHANGED });
    expect(finding.file).toBe('src/config.js');
    expect(finding.file).not.toContain('/tmp/ws');
  });

  it('parses multiple findings from multiple JSON lines', async () => {
    const line2 = JSON.stringify({
      SourceMetadata: { Data: { Filesystem: { file: '/tmp/ws/src/db.js', line: 7 } } },
      DetectorName: 'GitHub',
      Raw: 'ghp_xxxx',
      Verified: false,
    });
    stubStdout(`${FINDING_LINE}\n${line2}`);

    const { findings } = await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: CHANGED });
    expect(findings).toHaveLength(2);
    expect(findings[1].ruleId).toBe('trufflehog/github');
  });

  it('retains valid findings but returns incomplete for malformed NDJSON lines', async () => {
    stubStdout(`not-json\n${FINDING_LINE}\nalso-not-json`);
    const result = await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: CHANGED });
    expect(result.findings).toHaveLength(1);
    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'invalid-output' });
  });

  it('returns complete findings for Trufflehog exit code 183', async () => {
    stubExitWithStdout(FINDING_LINE, 183);
    const result = await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: CHANGED });
    expect(result.findings).toHaveLength(1);
    expect(result.status).toEqual({ outcome: 'complete' });
  });

  it('retains findings but returns incomplete for an unexpected exit code', async () => {
    stubExitWithStdout(FINDING_LINE, 2);
    const result = await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: CHANGED });
    expect(result.findings).toHaveLength(1);
    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'unexpected-exit' });
  });

  it('falls back to "unknown" for missing SourceMetadata fields', async () => {
    const bare = JSON.stringify({ DetectorName: 'Slack' });
    stubStdout(bare);
    const { findings: [finding] } = await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: CHANGED });
    expect(finding.file).toBe('unknown');
    expect(finding.line).toBe(1);
  });

  it('returns disabled immediately when toolConfig.enabled is false', async () => {
    const result = await runTrufflehog({
      workspacePath: '/tmp/ws',
      changedFiles:  CHANGED,
      toolConfig:    { enabled: false, extraArgs: [] },
    });
    expect(result).toEqual({ findings: [], status: { outcome: 'disabled' } });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('default toolConfig produces -- sentinel before file paths and no extra flags', async () => {
    stubStdout('');
    await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: CHANGED });

    const args = mockExecFile.mock.calls[0][1] as string[];
    const noUpdateIdx = args.indexOf('--no-update');
    expect(args[noUpdateIdx + 1]).toBe('--');
    expect(args[noUpdateIdx + 2]).toBe('/tmp/ws/src/config.js');
  });

  it('extraArgs: ["--only-verified"] appears before file paths', async () => {
    stubStdout('');
    await runTrufflehog({
      workspacePath: '/tmp/ws',
      changedFiles:  CHANGED,
      toolConfig:    { enabled: true, extraArgs: ['--only-verified'] },
    });

    const args = mockExecFile.mock.calls[0][1] as string[];
    const onlyVerifiedIdx = args.indexOf('--only-verified');
    const firstFileIdx    = args.indexOf('/tmp/ws/src/config.js');
    expect(onlyVerifiedIdx).toBeGreaterThan(-1);
    expect(onlyVerifiedIdx).toBeLessThan(firstFileIdx);
  });

  it('multiple extraArgs flags all appear before file paths', async () => {
    stubStdout('');
    await runTrufflehog({
      workspacePath: '/tmp/ws',
      changedFiles:  CHANGED,
      toolConfig:    { enabled: true, extraArgs: ['--only-verified', '--exclude-detectors', 'GitHub,AWS'] },
    });

    const args = mockExecFile.mock.calls[0][1] as string[];
    const firstFileIdx        = args.indexOf('/tmp/ws/src/config.js');
    const onlyVerifiedIdx     = args.indexOf('--only-verified');
    const excludeDetectorsIdx = args.indexOf('--exclude-detectors');
    expect(onlyVerifiedIdx).toBeLessThan(firstFileIdx);
    expect(excludeDetectorsIdx).toBeLessThan(firstFileIdx);
    expect(args[excludeDetectorsIdx + 1]).toBe('GitHub,AWS');
  });

  it('extraArgs appear in every batch for large file lists', async () => {
    // 201 files forces two batches
    const manyFiles = Array.from({ length: 201 }, (_, i) => `src/file${i}.js`);
    stubStdout('');
    stubStdout('');
    await runTrufflehog({
      workspacePath: '/tmp/ws',
      changedFiles:  manyFiles,
      toolConfig:    { enabled: true, extraArgs: ['--only-verified'] },
    });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    for (const call of mockExecFile.mock.calls) {
      expect(call[1]).toContain('--only-verified');
    }
  });

  it('preserves earlier findings and returns incomplete when a later batch fails to spawn', async () => {
    const manyFiles = Array.from({ length: 201 }, (_, i) => `src/file${i}.js`);
    stubStdout(FINDING_LINE);
    stubError('spawn trufflehog EACCES');

    const result = await runTrufflehog({ workspacePath: '/tmp/ws', changedFiles: manyFiles });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(result.findings).toHaveLength(1);
    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'command-failed' });
  });

  it('propagates cancellation and does not start another batch', async () => {
    const controller = new AbortController();
    const reason = new Error('scan cancelled');
    const manyFiles = Array.from({ length: 201 }, (_, i) => `src/file${i}.js`);
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], opts: { signal?: AbortSignal }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(opts.signal).toBe(controller.signal);
      controller.abort(reason);
      cb(new Error('process aborted'), '', '');
    });

    await expect(runTrufflehog({
      workspacePath: '/tmp/ws',
      changedFiles: manyFiles,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(mockExecFile).toHaveBeenCalledOnce();
  });
});
