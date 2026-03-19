import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../github.js', () => ({
  getTeamMembers: vi.fn(),
}));

vi.mock('../queue.js', () => ({
  redis: {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
  },
}));

const { getTeamMembers } = await import('../github.js');
const { redis }          = await import('../queue.js');
const {
  generateFindingId,
  parseExceptionCommand,
  storeExceptions,
  loadExceptions,
  buildExceptionSummary,
  isReviewerAuthorized,
} = await import('../exception-approvals.js');

// ---------------------------------------------------------------------------
// generateFindingId
// ---------------------------------------------------------------------------

describe('generateFindingId()', () => {
  it('returns a string matching LAYNE-[0-9a-f]{8}', () => {
    const id = generateFindingId({ tool: 'semgrep', ruleId: 'eval', file: 'src/a.js', line: 10 });
    expect(id).toMatch(/^LAYNE-[0-9a-f]{8}$/);
  });

  it('is deterministic — same input always returns the same ID', () => {
    const f = { tool: 'trufflehog', ruleId: 'aws-key', file: 'config.js', line: 42 };
    expect(generateFindingId(f)).toBe(generateFindingId(f));
  });

  it('returns different IDs for different inputs', () => {
    const a = generateFindingId({ tool: 'semgrep', ruleId: 'eval',    file: 'a.js', line: 1 });
    const b = generateFindingId({ tool: 'semgrep', ruleId: 'sql-inj', file: 'a.js', line: 1 });
    expect(a).not.toBe(b);
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

  it('returns error when reason: token is missing', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81 LAYNE-b7e41d22');
    expect(result).toMatchObject({ ids: ['LAYNE-a3f29c81', 'LAYNE-b7e41d22'], reason: null, error: expect.any(String) });
  });

  it('returns error when reason: is present but has no text after it', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81 reason:');
    expect(result).toMatchObject({ ids: ['LAYNE-a3f29c81'], reason: null, error: expect.any(String) });
  });

  it('parses a valid single-ID command', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81 reason: test credential');
    expect(result).toEqual({ ids: ['LAYNE-a3f29c81'], reason: 'test credential' });
  });

  it('parses a valid multi-ID command', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81 LAYNE-b7e41d22 reason: legacy code');
    expect(result).toEqual({ ids: ['LAYNE-a3f29c81', 'LAYNE-b7e41d22'], reason: 'legacy code' });
  });

  it('finds the command when embedded mid-comment', () => {
    const body = `Great PR overall!\n\n/layne exception-approve LAYNE-a3f29c81 reason: test only\n\nShip it!`;
    const result = parseExceptionCommand(body);
    expect(result).toEqual({ ids: ['LAYNE-a3f29c81'], reason: 'test only' });
  });

  it('preserves multi-word reason text', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81 reason: test credential, will be rotated before release');
    expect(result?.reason).toBe('test credential, will be rotated before release');
  });

  it('handles extra whitespace between tokens', () => {
    const result = parseExceptionCommand('/layne exception-approve  LAYNE-a3f29c81  reason:  ok');
    expect(result?.ids).toEqual(['LAYNE-a3f29c81']);
    expect(result?.reason).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// storeExceptions
// ---------------------------------------------------------------------------

describe('storeExceptions()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls redis.set with the correct key format', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, headSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'], approver: 'alice', reason: 'test cred',
    });

    expect(redis.set).toHaveBeenCalledWith(
      'layne:exception:org/repo#42@abc123:LAYNE-a3f29c81',
      expect.any(String),
      'EX',
      expect.any(Number)
    );
  });

  it('stores a 30-day TTL', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, headSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'], approver: 'alice', reason: 'ok',
    });

    const [, , , ttl] = redis.set.mock.calls[0];
    expect(ttl).toBe(30 * 24 * 60 * 60);
  });

  it('stores approver, reason, and timestamp in the JSON value', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, headSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'], approver: 'alice', reason: 'test cred',
    });

    const [, value] = redis.set.mock.calls[0];
    const parsed = JSON.parse(value);
    expect(parsed).toMatchObject({ approver: 'alice', reason: 'test cred', timestamp: expect.any(String) });
  });

  it('writes one key per finding ID in parallel', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, headSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81', 'LAYNE-b7e41d22'], approver: 'alice', reason: 'ok',
    });

    expect(redis.set).toHaveBeenCalledTimes(2);
    const keys = redis.set.mock.calls.map(c => c[0]);
    expect(keys).toContain('layne:exception:org/repo#42@abc123:LAYNE-a3f29c81');
    expect(keys).toContain('layne:exception:org/repo#42@abc123:LAYNE-b7e41d22');
  });
});

// ---------------------------------------------------------------------------
// loadExceptions
// ---------------------------------------------------------------------------

describe('loadExceptions()', () => {
  beforeEach(() => vi.clearAllMocks());

  const stored = JSON.stringify({ approver: 'alice', reason: 'test', timestamp: '2026-01-01T00:00:00.000Z' });

  it('returns a Map with parsed values for found keys', async () => {
    redis.get.mockResolvedValue(stored);

    const result = await loadExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, headSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'],
    });

    expect(result).toBeInstanceOf(Map);
    expect(result.get('LAYNE-a3f29c81')).toEqual({ approver: 'alice', reason: 'test', timestamp: '2026-01-01T00:00:00.000Z' });
  });

  it('excludes missing keys from the result Map', async () => {
    redis.get.mockResolvedValueOnce(stored).mockResolvedValueOnce(null);

    const result = await loadExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, headSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81', 'LAYNE-b7e41d22'],
    });

    expect(result.size).toBe(1);
    expect(result.has('LAYNE-a3f29c81')).toBe(true);
    expect(result.has('LAYNE-b7e41d22')).toBe(false);
  });

  it('returns an empty Map when all keys are missing', async () => {
    redis.get.mockResolvedValue(null);

    const result = await loadExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, headSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'],
    });

    expect(result.size).toBe(0);
  });

  it('queries the correct Redis key for each finding ID', async () => {
    redis.get.mockResolvedValue(null);

    await loadExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, headSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'],
    });

    expect(redis.get).toHaveBeenCalledWith('layne:exception:org/repo#42@abc123:LAYNE-a3f29c81');
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
