import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate  = vi.fn();
const mockBetaCreate = vi.fn();
const mockReadFile = vi.fn();
const mockClientInitialization = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: function Anthropic() {
    mockClientInitialization();
    return {
      messages: { create: mockCreate },
      beta: { messages: { create: mockBetaCreate } },
    };
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

  it('returns complete with no findings when enabled and changedFiles is empty', async () => {
    const result = await runClaude({ workspacePath: WORKSPACE, changedFiles: [], toolConfig: ENABLED_CONFIG });
    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns complete with no findings when enabled and changedFiles is null', async () => {
    const result = await runClaude({ workspacePath: WORKSPACE, changedFiles: null, toolConfig: ENABLED_CONFIG });
    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns disabled immediately when toolConfig.enabled is false', async () => {
    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    { enabled: false, model: 'claude-haiku-4-5-20251001' },
    });
    expect(result).toEqual({ findings: [], status: { outcome: 'disabled' } });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('returns incomplete when the model makes no report_findings tool call', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(noToolCallResponse());
    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    ENABLED_CONFIG,
    });
    expect(result).toEqual({
      findings: [],
      status: { outcome: 'incomplete', reason: 'invalid-provider-response' },
    });
  });

  it('returns incomplete when report_findings has no findings array', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', name: 'report_findings', input: {} }],
    });

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles: CHANGED_FILES,
      toolConfig: ENABLED_CONFIG,
    });

    expect(result).toEqual({
      findings: [],
      status: { outcome: 'incomplete', reason: 'invalid-provider-response' },
    });
  });

  it('retains valid findings when a sibling provider finding is malformed', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(findingResponse([
      {
        file: 'src/app.js', startLine: 2, endLine: 2, severity: 'high',
        message: 'Backdoor', ruleId: 'backdoor', evidence: 'bad()',
      },
      { file: 'src/app.js', severity: 'high' },
    ]));

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles: CHANGED_FILES,
      toolConfig: ENABLED_CONFIG,
    });

    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'invalid-provider-response' });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe('claude/backdoor');
  });

  it('retains findings but marks multiple report tool calls invalid', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', name: 'report_findings', input: { findings: [] } },
        findingResponse([{
          file: 'src/app.js', startLine: 3, endLine: 3, severity: 'high',
          message: 'Backdoor', ruleId: 'backdoor', evidence: 'bad()',
        }]).content[0],
      ],
    });

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles: CHANGED_FILES,
      toolConfig: ENABLED_CONFIG,
    });

    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'invalid-provider-response' });
    expect(result.findings).toHaveLength(1);
  });

  it('rejects unsupported severity values without losing valid siblings', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(findingResponse([
      {
        file: 'src/app.js', startLine: 2, endLine: 2, severity: 'HIGH',
        message: 'Bad severity', ruleId: 'bad-severity', evidence: 'bad()',
      },
      {
        file: 'src/app.js', startLine: 4, endLine: 4, severity: 'medium',
        message: 'Valid', ruleId: 'valid', evidence: 'valid()',
      },
    ]));

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles: CHANGED_FILES,
      toolConfig: ENABLED_CONFIG,
    });

    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'invalid-provider-response' });
    expect(result.findings.map(finding => finding.ruleId)).toEqual(['claude/valid']);
  });

  it('returns complete when tool call has no findings', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(cleanResponse());
    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    ENABLED_CONFIG,
    });
    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
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

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    ENABLED_CONFIG,
    });

    expect(result.status).toEqual({ outcome: 'complete' });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
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

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  ['a.js', 'b.js'],
      toolConfig:    ENABLED_CONFIG,
    });

    expect(result.status).toEqual({ outcome: 'complete' });
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].startLine).toBe(1);
    expect(result.findings[1].endLine).toBe(3);
    expect(result.findings[0].ruleId).toBe('claude/r1');
    expect(result.findings[1].ruleId).toBe('claude/r2');
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

  it('returns complete and does not call the API when all files are binary', async () => {
    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  ['image.png', 'archive.zip'],
      toolConfig:    ENABLED_CONFIG,
    });

    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns complete when a selected file is truncated to the 50KB limit', async () => {
    mockReadFile.mockResolvedValueOnce('a'.repeat(60_000));
    mockCreate.mockResolvedValueOnce(cleanResponse());

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles: CHANGED_FILES,
      toolConfig: ENABLED_CONFIG,
    });

    expect(result.status).toEqual({ outcome: 'complete' });
    const callArgs = mockCreate.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(callArgs.messages[0].content).toContain('[truncated]');
  });

  it('marks API errors incomplete without exposing the raw error', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      toolConfig:    ENABLED_CONFIG,
    });

    expect(result).toEqual({
      findings: [],
      status: { outcome: 'incomplete', reason: 'api-batch-failed' },
    });
    expect(JSON.stringify(result.status)).not.toContain('rate limit');
  });

  it('marks client initialization failures incomplete without exposing the raw error', async () => {
    mockReadFile.mockResolvedValueOnce(DUMMY_CONTENT);
    mockClientInitialization.mockImplementationOnce(() => {
      throw new Error('secret initialization details');
    });

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles: CHANGED_FILES,
      toolConfig: ENABLED_CONFIG,
    });

    expect(result).toEqual({
      findings: [],
      status: { outcome: 'incomplete', reason: 'client-initialization-failed' },
    });
    expect(JSON.stringify(result.status)).not.toContain('secret initialization details');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('retains findings from successful batches when another batch fails', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce(findingResponse([{
        file: 'src/b.js',
        startLine: 1,
        endLine: 1,
        severity: 'high',
        message: 'bad',
        ruleId: 'backdoor',
        evidence: 'bad',
      }]));

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js', 'src/b.js'],
      promptFiles: [
        { file: 'src/a.js', content: 'a'.repeat(60_000) },
        { file: 'src/b.js', content: 'b'.repeat(60_000) },
      ],
      toolConfig: ENABLED_CONFIG,
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'api-batch-failed' });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe('claude/backdoor');
  });

  it('marks a changed file missing from prepared prompt files incomplete', async () => {
    mockCreate.mockResolvedValueOnce(cleanResponse());

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js', 'src/b.js'],
      changedLineRanges: new Map([
        ['src/a.js', [{ start: 1, end: 1 }]],
        ['src/b.js', [{ start: 1, end: 1 }]],
      ]),
      promptFiles: [{ file: 'src/a.js', content: 'const a = 1;' }],
      toolConfig: ENABLED_CONFIG,
    });

    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'file-read-failed' });
  });

  it('passes the signal to prompt requests and stops before the next batch when cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('scan cancelled');
    mockCreate.mockImplementationOnce(async (_params: unknown, options: { signal?: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort(reason);
      return cleanResponse();
    });

    await expect(runClaude({
      workspacePath: WORKSPACE,
      changedFiles: ['src/a.js', 'src/b.js'],
      promptFiles: [
        { file: 'src/a.js', content: 'a'.repeat(60_000) },
        { file: 'src/b.js', content: 'b'.repeat(60_000) },
      ],
      toolConfig: ENABLED_CONFIG,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it('passes the signal to skill requests and stops pause_turn continuations when cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('scan cancelled');
    mockBetaCreate.mockImplementationOnce(async (_params: unknown, options: { signal?: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort(reason);
      return {
        content: [{ type: 'text', text: 'continuing' }],
        stop_reason: 'pause_turn',
        container: { id: 'container-1' },
      };
    });

    await expect(runClaude({
      workspacePath: WORKSPACE,
      changedFiles: CHANGED_FILES,
      promptFiles: [{ file: 'src/app.js', content: DUMMY_CONTENT }],
      toolConfig: { ...ENABLED_CONFIG, skill: { id: 'skill-1' } },
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(mockBetaCreate).toHaveBeenCalledOnce();
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

  it('marks unreadable selected files incomplete and continues', async () => {
    mockReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce(DUMMY_CONTENT);
    mockCreate.mockResolvedValueOnce(cleanResponse());

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  ['missing.js', 'src/app.js'],
      toolConfig:    ENABLED_CONFIG,
    });

    expect(result).toEqual({
      findings: [],
      status: { outcome: 'incomplete', reason: 'file-read-failed' },
    });
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

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles: CHANGED_FILES,
      toolConfig: ENABLED_CONFIG,
    });
    const [finding] = result.findings;

    expect(finding).toBeDefined();
    if (!finding) throw new Error('expected a finding');
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

    const result = await runClaude({
      workspacePath: WORKSPACE,
      changedFiles:  CHANGED_FILES,
      promptFiles,
      toolConfig:    ENABLED_CONFIG,
    });

    expect(result.status).toEqual({ outcome: 'complete' });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe('claude/eval-injection');
    expect(result.findings[0].startLine).toBe(3);
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
