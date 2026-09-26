import crypto from 'crypto';
import { getTeamMembers } from './github.js';
import { redis } from './queue.js';
import { fetchCommit, getChangedLineRanges, buildLineMapForFile } from './fetcher.js';
import type { ProcessedFinding, ExceptionData, BulkExceptionRequest, ParsedCommand, ExceptionApproversConfig, LineRangesByFile } from './types.js';

const EXCEPTION_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

const MATERIALIZE_ALL_SCRIPT = `
local raw = redis.call('get', KEYS[1])
if not raw then return redis.error_reply('Bulk exception request not found') end

local request = cjson.decode(raw)
if request.approvedHeadSha ~= ARGV[1] then
  return redis.error_reply('Bulk exception request head does not match scan head')
end
local ttl = tonumber(ARGV[2])
if request.state ~= 'materialized' then
  request.state = 'materialized'
  request.findingIds = cjson.decode(ARGV[3])
  request.expectedExceptions = cjson.decode(ARGV[4])
end

local findingIds = request.findingIds
local expected = request.expectedExceptions or {}
local setType = redis.call('type', KEYS[2]).ok
if setType ~= 'none' and setType ~= 'set' then
  return redis.error_reply('Exception ID index has an invalid Redis type')
end
for index, _ in ipairs(findingIds) do
  local keyType = redis.call('type', ARGV[5] .. findingIds[index]).ok
  if keyType ~= 'none' and keyType ~= 'string' then
    return redis.error_reply('Exception record has an invalid Redis type')
  end
end

local materialized = cjson.encode(request)
redis.call('set', KEYS[1], materialized, 'EX', ttl)
local exceptionValue = cjson.encode({
  approver = request.approver,
  reason = request.reason,
  timestamp = request.timestamp,
  approvedHeadSha = request.approvedHeadSha
})

for index, findingId in ipairs(findingIds) do
  local key = ARGV[5] .. findingId
  local current = redis.call('get', key)
  local expectedValue = expected[findingId]
  if (not current) or (expectedValue and current == expectedValue) then
    redis.call('set', key, exceptionValue, 'EX', ttl)
  end
  redis.call('sadd', KEYS[2], findingId)
end

if #findingIds > 0 then
  redis.call('expire', KEYS[2], ttl)
end

return materialized
`;

type FindingIdentity = Pick<ProcessedFinding, 'tool' | 'file' | 'line' | 'startLine'>
  & Partial<Pick<ProcessedFinding, 'ruleId' | 'evidence'>>;

export function generateFindingId(finding: FindingIdentity): string {
  const evidenceDigest = crypto.createHash('sha256').update((finding.evidence ?? '').replace(/\r\n/g, '\n')).digest('hex');
  const input = `v2:${finding.tool}:${finding.ruleId ?? ''}:${finding.file}:${finding.line ?? finding.startLine}:${evidenceDigest}`;
  return 'LAYNE-v2-' + crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function generateLegacyFindingId(finding: Pick<ProcessedFinding, 'tool' | 'file' | 'line' | 'startLine'>): string {
  const input = `${finding.tool}:${finding.file}:${finding.line ?? finding.startLine}`;
  return 'LAYNE-' + crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// Returns a parsed ID/all target, an invalid command, or null when absent.
export function parseExceptionCommand(body: string | null | undefined): ParsedCommand | null {
  if (!body) return null;

  const lines = body.split('\n');
  const commandLine = lines.find(line => line.includes('/layne exception-approve'));
  if (!commandLine) return null;

  const commandIndex = commandLine.indexOf('/layne exception-approve');
  const afterCommand = commandLine.slice(commandIndex + '/layne exception-approve'.length).trim();

  const tokens = afterCommand.split(/\s+/).filter(Boolean);
  const reasonIndex = tokens.findIndex(t => t === 'reason:');
  const targetTokens = reasonIndex === -1 ? tokens : tokens.slice(0, reasonIndex);
  const validId = (token: string) => /^LAYNE-(?:v2-)?[0-9a-f]{16}$/.test(token);
  const ids = [...new Set(targetTokens.filter(validId))];
  const hasAll = targetTokens.includes('all');
  const target: ParsedCommand['target'] = hasAll ? 'all' : 'ids';

  if (hasAll && (ids.length > 0 || targetTokens.length !== 1)) {
    return { target, ids: [], reason: null, error: 'The all target cannot be combined with finding IDs or other targets.' };
  }
  if (!hasAll && (ids.length === 0 || !targetTokens.every(validId))) {
    return { target, ids: [], reason: null, error: 'No valid finding IDs found. Use "all" or IDs matching LAYNE-v2-xxxxxxxxxxxxxxxx.' };
  }
  if (reasonIndex === -1) {
    return { target, ids, reason: null, error: 'Missing reason: please add "reason: <explanation>" after the approval target.' };
  }

  const reason = tokens.slice(reasonIndex + 1).join(' ').trim();
  if (!reason) {
    return { target, ids, reason: null, error: 'Missing reason: please add "reason: <explanation>" after the approval target.' };
  }

  return { target, ids, reason };
}

function bulkExceptionRequestKey(owner: string, repo: string, prNumber: number, headSha: string, requestId: string): string {
  return `layne:exception-all-request:${owner}/${repo}#${prNumber}@${headSha}:${requestId}`;
}

function bulkExceptionCommentBindingKey(owner: string, repo: string, prNumber: number, requestId: string): string {
  return `layne:exception-all-comment:${owner}/${repo}#${prNumber}:${requestId}`;
}

export async function storeBulkExceptionRequest({ owner, repo, prNumber, approvedHeadSha, requestId, approver, reason }: {
  owner: string;
  repo: string;
  prNumber: number;
  approvedHeadSha: string;
  requestId: string;
  approver: string;
  reason: string;
}): Promise<'stored' | 'exists' | 'head-mismatch'> {
  const request: BulkExceptionRequest = {
    requestId,
    approver,
    reason,
    timestamp: new Date().toISOString(),
    approvedHeadSha,
    state: 'pending',
    findingIds: [],
  };
  const bindingKey = bulkExceptionCommentBindingKey(owner, repo, prNumber, requestId);
  const bound = await redis.set(bindingKey, approvedHeadSha, 'EX', EXCEPTION_TTL, 'NX');
  if (bound !== 'OK') {
    const existingHead = await redis.get(bindingKey);
    if (existingHead !== approvedHeadSha) return 'head-mismatch';
  }

  const stored = await redis.set(
    bulkExceptionRequestKey(owner, repo, prNumber, approvedHeadSha, requestId),
    JSON.stringify(request),
    'EX',
    EXCEPTION_TTL,
    'NX',
  );
  return stored === 'OK' ? 'stored' : 'exists';
}

export async function loadBulkExceptionRequest({ owner, repo, prNumber, approvedHeadSha, requestId }: {
  owner: string;
  repo: string;
  prNumber: number;
  approvedHeadSha: string;
  requestId: string;
}): Promise<BulkExceptionRequest | null> {
  const value = await redis.get(bulkExceptionRequestKey(owner, repo, prNumber, approvedHeadSha, requestId));
  return value ? JSON.parse(value) as BulkExceptionRequest : null;
}

export async function materializeBulkExceptionRequest({
  owner,
  repo,
  prNumber,
  approvedHeadSha,
  requestId,
  findingIds,
  expectedExceptions,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  approvedHeadSha: string;
  requestId: string;
  findingIds: string[];
  expectedExceptions: Map<string, ExceptionData>;
}): Promise<BulkExceptionRequest> {
  const requestKey = bulkExceptionRequestKey(owner, repo, prNumber, approvedHeadSha, requestId);
  const setKey = `layne:exception-ids:${owner}/${repo}#${prNumber}`;
  const expected = Object.fromEntries(
    findingIds.flatMap(findingId => {
      const data = expectedExceptions.get(findingId);
      return data ? [[findingId, JSON.stringify(data)]] : [];
    }),
  );
  const exceptionKeyPrefix = `layne:exception:${owner}/${repo}#${prNumber}:`;
  const result = await redis.eval(
    MATERIALIZE_ALL_SCRIPT,
    2,
    requestKey,
    setKey,
    approvedHeadSha,
    EXCEPTION_TTL,
    JSON.stringify(findingIds),
    JSON.stringify(expected),
    exceptionKeyPrefix,
  );
  if (typeof result !== 'string') throw new Error('Invalid bulk exception materialization response');
  return JSON.parse(result) as BulkExceptionRequest;
}

export async function storeExceptions({ owner, repo, prNumber, approvedHeadSha, findingIds, approver, reason }: {
  owner: string;
  repo: string;
  prNumber: number;
  approvedHeadSha: string;
  findingIds: string[];
  approver: string;
  reason: string;
}): Promise<void> {
  const value = JSON.stringify({ approver, reason, timestamp: new Date().toISOString(), approvedHeadSha });
  const setKey = `layne:exception-ids:${owner}/${repo}#${prNumber}`;

  const transaction = redis.multi();
  for (const findingId of findingIds) {
    const key = `layne:exception:${owner}/${repo}#${prNumber}:${findingId}`;
    transaction.set(key, value, 'EX', EXCEPTION_TTL);
  }
  transaction.sadd(setKey, ...findingIds);
  transaction.expire(setKey, EXCEPTION_TTL);

  const results = await transaction.exec();
  if (results === null) throw new Error('Redis exception approval transaction was aborted');
  const commandError = results.find(([error]) => error !== null)?.[0];
  if (commandError) throw commandError;
}

// Returns Map<findingId, ExceptionData>
export async function loadExceptions({ owner, repo, prNumber, findingIds, signal }: {
  owner: string;
  repo: string;
  prNumber: number;
  findingIds: string[];
  signal?: AbortSignal;
}): Promise<Map<string, ExceptionData>> {
  signal?.throwIfAborted();
  const results = await Promise.all(findingIds.map(async findingId => {
    signal?.throwIfAborted();
    const key = `layne:exception:${owner}/${repo}#${prNumber}:${findingId}`;
    const val = await redis.get(key);
    signal?.throwIfAborted();
    // JSON.parse result typed as ExceptionData shape
    return [findingId, val ? JSON.parse(val) as ExceptionData : null] as const;
  }));

  const map = new Map<string, ExceptionData>();
  for (const [id, data] of results) {
    if (data !== null) map.set(id, data);
  }
  return map;
}

export async function filterStaleExceptions({ exceptions, findings, workspacePath, currentHeadSha, signal }: {
  exceptions: Map<string, ExceptionData>;
  findings: ProcessedFinding[];
  workspacePath: string;
  currentHeadSha: string;
  signal?: AbortSignal;
}): Promise<Map<string, ExceptionData>> {
  signal?.throwIfAborted();
  if (exceptions.size === 0) return exceptions;

  const findingById = new Map(findings.map(f => [f._findingId, f]));

  // Group exception findingIds by the SHA at which they were approved.
  const bySha = new Map<string, string[]>();
  for (const [findingId, data] of exceptions) {
    signal?.throwIfAborted();
    const { approvedHeadSha } = data;
    if (approvedHeadSha === currentHeadSha) continue;
    if (!bySha.has(approvedHeadSha)) bySha.set(approvedHeadSha, []);
    bySha.get(approvedHeadSha)!.push(findingId);
  }

  if (bySha.size === 0) return exceptions;

  const filtered = new Map(exceptions);

  for (const [approvedHeadSha, findingIds] of bySha) {
    signal?.throwIfAborted();
    const files = [...new Set(findingIds.map(id => findingById.get(id)?.file).filter((f): f is string => Boolean(f)))];

    let changedRanges: LineRangesByFile;
    try {
      await fetchCommit({ workspacePath, sha: approvedHeadSha, signal });
      changedRanges = await getChangedLineRanges({
        workspacePath, baseSha: approvedHeadSha, headSha: currentHeadSha, files, signal,
      });
    } catch (err) {
      signal?.throwIfAborted();
      console.warn(`[exception-approvals] Could not check staleness for ${approvedHeadSha}: ${(err as Error).message} — invalidating as a precaution`);
      for (const id of findingIds) filtered.delete(id);
      continue;
    }

    for (const findingId of findingIds) {
      signal?.throwIfAborted();
      const finding = findingById.get(findingId);
      if (!finding) continue;

      const line   = finding.line ?? finding.startLine;
      const ranges = changedRanges.get(finding.file) ?? [];
      if (ranges.some(r => (line ?? 0) >= r.start && (line ?? 0) <= r.end)) {
        console.log(`[exception-approvals] Invalidating exception ${findingId}: ${finding.file}:${line} changed since approval`);
        filtered.delete(findingId);
      }
    }
  }

  return filtered;
}

export async function resolveDriftedExceptions({ unmatchedFindings, owner, repo, prNumber, workspacePath, currentHeadSha, signal }: {
  unmatchedFindings: ProcessedFinding[];
  owner: string;
  repo: string;
  prNumber: number;
  workspacePath: string;
  currentHeadSha: string;
  signal?: AbortSignal;
}): Promise<Map<string, ExceptionData>> {
  signal?.throwIfAborted();
  if (unmatchedFindings.length === 0) return new Map();

  const setKey = `layne:exception-ids:${owner}/${repo}#${prNumber}`;
  const allIds = await redis.smembers(setKey);
  signal?.throwIfAborted();
  if (allIds.length === 0) return new Map();

  const allExceptions = await loadExceptions({ owner, repo, prNumber, findingIds: allIds, signal });
  if (allExceptions.size === 0) return new Map();

  // Group stored exceptions by approvedHeadSha. Current-SHA entries are retained
  // so persisted v1 IDs can migrate to their v2 identity without reapproval.
  const bySha = new Map<string, Map<string, ExceptionData>>();
  for (const [findingId, data] of allExceptions) {
    signal?.throwIfAborted();
    if (!bySha.has(data.approvedHeadSha)) bySha.set(data.approvedHeadSha, new Map());
    bySha.get(data.approvedHeadSha)!.set(findingId, data);
  }

  if (bySha.size === 0) return new Map();

  const resolved = new Map<string, ExceptionData>();
  const affectedFiles = [...new Set(unmatchedFindings.map(f => f.file))];

  for (const [approvedHeadSha, exceptionsAtSha] of bySha) {
    signal?.throwIfAborted();
    if (approvedHeadSha !== currentHeadSha) {
      try {
        await fetchCommit({ workspacePath, sha: approvedHeadSha, signal });
      } catch (err) {
        signal?.throwIfAborted();
        console.warn(`[exception-approvals] Could not fetch ${approvedHeadSha} for drift check: ${(err as Error).message} — skipping`);
        continue;
      }
    }

    for (const file of affectedFiles) {
      signal?.throwIfAborted();
      const findingsInFile = unmatchedFindings.filter(f => f.file === file && !resolved.has(f._findingId ?? ''));
      if (findingsInFile.length === 0) continue;

      let lineMap: Map<number, number | null> | null = null;
      if (approvedHeadSha !== currentHeadSha) {
        try {
          lineMap = await buildLineMapForFile({ workspacePath, baseSha: approvedHeadSha, headSha: currentHeadSha, filePath: file, signal });
        } catch (err) {
          signal?.throwIfAborted();
          console.warn(`[exception-approvals] Could not build line map for ${file}@${approvedHeadSha}: ${(err as Error).message} — skipping`);
          continue;
        }
      }

      for (const finding of findingsInFile) {
        signal?.throwIfAborted();
        const currentLine = finding.line ?? finding.startLine;
        const originalLine = lineMap ? lineMap.get(currentLine ?? 0) : currentLine;
        if (originalLine === null || originalLine === undefined) continue;

        const identity = { tool: finding.tool, ruleId: finding.ruleId, evidence: finding.evidence, file: finding.file, line: originalLine };
        const candidateIds = [generateFindingId(identity), generateLegacyFindingId(identity)];
        const oldFindingId = candidateIds.find(id => exceptionsAtSha.has(id));
        const exception = oldFindingId ? exceptionsAtSha.get(oldFindingId) : undefined;
        if (exception) {
          console.log(`[exception-approvals] Drift resolved: ${finding._findingId} (line ${currentLine}) <- ${oldFindingId} (line ${originalLine}) approved by @${exception.approver} at ${approvedHeadSha}`);
          resolved.set(finding._findingId!, exception);
        }
      }
    }
  }

  return resolved;
}

export function buildExceptionSummary({ findings, exceptions, baseSummary }: {
  findings: ProcessedFinding[];
  exceptions: Map<string, ExceptionData>;
  baseSummary: string;
}): { conclusion: 'success' | 'failure'; summary: string } {
  const blockingFindings = findings.filter(f =>
    f._findingId && (f.severity === 'critical' || f.severity === 'high')
  );

  if (blockingFindings.length === 0) {
    return { conclusion: 'success', summary: baseSummary };
  }

  const unexcepted = blockingFindings.filter(f => !exceptions.has(f._findingId!));
  const excepted   = blockingFindings.filter(f => exceptions.has(f._findingId!));

  if (unexcepted.length === 0) {
    // All blocking findings are excepted
    const exceptedLines = blockingFindings.map(f => {
      const ex = exceptions.get(f._findingId!);
      return `- ${f._findingId} [${f.tool}/${f.ruleId}] ${f.file}:${f.startLine ?? f.line} — excepted by @${ex!.approver}: "${ex!.reason}"`;
    }).join('\n');

    return {
      conclusion: 'success',
      summary: `⚠️ All blocking findings were excepted.\n\n${baseSummary}\n\nExcepted findings:\n${exceptedLines}\n\nAll findings are still annotated below for reference.`,
    };
  }

  // Some blocking findings remain unexcepted
  const unexceptedLines = unexcepted.map(f =>
    `- ${f._findingId} [${f.tool}/${f.ruleId}] ${f.file}:${f.startLine ?? f.line}`
  ).join('\n');
  const ids = unexcepted.map(f => f._findingId).join(' ');

  let summary: string;
  if (excepted.length === 0) {
    summary = `${baseSummary}\n\nBlocking findings:\n${unexceptedLines}\n\nTo approve all blocking findings, post:\n/layne exception-approve all reason: <explanation>\n\nTo approve selected findings, post:\n/layne exception-approve ${ids} reason: <explanation>`;
  } else {
    const exceptedLines = excepted.map(f => {
      const ex = exceptions.get(f._findingId!);
      return `- ${f._findingId} — excepted by @${ex!.approver}: "${ex!.reason}"`;
    }).join('\n');
    summary = `${baseSummary}\n\nBlocking findings (${unexcepted.length} remaining):\n${unexceptedLines}\n\nAlready excepted (${excepted.length}):\n${exceptedLines}\n\nTo approve all remaining findings, post:\n/layne exception-approve all reason: <explanation>\n\nTo approve selected findings, post:\n/layne exception-approve ${ids} reason: <explanation>`;
  }

  return { conclusion: 'failure', summary };
}

export async function isReviewerAuthorized({ reviewer, config, installationId, owner }: {
  reviewer: string;
  config: ExceptionApproversConfig;
  installationId: number;
  owner: string;
}): Promise<boolean> {
  if (config.users?.includes(reviewer)) {
    return true;
  }

  if (config.teams?.length) {
    try {
      const members = await getTeamMembers({
        installationId,
        org: owner,
        teamSlugs: config.teams,
      });
      if (members.includes(reviewer)) {
        return true;
      }
    } catch (err) {
      console.error(`[exception-approvals] failed to resolve team members: ${(err as Error).message}`);
    }
  }

  return false;
}
