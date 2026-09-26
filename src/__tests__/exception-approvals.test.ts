import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessedFinding, ExceptionData } from '../types.js';

type FindingIdInput = Pick<ProcessedFinding, 'tool' | 'file' | 'line' | 'startLine'> & Partial<Pick<ProcessedFinding, 'ruleId' | 'evidence'>>;

vi.mock('../github.js', () => ({
  getTeamMembers: vi.fn(),
}));

vi.mock('../queue.js', () => ({
  redis: {
    multi:    vi.fn(() => {
      const transaction = {
        set:    vi.fn(),
        sadd:   vi.fn(),
        expire: vi.fn(),
        exec:   vi.fn().mockResolvedValue([]),
      };
      transaction.set.mockReturnValue(transaction);
      transaction.sadd.mockReturnValue(transaction);
      transaction.expire.mockReturnValue(transaction);
      return transaction;
    }),
    set:      vi.fn().mockResolvedValue('OK'),
    get:      vi.fn().mockResolvedValue(null),
    eval:     vi.fn(),
    sadd:     vi.fn().mockResolvedValue(1),
    expire:   vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../fetcher.js', () => ({
  fetchCommit:          vi.fn().mockResolvedValue(undefined),
  getChangedLineRanges: vi.fn().mockResolvedValue(new Map()),
  buildLineMapForFile:  vi.fn().mockResolvedValue(new Map()),
}));

const { getTeamMembers }                    = await import('../github.js');
const { redis }                             = await import('../queue.js');
const { fetchCommit, getChangedLineRanges, buildLineMapForFile } = await import('../fetcher.js');
const {
  generateFindingId,
  generateLegacyFindingId,
  parseExceptionCommand,
  storeBulkExceptionRequest,
  loadBulkExceptionRequest,
  materializeBulkExceptionRequest,
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
  it('returns a versioned 16-character fingerprint', () => {
    const id = generateFindingId({ tool: 'semgrep', file: 'src/a.js', line: 10 });
    expect(id).toMatch(/^LAYNE-v2-[0-9a-f]{16}$/);
  });

  it('is deterministic — same input always returns the same ID', () => {
    const f: FindingIdInput = { tool: 'trufflehog', file: 'config.js', line: 42 };
    expect(generateFindingId(f)).toBe(generateFindingId(f));
  });

  it('returns different IDs for different files', () => {
    const a = generateFindingId({ tool: 'semgrep', file: 'a.js', line: 1 });
    const b = generateFindingId({ tool: 'semgrep', file: 'b.js', line: 1 });
    expect(a).not.toBe(b);
  });

  it('returns different IDs for different tools on the same file and line', () => {
    const a = generateFindingId({ tool: 'semgrep',    file: 'a.js', line: 1 });
    const b = generateFindingId({ tool: 'trufflehog', file: 'a.js', line: 1 });
    expect(a).not.toBe(b);
  });

  it('returns different IDs for different rules at the same location', () => {
    const a = generateFindingId({ tool: 'claude', ruleId: 'backdoor', file: 'a.js', line: 1 });
    const b = generateFindingId({ tool: 'claude', ruleId: 'exfiltration', file: 'a.js', line: 1 });
    expect(a).not.toBe(b);
  });

  it('returns different IDs when the exact evidence changes', () => {
    const a = generateFindingId({ tool: 'claude', ruleId: 'backdoor', evidence: 'eval(payload)', file: 'a.js', line: 1 });
    const b = generateFindingId({ tool: 'claude', ruleId: 'backdoor', evidence: 'eval(other)', file: 'a.js', line: 1 });
    expect(a).not.toBe(b);
  });

  it('uses startLine when line is absent', () => {
    const withLine      = generateFindingId({ tool: 'semgrep', file: 'f.js', line: 5 });
    const withStartLine = generateFindingId({ tool: 'semgrep', file: 'f.js', startLine: 5 } as FindingIdInput);
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
    expect(result).toEqual({ target: 'ids', ids: ['LAYNE-a3f29c81b7e41d22'], reason: 'test credential' });
  });

  it('parses a versioned finding ID', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-v2-a3f29c81b7e41d22 reason: reviewed');
    expect(result).toEqual({ target: 'ids', ids: ['LAYNE-v2-a3f29c81b7e41d22'], reason: 'reviewed' });
  });

  it('parses a valid multi-ID command', () => {
    const result = parseExceptionCommand('/layne exception-approve LAYNE-a3f29c81b7e41d22 LAYNE-b7e41d22a3f29c81 reason: legacy code');
    expect(result).toEqual({ target: 'ids', ids: ['LAYNE-a3f29c81b7e41d22', 'LAYNE-b7e41d22a3f29c81'], reason: 'legacy code' });
  });

  it('finds the command when embedded mid-comment', () => {
    const body = `Great PR overall!\n\n/layne exception-approve LAYNE-a3f29c81b7e41d22 reason: test only\n\nShip it!`;
    const result = parseExceptionCommand(body);
    expect(result).toEqual({ target: 'ids', ids: ['LAYNE-a3f29c81b7e41d22'], reason: 'test only' });
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

  it('parses the all target with a required reason', () => {
    expect(parseExceptionCommand('/layne exception-approve all reason: accepted risk')).toEqual({
      target: 'all', ids: [], reason: 'accepted risk',
    });
  });

  it('rejects mixing all with finding IDs', () => {
    expect(parseExceptionCommand('/layne exception-approve all LAYNE-v2-a3f29c81b7e41d22 reason: accepted')).toMatchObject({
      target: 'all', error: expect.any(String),
    });
  });

  it('does not treat IDs or all inside the reason as approval targets', () => {
    expect(parseExceptionCommand('/layne exception-approve LAYNE-v2-a3f29c81b7e41d22 reason: covers all not LAYNE-v2-b7e41d22a3f29c81')).toEqual({
      target: 'ids', ids: ['LAYNE-v2-a3f29c81b7e41d22'], reason: 'covers all not LAYNE-v2-b7e41d22a3f29c81',
    });
  });

  it('deduplicates repeated finding IDs', () => {
    expect(parseExceptionCommand('/layne exception-approve LAYNE-v2-a3f29c81b7e41d22 LAYNE-v2-a3f29c81b7e41d22 reason: accepted')).toMatchObject({
      target: 'ids', ids: ['LAYNE-v2-a3f29c81b7e41d22'], reason: 'accepted',
    });
  });
});

// ---------------------------------------------------------------------------
// storeExceptions
// ---------------------------------------------------------------------------

describe('storeExceptions()', () => {
  beforeEach(() => vi.clearAllMocks());

  function transaction(): {
    set: ReturnType<typeof vi.fn>;
    sadd: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  } {
    return (redis.multi as ReturnType<typeof vi.fn>).mock.results[0].value;
  }

  it('queues the correct key format without the head SHA', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, approvedHeadSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'], approver: 'alice', reason: 'test cred',
    });

    expect(transaction().set).toHaveBeenCalledWith(
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

    const [, , , ttl] = transaction().set.mock.calls[0] as [string, string, string, number];
    expect(ttl).toBe(30 * 24 * 60 * 60);
  });

  it('stores approver, reason, timestamp, and approvedHeadSha in the JSON value', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, approvedHeadSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'], approver: 'alice', reason: 'test cred',
    });

    const [, value] = transaction().set.mock.calls[0] as [string, string];
    const parsed = JSON.parse(value);
    expect(parsed).toMatchObject({
      approver:        'alice',
      reason:          'test cred',
      timestamp:       expect.any(String),
      approvedHeadSha: 'abc123',
    });
  });

  it('queues one key per finding ID in one transaction', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, approvedHeadSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81', 'LAYNE-b7e41d22'], approver: 'alice', reason: 'ok',
    });

    expect(transaction().set).toHaveBeenCalledTimes(2);
    const keys = transaction().set.mock.calls.map((c: unknown[]) => c[0]);
    expect(keys).toContain('layne:exception:org/repo#42:LAYNE-a3f29c81');
    expect(keys).toContain('layne:exception:org/repo#42:LAYNE-b7e41d22');
  });

  it('adds all finding IDs to the PR-scoped set and refreshes its TTL', async () => {
    await storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, approvedHeadSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81', 'LAYNE-b7e41d22'], approver: 'alice', reason: 'ok',
    });

    expect(transaction().sadd).toHaveBeenCalledWith(
      'layne:exception-ids:org/repo#42',
      'LAYNE-a3f29c81',
      'LAYNE-b7e41d22',
    );
    expect(transaction().expire).toHaveBeenCalledWith('layne:exception-ids:org/repo#42', 30 * 24 * 60 * 60);
    expect(transaction().exec).toHaveBeenCalledOnce();
  });

  it('reports an aborted transaction as a storage failure', async () => {
    const abortedTransaction = {
      set: vi.fn(), sadd: vi.fn(), expire: vi.fn(), exec: vi.fn().mockResolvedValue(null),
    };
    abortedTransaction.set.mockReturnValue(abortedTransaction);
    abortedTransaction.sadd.mockReturnValue(abortedTransaction);
    abortedTransaction.expire.mockReturnValue(abortedTransaction);
    (redis.multi as ReturnType<typeof vi.fn>).mockReturnValueOnce(abortedTransaction);

    await expect(storeExceptions({
      owner: 'org', repo: 'repo', prNumber: 42, approvedHeadSha: 'abc123',
      findingIds: ['LAYNE-a3f29c81'], approver: 'alice', reason: 'ok',
    })).rejects.toThrow('transaction was aborted');
  });
});

describe('bulk exception requests', () => {
  beforeEach(() => vi.clearAllMocks());

  const request = {
    owner: 'org', repo: 'repo', prNumber: 42, approvedHeadSha: 'abc123',
    requestId: '9001', approver: 'alice', reason: 'accepted risk',
  };

  it('stores a pending request scoped to the exact head and comment', async () => {
    (redis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce('OK');

    await expect(storeBulkExceptionRequest(request)).resolves.toBe('stored');
    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      'layne:exception-all-comment:org/repo#42:9001',
      'abc123', 'EX', 30 * 24 * 60 * 60, 'NX',
    );
    expect(redis.set).toHaveBeenNthCalledWith(
      2,
      'layne:exception-all-request:org/repo#42@abc123:9001',
      expect.any(String), 'EX', 30 * 24 * 60 * 60, 'NX',
    );
    const stored = JSON.parse((redis.set as ReturnType<typeof vi.fn>).mock.calls[1][1] as string);
    expect(stored).toMatchObject({ state: 'pending', findingIds: [], approver: 'alice', reason: 'accepted risk' });
  });

  it('reports an existing request without replacing it', async () => {
    (redis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce('abc123');
    await expect(storeBulkExceptionRequest(request)).resolves.toBe('exists');
  });

  it('does not rebind the same comment to another head', async () => {
    (redis.set as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce('older-head');

    await expect(storeBulkExceptionRequest(request)).resolves.toBe('head-mismatch');
    expect(redis.set).toHaveBeenCalledOnce();
  });

  it('loads a stored request by its head-scoped key', async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(JSON.stringify({
      ...request, state: 'pending', findingIds: [], timestamp: '2026-01-01T00:00:00.000Z',
    }));

    await expect(loadBulkExceptionRequest(request)).resolves.toMatchObject({ state: 'pending', requestId: '9001' });
    expect(redis.get).toHaveBeenCalledWith('layne:exception-all-request:org/repo#42@abc123:9001');
  });

  it('materializes an exact finding list atomically', async () => {
    const materialized = {
      ...request, state: 'materialized', findingIds: ['LAYNE-v2-a3f29c81b7e41d22'], timestamp: '2026-01-01T00:00:00.000Z',
    };
    (redis.eval as ReturnType<typeof vi.fn>).mockResolvedValueOnce(JSON.stringify(materialized));

    await expect(materializeBulkExceptionRequest({
      ...request,
      findingIds: ['LAYNE-v2-a3f29c81b7e41d22'],
      expectedExceptions: new Map(),
    })).resolves.toEqual(materialized);

    const args = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(args).toContain('layne:exception-all-request:org/repo#42@abc123:9001');
    expect(args).toContain('layne:exception:org/repo#42:');
    expect(args).toContain(JSON.stringify(['LAYNE-v2-a3f29c81b7e41d22']));
  });
});

// ---------------------------------------------------------------------------
// loadExceptions
// ---------------------------------------------------------------------------

describe('loadExceptions()', () => {
  beforeEach(() => vi.clearAllMocks());

  const stored = JSON.stringify({ approver: 'alice', reason: 'test', timestamp: '2026-01-01T00:00:00.000Z', approvedHeadSha: 'abc123' });

  it('returns a Map with parsed values for found keys', async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(stored);

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
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(stored).mockResolvedValueOnce(null);

    const result = await loadExceptions({
      owner: 'org', repo: 'repo', prNumber: 42,
      findingIds: ['LAYNE-a3f29c81', 'LAYNE-b7e41d22'],
    });

    expect(result.size).toBe(1);
    expect(result.has('LAYNE-a3f29c81')).toBe(true);
    expect(result.has('LAYNE-b7e41d22')).toBe(false);
  });

  it('returns an empty Map when all keys are missing', async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await loadExceptions({
      owner: 'org', repo: 'repo', prNumber: 42,
      findingIds: ['LAYNE-a3f29c81'],
    });

    expect(result.size).toBe(0);
  });

  it('queries the correct Redis key for each finding ID (no headSha in key)', async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

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

  const finding: ProcessedFinding = {
    _findingId: 'LAYNE-a3f29c81',
    tool:       'semgrep',
    file:       'src/auth.js',
    line:       42,
    severity:   'high',
    ruleId:     'sql-injection',
    message:    '',
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
    (getChangedLineRanges as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map([['src/auth.js', [{ start: 10, end: 20 }]]]));

    const result = await filterStaleExceptions({
      exceptions:     makeExceptions(),
      findings:       [finding],
      workspacePath:  WS,
      currentHeadSha: CURRENT_SHA,
    });

    expect(result.has('LAYNE-a3f29c81')).toBe(true);
  });

  it('removes an exception when the finding line falls within a changed range', async () => {
    (getChangedLineRanges as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map([['src/auth.js', [{ start: 40, end: 45 }]]]));

    const result = await filterStaleExceptions({
      exceptions:     makeExceptions(),
      findings:       [finding],
      workspacePath:  WS,
      currentHeadSha: CURRENT_SHA,
    });

    expect(result.has('LAYNE-a3f29c81')).toBe(false);
  });

  it('keeps an exception when the changed file is different from the finding file', async () => {
    (getChangedLineRanges as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map([['src/other.js', [{ start: 42, end: 42 }]]]));

    const result = await filterStaleExceptions({
      exceptions:     makeExceptions(),
      findings:       [finding],
      workspacePath:  WS,
      currentHeadSha: CURRENT_SHA,
    });

    expect(result.has('LAYNE-a3f29c81')).toBe(true);
  });

  it('invalidates the entire group when fetchCommit throws (conservative fallback)', async () => {
    (fetchCommit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('unknown revision'));

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
    (getChangedLineRanges as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map([['src/auth.js', [{ start: 42, end: 42 }]]]));
    const findingWithStartLine = { ...finding, line: undefined as unknown as number, startLine: 42 };

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
  const highFinding: ProcessedFinding = {
    _findingId: 'LAYNE-a3f29c81',
    tool:       'trufflehog',
    ruleId:     'aws-key',
    file:       'src/config.js',
    line:       42,
    startLine:  42,
    severity:   'high',
    message:    '',
  };
  const lowFinding: ProcessedFinding = {
    _findingId: 'LAYNE-cccccccc',
    tool:       'semgrep',
    ruleId:     'style',
    file:       'src/a.js',
    line:       1,
    startLine:  1,
    severity:   'low',
    message:    '',
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
    const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test cred', timestamp: '', approvedHeadSha: '' }]]) as Map<string, ExceptionData>;
    const result = buildExceptionSummary({
      findings:    [highFinding],
      exceptions,
      baseSummary: 'Found 1 issue.',
    });
    expect(result.conclusion).toBe('success');
  });

  it('returns failure when only some blocking findings are excepted', () => {
    const secondHighFinding = { ...highFinding, _findingId: 'LAYNE-b7e41d22', ruleId: 'eval', file: 'src/api.js' };
    const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test', timestamp: '', approvedHeadSha: '' }]]) as Map<string, ExceptionData>;
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
    const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test credential', timestamp: '', approvedHeadSha: '' }]]) as Map<string, ExceptionData>;
    const result = buildExceptionSummary({
      findings:    [highFinding],
      exceptions,
      baseSummary: 'Found 1 issue.',
    });
    expect(result.summary).toContain('@alice');
    expect(result.summary).toContain('test credential');
    expect(result.summary).toContain('All blocking findings were excepted');
    expect(result.summary).not.toContain('Scan passed');
  });

  it('does not include non-blocking findings in the exception block', () => {
    const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'ok', timestamp: '', approvedHeadSha: '' }]]) as Map<string, ExceptionData>;
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
    const exceptions = new Map([['LAYNE-a3f29c81', { approver: 'alice', reason: 'test', timestamp: '', approvedHeadSha: '' }]]) as Map<string, ExceptionData>;
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
  const finding: ProcessedFinding = {
    _findingId: 'LAYNE-a3f29c81',
    tool: 'semgrep', ruleId: 'eval',
    file: 'src/app.js', line: 47,
    severity: 'high',
    message: '',
  };

  // The exception that was stored when the code was at line 42 (before rebase).
  const storedException = { approver: 'alice', reason: 'ok', timestamp: '', approvedHeadSha: APPROVED_SHA };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no IDs in the set.
    (redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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
    (redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });
    expect(result).toEqual(new Map());
  });

  it('resolves a drifted finding when the line map maps currentLine back to an approved line', async () => {
    // Line 47 in the current head maps back to line 42 at approval time (unchanged context line).
    const { generateFindingId: realGenerate } = await import('../exception-approvals.js');
    const expectedOldId = realGenerate({ tool: 'semgrep', ruleId: 'eval', file: 'src/app.js', line: 42 });

    (redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([expectedOldId]);
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(storedException));
    (buildLineMapForFile as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([[47, 42]]));

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId!)).toBe(true);
    expect(result.get(finding._findingId!)).toMatchObject({ approver: 'alice', reason: 'ok' });
  });

  it('does not resolve when the line map returns null (line was modified, not just shifted)', async () => {
    const { generateFindingId: realGenerate } = await import('../exception-approvals.js');
    const oldId = realGenerate({ tool: 'semgrep', ruleId: 'eval', file: 'src/app.js', line: 42 });

    (redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([oldId]);
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(storedException));
    // null means the line is new (added/modified) — no base equivalent.
    (buildLineMapForFile as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([[47, null]]));

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId!)).toBe(false);
  });

  it('does not resolve when the current line is absent from the line map', async () => {
    const { generateFindingId: realGenerate } = await import('../exception-approvals.js');
    const oldId = realGenerate({ tool: 'semgrep', ruleId: 'eval', file: 'src/app.js', line: 42 });

    (redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([oldId]);
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(storedException));
    (buildLineMapForFile as ReturnType<typeof vi.fn>).mockResolvedValue(new Map()); // line 47 not present

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId!)).toBe(false);
  });

  it('skips the approval SHA when fetchCommit throws (graceful degradation)', async () => {
    const { generateFindingId: realGenerate } = await import('../exception-approvals.js');
    const oldId = realGenerate({ tool: 'semgrep', ruleId: 'eval', file: 'src/app.js', line: 42 });

    (redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([oldId]);
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(storedException));
    (fetchCommit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('unknown revision'));

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId!)).toBe(false);
    expect(buildLineMapForFile).not.toHaveBeenCalled();
  });

  it('skips the file when buildLineMapForFile throws (graceful degradation)', async () => {
    const { generateFindingId: realGenerate } = await import('../exception-approvals.js');
    const oldId = realGenerate({ tool: 'semgrep', ruleId: 'eval', file: 'src/app.js', line: 42 });

    (redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([oldId]);
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(storedException));
    (buildLineMapForFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('diff failed'));

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId!)).toBe(false);
  });

  it('migrates a legacy ID at the current SHA without a Git drift lookup', async () => {
    const oldId = generateLegacyFindingId({ tool: 'semgrep', file: 'src/app.js', line: 47 });
    const sameShException = { ...storedException, approvedHeadSha: CURRENT_SHA };

    (redis.smembers as ReturnType<typeof vi.fn>).mockResolvedValue([oldId]);
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify(sameShException));

    const result = await resolveDriftedExceptions({
      unmatchedFindings: [finding],
      owner: 'org', repo: 'repo', prNumber: 42,
      workspacePath: WORKSPACE, currentHeadSha: CURRENT_SHA,
    });

    expect(result.has(finding._findingId!)).toBe(true);
    expect(fetchCommit).not.toHaveBeenCalled();
    expect(buildLineMapForFile).not.toHaveBeenCalled();
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
    (getTeamMembers as ReturnType<typeof vi.fn>).mockResolvedValue(['carol', 'dave']);

    const result = await isReviewerAuthorized({
      reviewer:       'carol',
      config:         { users: [], teams: ['org/security'] },
      installationId: 1,
      owner:          'org',
    });
    expect(result).toBe(true);
  });

  it('returns false when reviewer is not a member of any configured team', async () => {
    (getTeamMembers as ReturnType<typeof vi.fn>).mockResolvedValue(['carol', 'dave']);

    const result = await isReviewerAuthorized({
      reviewer:       'mallory',
      config:         { users: [], teams: ['org/security'] },
      installationId: 1,
      owner:          'org',
    });
    expect(result).toBe(false);
  });

  it('returns false and does not throw when team lookup rejects', async () => {
    (getTeamMembers as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('GitHub API error'));

    const result = await isReviewerAuthorized({
      reviewer:       'carol',
      config:         { users: [], teams: ['org/security'] },
      installationId: 1,
      owner:          'org',
    });
    expect(result).toBe(false);
  });
});
