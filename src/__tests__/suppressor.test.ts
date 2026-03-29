import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessedFinding } from '../types.js';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({ execFile: mockExecFile }));

const { suppressFindings } = await import('../suppressor.js');

// Helper: make execFile resolve with given stdout
function resolveWith(stdout: string) {
  mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, stdout, ''));
}

// Helper: make execFile reject (simulates new file / blob unavailable)
function rejectWith(err: Error = new Error('not found')) {
  mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(err, '', ''));
}

// Sets up both the git diff (identity map: headLine === baseLine) and git show
// (file content) calls for a single file. Use when line shifts are not relevant.
function mockFile(filePath: string, content: string) {
  const lines = content.split('\n');
  const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  const diff = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${count} +1,${count} @@`,
    ...Array(count).fill(' x'),
  ].join('\n');
  resolveWith(diff);    // for buildLineMapForFile (git diff)
  resolveWith(content); // for gitShow (git show)
}

const BASE = { workspacePath: '/workspace', baseSha: 'base-sha', headSha: 'head-sha' };

const finding = (overrides: Partial<ProcessedFinding> = {}): ProcessedFinding => ({
  file: 'src/app.js',
  line: 5,
  severity: 'high',
  message: 'issue',
  ruleId: 'r/1',
  tool: 'semgrep',
  ...overrides,
});

describe('suppressFindings()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns [] and never calls execFile for an empty findings array', async () => {
    const result = await suppressFindings([], BASE);
    expect(result).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('keeps a finding when git show fails (new file)', async () => {
    resolveWith(''); // diff: empty map → fall back to head line
    rejectWith(new Error('fatal: path not in tree')); // show: fails
    const f = finding();
    const result = await suppressFindings([f], BASE);
    expect(result).toEqual([f]);
  });

  it('keeps a finding when there is no SECURITY: comment at base', async () => {
    mockFile('src/app.js', 'line1\nline2\nline3\nline4\nline5\nline6\n');
    const f = finding({ line: 5 });
    const result = await suppressFindings([f], BASE);
    expect(result).toEqual([f]);
  });

  it('suppresses a finding when // SECURITY: reason is on the same line', async () => {
    mockFile('src/app.js', 'line1\nline2\nline3\nline4\nconst x = 1; // SECURITY: reviewed by alice\nline6\n');
    const result = await suppressFindings([finding({ line: 5 })], BASE);
    expect(result).toEqual([]);
  });

  it('suppresses a finding when // SECURITY: reason is on the line immediately above', async () => {
    mockFile('src/app.js', 'line1\nline2\nline3\n// SECURITY: approved in issue #42\nconst x = 1;\nline6\n');
    const result = await suppressFindings([finding({ line: 5 })], BASE);
    expect(result).toEqual([]);
  });

  it('suppresses a finding with # SECURITY: (YAML/shell comment style)', async () => {
    mockFile('src/app.js', 'line1\nline2\nline3\nline4\n# SECURITY: checked for injection\nline6\n');
    const result = await suppressFindings([finding({ line: 5 })], BASE);
    expect(result).toEqual([]);
  });

  it('does NOT suppress when // SECURITY: has no text after the colon', async () => {
    mockFile('src/app.js', 'line1\nline2\nline3\nline4\n// SECURITY:\nline6\n');
    const f = finding({ line: 5 });
    const result = await suppressFindings([f], BASE);
    expect(result).toEqual([f]);
  });

  it('calls execFile exactly twice for two findings in the same file (cache hit)', async () => {
    mockFile('src/app.js', 'line1\nline2\nline3\nline4\nline5\n');
    const f1 = finding({ line: 2 });
    const f2 = finding({ line: 4 });
    await suppressFindings([f1, f2], BASE);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('does not crash and keeps the finding when finding.line === 1', async () => {
    mockFile('src/app.js', 'const x = 1;\nline2\n');
    const f = finding({ line: 1 });
    const result = await suppressFindings([f], BASE);
    expect(result).toEqual([f]);
  });

  it('does not suppress an unvalidated Claude finding', async () => {
    const f = finding({
      tool: 'claude',
      line: 2,
      startLine: 2,
      endLine: 2,
      locationValidated: false,
    });

    const result = await suppressFindings([f], BASE);

    expect(result).toEqual([f]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('uses suppressionLine when checking for SECURITY comments', async () => {
    mockFile('src/app.js', 'line1\nline2\n// SECURITY: approved in prior PR\nline4\n');

    const result = await suppressFindings([finding({
      tool: 'claude',
      startLine: 1,
      endLine: 4,
      annotationStartLine: 4,
      annotationEndLine: 4,
      suppressionLine: 3,
      locationValidated: true,
    })], BASE);

    expect(result).toEqual([]);
  });

  it('returns the correct filtered array for a mixed batch', async () => {
    mockFile('src/a.js', 'line1\n// SECURITY: reviewed by bob\nconst y = 2;\nline4\n');
    mockFile('src/b.js', 'line1\nline2\nline3\n');

    const fA = finding({ file: 'src/a.js', line: 3 }); // should be suppressed
    const fB = finding({ file: 'src/b.js', line: 1 }); // should be kept

    const result = await suppressFindings([fA, fB], BASE);
    expect(result).toEqual([fB]);
  });

  it('handles git show failure for file A independently from success for file B', async () => {
    resolveWith(''); // fA: diff returns empty → fall back to head line
    rejectWith(new Error('not found')); // fA: show fails
    mockFile('src/b.js', 'line1\nline2\nline3\n'); // fB: diff + show succeed

    const fA = finding({ file: 'src/a.js', line: 2 });
    const fB = finding({ file: 'src/b.js', line: 2 });

    const result = await suppressFindings([fA, fB], BASE);
    // fA kept (git show failed), fB kept (no SECURITY comment)
    expect(result).toEqual([fA, fB]);
  });

  // --- Line-shift tests ---

  it('suppresses a finding on a shifted pre-existing line', async () => {
    // PR inserts one line at the top; everything shifts down by 1.
    // Finding is at head line 5 (ignoreSsrfValidation) → maps to base line 4.
    // SECURITY comment is at base line 3 (lineAbove base line 4) → suppressed.
    const diff = [
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1,5 +1,6 @@',
      '+INSERTED',
      ' line1',
      ' line2',
      ' // SECURITY: approved in prior PR',
      ' ignoreSsrfValidation: true',
      ' line5',
    ].join('\n');
    resolveWith(diff);
    resolveWith('line1\nline2\n// SECURITY: approved in prior PR\nignoreSsrfValidation: true\nline5\n');

    const result = await suppressFindings([finding({ line: 5 })], BASE);
    expect(result).toEqual([]);
  });

  it('keeps a finding on a newly added line', async () => {
    // ignoreSsrfValidation: true is a + line in the diff — must not be suppressed
    // even though a SECURITY comment exists nearby.
    const diff = [
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1,4 +1,5 @@',
      ' line1',
      ' line2',
      '+ignoreSsrfValidation: true',
      ' // SECURITY: pre-existing comment for something else',
      ' line4',
    ].join('\n');
    resolveWith(diff); // git show is never reached for a newly added line

    const result = await suppressFindings([finding({ line: 3 })], BASE);
    expect(result).toEqual([finding({ line: 3 })]);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('keeps a finding when there is no SECURITY comment at the correct mapped base line', async () => {
    // PR inserts one line at the top; finding at head line 5 → base line 4.
    // Base line 5 has a SECURITY comment — the old (broken) suppressor would
    // have checked base line 5 (using the head line number directly) and
    // wrongly suppressed. The new suppressor checks base line 4 and correctly keeps.
    const diff = [
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1,5 +1,6 @@',
      '+INSERTED',
      ' line1',
      ' line2',
      ' line3',
      ' ignoreSsrfValidation: true',
      ' // SECURITY: comment at base line 5, not line 3',
    ].join('\n');
    resolveWith(diff);
    resolveWith('line1\nline2\nline3\nignoreSsrfValidation: true\n// SECURITY: comment at base line 5, not line 3\n');

    // head line 5 → base line 4; lineAbove = base line 3 = 'line3' → no match
    const result = await suppressFindings([finding({ line: 5 })], BASE);
    expect(result).toEqual([finding({ line: 5 })]);
  });
});
