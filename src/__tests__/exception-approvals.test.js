import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../github.js', () => ({
  getTeamMembers: vi.fn(),
}));

vi.mock('../queue.js', () => ({
  redis: {
    set:      vi.fn().mockResolvedValue('OK'),
    get:      vi.fn().mockResolvedValue(null),
    sadd:     vi.fn().mockResolvedValue(1),
    expire:   vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../fetcher.js', () => ({
  fetchCommit:          vi.fn().mockResolvedValue(undefined),
  getChangedLineRanges: vi.fn().mockResolvedValue({}),
  buildLineMapForFile:  vi.fn().mockResolvedValue(new Map()),
}));

const { getTeamMembers }                    = await import('../github.js');
const { redis }                             = await import('../queue.js');
const { fetchCommit, getChangedLineRanges, buildLineMapForFile } = await import('../fetcher.js');
const {
  generateFindingId,
  parseExceptionCommand,
  storeExceptions,
  loadExceptions,
  filterStaleExceptions,
  resolveDriftedExceptions,
  buildExceptionSummary,
  isReviewerAuthorized,
} = await import('../exception-approvals.js');

// ---------------------------------------------------------------------------
// generateFindingId
// ---------------------------------------------------------------------------

describe('generateFindingId()', () => {
  it('returns a string matching LAYNE-[0-9a-f]{16}', () => {
    const id = generateFindingId({ tool: 'semgrep', ruleId: 'eval', file: 'src/a.js', line: 10 });
    expect(id).toMatch(/^LAYNE-[0-9a-f]{16}$/);
  });

  it('is deterministic — same input always returns the same ID', () => {
    const f = { tool: 'trufflehog', ruleId: 'aws-key', file: 'config.js', line: 42 };
    expect(generateFindingId(f)).toBe(generateFindingId(f));
  });

  it('returns different IDs for different files', () => {
    const a = generateFindingId({ tool: 'semgrep', ruleId: 'eval', file: 'a.js', line: 1 });
    const b = generateFindingId({ tool: 'semgrep', ruleId: 'eval', file: 'b.js', line: 1 });
    expect(a).not.toBe(b);
  });

  it('returns different IDs for different tools on the same file and line', () => {
    const a = generateFindingId({ tool: 'semgrep',    ruleId: 'r', file: 'a.js', line: 1 });
    const b = generateFindingId({ tool: 'trufflehog', ruleId: 'r', file: 'a.js', line: 1 });
    expect(a).not.toBe(b);
  });

  it('returns the same ID regardless of ruleId', () => {
    const a = generateFindingId({ tool: 'claude', ruleId: 'reverse-shell', file: 'a.js', line: 1 });
    const b = generateFindingId({ tool: 'claude', ruleId: 'backdoor',      file: 'a.js', line: 1 });
    expect(a).toBe(b);
  });

  it('uses startLine when line is absent', () => {
    const withLine      = generateFindingId({ tool: 'semgrep', ruleId: 'r', file: 'f.js', line: 5 });
    const withStartLine = generateFindingId({ tool: 'semgrep', ruleId: 'r', file: 'f.js', startLine: 5 });
    expect(withLine).toBe(withStartLine);
  });
});

// ---------------------------------------------------------------------------
// parseExceptionCommand
// ---------------------------------------------------------------------------

describe('parseExceptionCommand()', () => {
  it('returns null when body is null/empty', () => {
    expect(parseExceptionCommand(null)).toBeNull();
    expect(parseExceptionCommand('')).toBeNull();
  });

  it('returns null when the body does not contain the command', () => {
    expect(parseExceptionCommand('LGTM, looks good!')).toBeNull();
    expect(parseExceptionCommand('/layne other-command LAYNE-a3f29c81')).toBeNull();
  });

  it('returns error when no valid IDs are present', () => {
    const result = parseExceptionCommand('/layne exception-approve reason: no ids here');
    expect(result).toMatchObject({ ids: [], reason: null, error: expect.any(String) });
  });

  it('rejects 8-character IDs (old format)', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81 reason: test');
    expect(result).toMatchObject({ ids: [], reason: null, error: expect.any(String) });
  });

  it('returns error when reason: token is missing', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81b7e41d22 LAYNE-b7e41d22a3f29c81');
    expect(result).toMatchObject({ ids: ['LAYNE-a3f29c81b7e41d22', 'LAYNE-b7e41d22a3f29c81'], reason: null, error: expect.any(String) });
  });

  it('returns error when reason: is present but has no text after it', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81b7e41d22 reason:');
    expect(result).toMatchObject({ ids: ['LAYNE-a3f29c81b7e41d22'], reason: null, error: expect.any(String) });
  });

  it('parses a valid single-ID command', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81b7e41d22 reason: test credential');
    expect(result).toEqual({ ids: ['LAYNE-a3f29c81b7e41d22'], reason: 'test credential' });
  });

  it('parses a valid multi-ID command', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81b7e41d22 LAYNE-b7e41d22a3f29c81 reason: legacy code');
    expect(result).toEqual({ ids: ['LAYNE-a3f29c81b7e41d22', 'LAYNE-b7e41d22a3f29c81'], reason: 'legacy code' });
  });

  it('finds the command when embedded mid-comment', () => {
    const body = `Great PR overall!\n\n/layne exception-approve LAYNE-a3f29c81b7e41d22 reason: test only\n\nShip it!`;
    const result = parseExceptionCommand(body);
    expect(result).toEqual({ ids: ['LAYNE-a3f29c81b7e41d22'], reason: 'test only' });
  });

  it('preserves multi-word reason text', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81b7e41d22 reason: test credential, will be rotated before release');
    expect(result?.reason).toBe('test credential, will be rotated before release');
  });

  it('handles extra whitespace between tokens', () => {
    const result = parseExceptionCommand('/layne exception-approve  LAYNE-a3f29c81b7e41d22  reason:  ok');
    expect(result?.ids).toEqual(['LAYNE-a3f29c81b7e41d22']);
    expect(result?.reason).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// storeExceptions
// ---------------------------------------------------------------------------

describe('storeExceptions()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls redis.set with the correct key format (no headSha in key)', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, approvedHeadSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'], approver: 'alice', reason: 'test cred',
    });

    expect(redis.set).toHaveBeenCalledWith(
      'layne:exception:org/repo#42:LAYNE-a3f29c81',
      expect.any(String),
      'EX',
      expect.any(Number)
    );
  });

  it('stores a 30-day TTL', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, approvedHeadSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'], approver: 'alice', reason: 'ok',
    });

    const [, , , ttl] = redis.set.mock.calls[0];
    expect(ttl).toBe(30 * 24 * 60 * 60);
  });

  it('stores approver, reason, timestamp, and approvedHeadSha in the JSON value', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, approvedHeadSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'], approver: 'alice', reason: 'test cred',
    });

    const [, value] = redis.set.mock.calls[0];
    const parsed = JSON.parse(value);
    expect(parsed).toMatchObject({
      approver:        'alice',
      reason:          'test cred',
      timestamp:       expect.any(String),
      approvedHeadSha: 'abc123',
    });
  });

  it('writes one key per finding ID in parallel', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, approvedHeadSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81', 'LAYNE-b7e41d22'], approver: 'alice', reason: 'ok',
    });

    expect(redis.set).toHaveBeenCalledTimes(2);
    const keys = redis.set.mock.calls.map(c => c[0]);
    expect(keys).toContain('layne:exception:org/repo#42:LAYNE-a3f29c81');
    expect(keys).toContain('layne:exception:org/repo#42:LAYNE-b7e41d22');
  });

  it('adds all finding IDs to the PR-scoped set and refreshes its TTL', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, approvedHeadSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81', 'LAYNE-b7e41d22'], approver: 'alice', reason: 'ok',
    });

    expect(redis.sadd).toHaveBeenCalledWith(
      'layne:exception-ids:org/repo#42',
      'LAYNE-a3f29c81',
      'LAYNE-b7e41d22',
    );
    expect(redis.expire).toHaveBeenCalledWith('layne:exception-ids:org/repo#42', 30 * 24 * 60 * 60);
  });
});

// ---------------------------------------------------------------------------
// loadExceptions
// ---------------------------------------------------------------------------

describe('loadExceptions()', () => {
  beforeEach(() => vi.clearAllMocks());

  const stored = JSON.stringify({ approver: 'alice', reason: 'test', timestamp: '2026-01-01T00:00:00.000Z', approvedHeadSha: 'abc123' });

  it('returns a Map with parsed values for found keys', async () => {
    redis.get.mockResolvedValue(stored);

    const result = await loadExceptions({
      owner: 'org', repo: 'repo', prNumber: 42,
      findingIds: ['LAYNE-a3f29c81'],
    });

    expect(result).toBeInstanceOf(Map);
    expect(result.get('LAYNE-a3f29c81')).toEqual({
      approver: 'alice', reason: 'test', timestamp: '2026-01-01T00:00:00.000Z', approvedHeadSha: 'abc123',
    });
  });

  it('excludes missing keys from the result Map', async () => {
    redis.get.mockResolvedValueOnce(stored).mockResolvedValueOnce(null);

    const result = await loadExceptions({
      owner: 'org', repo: 'repo', prNumber: 42,
      findingIds: ['LAYNE-a3f29c81', 'LAYNE-b7e41d22'],
    });

    expect(result.size).toBe(1);
    expect(result.has('LAYNE-a3f29c81')).toBe(true);
    expect(result.has('LAYNE-b7e41d22')).toBe(false);
  });

  it('returns an empty Map when all keys are missing', async () => {
    redis.get.mockResolvedValue(null);

    const result = await loadExceptions({
      owner: 'org', repo: 'repo', prNumber: 42,
      findingIds: ['LAYNE-a3f29c81'],
    });

    expect(result.size).toBe(0);
  });

  it('queries the correct Redis key for each finding ID (no headSha in key)', async () => {
    redis.get.mockResolvedValue(null);

    await loadExceptions({
      owner: 'org', repo: 'repo', prNumber: 42,
      findingIds: ['LAYNE-a3f29c81'],
    });

    expect(redis.get).toHaveBeenCalledWith('layne:exception:org/repo#42:LAYNE-a3f29c81');
  });
});

// ---------------------------------------------------------------------------
// filterStaleExceptions
// ---------------------------------------------------------------------------

describe('filterStaleExceptions()', () => {
  beforeEach(() => vi.clearAllMocks());

  const WS           = '/tmp/ws';
  const CURRENT_SHA  = 'current123';
  const APPROVED_SHA = 'approved456';

  const finding = {
    _findingId: 'LAYNE-a3f29c81',
    tool:       'semgrep',
    file:       'src/auth.js',
    line:       42,
    severity:   'high',
    ruleId:     'sql-injection',
  };

  function makeExceptions(approvedHeadSha = APPROVED_SHA) {
    return new Map([
      ['LAYNE-a3f29c81', { approver: 'alice', reason: 'ok', timestamp: '', approvedHeadSha }],
    ]);
  }

  it('returns the map unchanged when it is empty', async () => {
    const result = await filterStaleExceptions({
      exceptions: new Map(), findings: [], workspacePath: WS, currentHeadSha: CURRENT_SHA,
    });
    expect(result.size).toBe(0);
    expect(fetchCommit).not.toHaveBeenCalled();
  });

  it('skips git check when approvedHeadSha equals currentHeadSha', async () => {
    const result = await filterStaleExceptions({
      exceptions:     makeExceptions(CURRENT_SHA),
      findings:       [finding],
      workspacePath:  WS,
      currentHeadSha: CURRENT_SHA,
    });
    expect(fetchCommit).not.toHaveBeenCalled();
    expect(result.has('LAYNE-a3f29c81')).toBe(true);
  });

  it('keeps an exception when the finding line is not in any changed range', async () => {
    getChangedLineRanges.mockResolvedValueOnce({ 'src/auth.js': [{ start: 10, end: 20 }] });

    const result = await filterStaleExceptions({
      exceptions:     makeExceptions(),
      findings:       [finding],
      workspacePath:  WS,
      currentHeadSha: CURRENT_SHA,
    });

    expect(result.has('LAYNE-a3f29c81')).toBe(true);
  });

  it('removes an exception when the finding line falls within a changed range', async () => {
    getChangedLineRanges.mockResolvedValueOnce({ 'src/auth.js': [{ start: 40, end: 45 }] });

    const result = await filterStaleExceptions({
      exceptions:     makeExceptions(),
      findings:       [finding],
      workspacePath:  WS,
      currentHeadSha: CURRENT_SHA,
    });

    expect(result.has('LAYNE-a3f29c81')).toBe(false);
  });

  it('keeps an exception when the changed file is different from the finding file', async () => {
    getChangedLineRanges.mockResolvedValueOnce({ 'src/other.js': [{ start: 42, end: 42 }] });

    const result = await filterStaleExceptions({
      exceptions:     makeExceptions(),
      findings:       [finding],
      workspacePath:  WS,
      currentHeadSha: CURRENT_SHA,
    });

    expect(result.has('LAYNE-a3f29c81')).toBe(true);
  });

  it('invalidates the entire group when fetchCommit throws (conservative fallback)', async () => {
    fetchCommit.mockRejectedValueOnce(new Error('unknown revision'));

    const result = await filterStaleExceptions({
      exceptions:     makeExceptions(),
      findings:       [finding],
      workspacePath:  WS,
      currentHeadSha: CURRENT_SHA,
    });

    expect(result.has('LAYNE-a3f29c81')).toBe(false);
  });

  it('makes one fetchCommit call per unique approvedHeadSha', async () => {
    const findingB = { ...finding, _findingId: 'LAYNE-b7e41d22', file: 'src/utils.js', line: 10 };
    const exceptions = new Map([
      ['LAYNE-a3f29c81', { approver: 'alice', reason: 'ok', timestamp: '', approvedHeadSha: APPROVED_SHA }],
      ['LAYNE-b7e41d22', { approver: 'alice', reason: 'ok', timestamp: '', approvedHeadSha: APPROVED_SHA }],
    ]);

    await filterStaleExceptions({
      exceptions,
      findings:       [finding, findingB],
      workspacePath:  WS,
      currentHeadSha: CURRENT_SHA,
    });

    expect(fetchCommit).toHaveBeenCalledTimes(1);
  });

  it('uses startLine when line is absent', async () => {
    getChangedLineRanges.mockResolvedValueOnce({ 'src/auth.js': [{ start: 42, end: 42 }] });
    const findingWithStartLine = { ...finding, line: undefined, startLine: 42 };

    const result = await filterStaleExceptions({
      exceptions:     makeExceptions(),
      findings:       [findingWithStartLine],
      workspacePath:  WS,
      currentHeadSha: CURRENT_SHA,
    });

    expect(result.has('LAYNE-a3f29c81')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildExceptionSummary
// ---------------------------------------------------------------------------

describe('buildExceptionSummary()', () => {
  const highFinding = {
    _findingId: 'LAYNE-a3f29c81',
    tool:       'trufflehog',
    ruleId:     'aws-key',
    file:       'src/config.js',
    startLine:  42,
    severity:   'high',
  };
  const lowFinding = {
    _findingId: 'LAYNE-cccccccc',
    tool:       'semgrep',
    ruleId:     'style',
    file:       'src/a.js',
    startLine:  1,
    severity:   'low',
  };

  it('returns unchanged conclusion and summary when there are no blocking findings', () => {
    const result = buildExceptionSummary({
      findings:    [],
      exceptions:  new Map(),
      baseSummary: 'No issues found.',
    });
    expect(result).toEqual({ conclusion: 'success', summary: 'No issues found.' });
  });

  it('returns success when all blocking findings are excepted', () => {
    const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test cred', timestamp: '' }]]);
    const result = buildExceptionSummary({
      findings:    [highFinding],
      exceptions,
      baseSummary: 'Found 1 issue.',
    });
    expect(result.conclusion).toBe('success');
  });

  it('returns failure when only some blocking findings are excepted', () => {
    const secondHighFinding = { ...highFinding, _findingId: 'LAYNE-b7e41d22', ruleId: 'eval', file: 'src/api.js' };
    const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test', timestamp: '' }]]);
    const result = buildExceptionSummary({
      findings:    [highFinding, secondHighFinding],
      exceptions,
      baseSummary: 'Found 2 issues.',
    });
    expect(result.conclusion).toBe('failure');
  });

  it('returns failure when no blocking findings are excepted', () => {
    const result = buildExceptionSummary({
      findings:    [highFinding],
      exceptions:  new Map(),
      baseSummary: 'Found 1 issue.',
    });
    expect(result.conclusion).toBe('failure');
  });

  it('includes finding IDs in the summary', () => {
    const result = buildExceptionSummary({
      findings:    [highFinding],
      exceptions:  new Map(),
      baseSummary: 'Found 1 issue.',
    });
    expect(result.summary).toContain('LAYNE-a3f29c81');
  });

  it('includes usage hint for unexcepted blocking findings', () => {
    const result = buildExceptionSummary({
      findings:    [highFinding],
      exceptions:  new Map(),
      baseSummary: 'Found 1 issue.',
    });
    expect(result.summary).toContain('/layne exception-approve');
    expect(result.summary).toContain('reason:');
  });

  it('includes approver and reason in success summary when all excepted', () => {
    const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test credential', timestamp: '' }]]);
    const result = buildExceptionSummary({
      findings:    [highFinding],
      exceptions,
      baseSummary: 'Found 1 issue.',
    });
    expect(result.summary).toContain('@alice');
    expect(result.summary).toContain('test credential');
  });

  it('does not include non-blocking findings in the exception block', () => {
    const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'ok', timestamp: '' }]]);
    const result = buildExceptionSummary({
      findings:    [highFinding, lowFinding],
      exceptions,
      baseSummary: 'Found 2 issues.',
    });
    // The low finding ID should not appear in exception context
    expect(result.summary).not.toContain('LAYNE-cccccccc');
  });

  it('shows partial exception info (already excepted + remaining) when partially resolved', () => {
    const secondHighFinding = { ...highFinding, _findingId: 'LAYNE-b7e41d22', ruleId: 'eval', file: 'src/api.js' };
    const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test', timestamp: '' }]]);
    const result = buildExceptionSummary({
      findings:    [highFinding, secondHighFinding],
      exceptions,
      baseSummary: 'Found 2 issues.',
    });
    expect(result.summary).toContain('LAYNE-b7e41d22');
    expect(result.summary).toContain('@alice');
    expect(result.summary).toContain('/layne exception-approve');
  });
});

// ---------------------------------------------------------------------------
// resolveDriftedExceptions
// ---------------------------------------------------------------------------

describe('resolveDriftedExceptions()', () => {
  const APPROVED_SHA  = 'approved111';
  const CURRENT_SHA   = 'current222';
  const WORKSPACE     = '/tmp/ws';

  // A high finding whose current ID has no stored exception.
  const finding = {
    _findingId: 'LAYNE-a3f29c81',
    tool: 'semgrep', ruleId: 'eval',
    file: 'src/app.js', line: 47,
    severity: 'high',
  };

  // The exception that was stored when the code was at line 42 (before rebase).
  const storedId        = 'LAYNE-originalid';
  const storedException = { approver: 'alice', reason: 'ok', timestamp: '', approvedHeadSha: APPROVED_SHA };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no IDs in the set.
    redis.smembers.mockResolvedValue([]);
  });

  it('returns an empty Map when unmatchedFindings is empty', async () => {
    const result = await resolveDriftedExceptions({
      unmatchedFindings: [],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });
    expect(result).toEqual(new Map());
    expect(redis.smembers).not.toHaveBeenCalled();
  });

  it('returns an empty Map when the PR exception set is empty', async () => {
    redis.smembers.mockResolvedValue([]);
    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });
    expect(result).toEqual(new Map());
  });

  it('resolves a drifted finding when the line map maps currentLine back to an approved line', async () => {
    // The set contains the old finding ID.
    redis.smembers.mockResolvedValue([storedId]);
    redis.get.mockResolvedValue(JSON.stringify(storedException));

    // Line 47 in the current head maps back to line 42 at approval time (unchanged context line).
    buildLineMapForFile.mockResolvedValue(new Map([[47, 42]]));

    // generateFindingId({ tool, file, line: 42 }) must return storedId so the lookup hits.
    // We call the real generateFindingId, so we need to know what it produces for line 42.
    // Instead, we mock loadExceptions to return our storedException under storedId.
    // The real generateFindingId will hash "semgrep:src/app.js:42" — we just need storedId
    // to equal that. Since we can't control the hash, we use the real generateFindingId output.
    const { generateFindingId: realGenerate } = await import('../exception-approvals.js');
    const expectedOldId = realGenerate({ tool: 'semgrep', file: 'src/app.js', line: 42 });

    redis.smembers.mockResolvedValue([expectedOldId]);
    redis.get.mockResolvedValue(JSON.stringify(storedException));
    buildLineMapForFile.mockResolvedValue(new Map([[47, 42]]));

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId)).toBe(true);
    expect(result.get(finding._findingId)).toMatchObject({ approver: 'alice', reason: 'ok' });
  });

  it('does not resolve when the line map returns null (line was modified, not just shifted)', async () => {
    const { generateFindingId: realGenerate } = await import('../exception-approvals.js');
    const oldId = realGenerate({ tool: 'semgrep', file: 'src/app.js', line: 42 });

    redis.smembers.mockResolvedValue([oldId]);
    redis.get.mockResolvedValue(JSON.stringify(storedException));
    // null means the line is new (added/modified) — no base equivalent.
    buildLineMapForFile.mockResolvedValue(new Map([[47, null]]));

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId)).toBe(false);
  });

  it('does not resolve when the current line is absent from the line map', async () => {
    const { generateFindingId: realGenerate } = await import('../exception-approvals.js');
    const oldId = realGenerate({ tool: 'semgrep', file: 'src/app.js', line: 42 });

    redis.smembers.mockResolvedValue([oldId]);
    redis.get.mockResolvedValue(JSON.stringify(storedException));
    buildLineMapForFile.mockResolvedValue(new Map()); // line 47 not present

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId)).toBe(false);
  });

  it('skips the approval SHA when fetchCommit throws (graceful degradation)', async () => {
    const { generateFindingId: realGenerate } = await import('../exception-approvals.js');
    const oldId = realGenerate({ tool: 'semgrep', file: 'src/app.js', line: 42 });

    redis.smembers.mockResolvedValue([oldId]);
    redis.get.mockResolvedValue(JSON.stringify(storedException));
    fetchCommit.mockRejectedValueOnce(new Error('unknown revision'));

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId)).toBe(false);
    expect(buildLineMapForFile).not.toHaveBeenCalled();
  });

  it('skips the file when buildLineMapForFile throws (graceful degradation)', async () => {
    const { generateFindingId: realGenerate } = await import('../exception-approvals.js');
    const oldId = realGenerate({ tool: 'semgrep', file: 'src/app.js', line: 42 });

    redis.smembers.mockResolvedValue([oldId]);
    redis.get.mockResolvedValue(JSON.stringify(storedException));
    buildLineMapForFile.mockRejectedValueOnce(new Error('diff failed'));

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId)).toBe(false);
  });

  it('skips exceptions at the current SHA (no drift possible at same commit)', async () => {
    const { generateFindingId: realGenerate } = await import('../exception-approvals.js');
    const oldId = realGenerate({ tool: 'semgrep', file: 'src/app.js', line: 42 });
    const sameShException = { ...storedException, approvedHeadSha: CURRENT_SHA };

    redis.smembers.mockResolvedValue([oldId]);
    redis.get.mockResolvedValue(JSON.stringify(sameShException));

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId)).toBe(false);
    expect(fetchCommit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isReviewerAuthorized
// ---------------------------------------------------------------------------

describe('isReviewerAuthorized()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when reviewer is in the users list', async () => {
    const result = await isReviewerAuthorized({
      reviewer:       'alice',
      config:         { users: ['alice', 'bob'], teams: [] },
      installationId: 1,
      owner:          'org',
    });
    expect(result).toBe(true);
    expect(getTeamMembers).not.toHaveBeenCalled();
  });

  it('returns false when reviewer is not in users and there are no teams', async () => {
    const result = await isReviewerAuthorized({
      reviewer:       'mallory',
      config:         { users: ['alice'], teams: [] },
      installationId: 1,
      owner:          'org',
    });
    expect(result).toBe(false);
  });

  it('returns true when reviewer is a member of a configured team', async () => {
    getTeamMembers.mockResolvedValue(['carol', 'dave']);

    const result = await isReviewerAuthorized({
      reviewer:       'carol',
      config:         { users: [], teams: ['org/security'] },
      installationId: 1,
      owner:          'org',
    });
    expect(result).toBe(true);
  });

  it('returns false when reviewer is not a member of any configured team', async () => {
    getTeamMembers.mockResolvedValue(['carol', 'dave']);

    const result = await isReviewerAuthorized({
      reviewer:       'mallory',
      config:         { users: [], teams: ['org/security'] },
      installationId: 1,
      owner:          'org',
    });
    expect(result).toBe(false);
  });

  it('returns false and does not throw when team lookup rejects', async () => {
    getTeamMembers.mockRejectedValue(new Error('GitHub API error'));

    const result = await isReviewerAuthorized({
      reviewer:       'carol',
      config:         { users: [], teams: ['org/security'] },
      installationId: 1,
      owner:          'org',
    });
    expect(result).toBe(false);
  });
});
