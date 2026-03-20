import crypto from 'crypto';
import { getTeamMembers } from './github.js';
import { redis } from './queue.js';

const EXCEPTION_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

export function generateFindingId(finding) {
  const input = `${finding.tool}:${finding.file}:${finding.line ?? finding.startLine}`;
  return 'LAYNE-' + crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

// Returns { ids, reason } | { ids, reason: null, error } | null
export function parseExceptionCommand(body) {
  if (!body) return null;

  const lines = body.split('\n');
  const commandLine = lines.find(line => line.includes('/layne exception-approve'));
  if (!commandLine) return null;

  const commandIndex = commandLine.indexOf('/layne exception-approve');
  const afterCommand = commandLine.slice(commandIndex + '/layne exception-approve'.length).trim();

  const tokens = afterCommand.split(/\s+/).filter(Boolean);
  const ids = tokens.filter(t => /^LAYNE-[0-9a-f]{8}$/.test(t));

  if (ids.length === 0) {
    return { ids: [], reason: null, error: 'No valid finding IDs found. IDs must match LAYNE-xxxxxxxx format.' };
  }

  const reasonIndex = tokens.findIndex(t => t === 'reason:');
  if (reasonIndex === -1) {
    return { ids, reason: null, error: 'Missing reason: please add "reason: <explanation>" after the finding IDs.' };
  }

  const reason = tokens.slice(reasonIndex + 1).join(' ').trim();
  if (!reason) {
    return { ids, reason: null, error: 'Missing reason: please add "reason: <explanation>" after the finding IDs.' };
  }

  return { ids, reason };
}

export async function storeExceptions({ owner, repo, prNumber, headSha, findingIds, approver, reason }) {
  const value = JSON.stringify({ approver, reason, timestamp: new Date().toISOString() });

  await Promise.all(findingIds.map(findingId => {
    const key = `layne:exception:${owner}/${repo}#${prNumber}@${headSha}:${findingId}`;
    return redis.set(key, value, 'EX', EXCEPTION_TTL);
  }));
}

// Returns Map<findingId, { approver, reason, timestamp }>
export async function loadExceptions({ owner, repo, prNumber, headSha, findingIds }) {
  const results = await Promise.all(findingIds.map(async findingId => {
    const key = `layne:exception:${owner}/${repo}#${prNumber}@${headSha}:${findingId}`;
    const val = await redis.get(key);
    return [findingId, val ? JSON.parse(val) : null];
  }));

  const map = new Map();
  for (const [id, data] of results) {
    if (data !== null) map.set(id, data);
  }
  return map;
}

export function buildExceptionSummary({ findings, exceptions, baseSummary }) {
  const blockingFindings = findings.filter(f =>
    f._findingId && (f.severity === 'critical' || f.severity === 'high')
  );

  if (blockingFindings.length === 0) {
    return { conclusion: 'success', summary: baseSummary };
  }

  const unexcepted = blockingFindings.filter(f => !exceptions.has(f._findingId));
  const excepted   = blockingFindings.filter(f => exceptions.has(f._findingId));

  if (unexcepted.length === 0) {
    // All blocking findings are excepted
    const exceptedLines = blockingFindings.map(f => {
      const ex = exceptions.get(f._findingId);
      return `- ${f._findingId} [${f.tool}/${f.ruleId}] ${f.file}:${f.startLine ?? f.line} — excepted by @${ex.approver}: "${ex.reason}"`;
    }).join('\n');

    return {
      conclusion: 'success',
      summary: `⚠️ Scan passed with excepted findings.\n\n${baseSummary}\n\nExcepted findings:\n${exceptedLines}\n\nAll findings are still annotated below for reference.`,
    };
  }

  // Some blocking findings remain unexcepted
  const unexceptedLines = unexcepted.map(f =>
    `- ${f._findingId} [${f.tool}/${f.ruleId}] ${f.file}:${f.startLine ?? f.line}`
  ).join('\n');
  const ids = unexcepted.map(f => f._findingId).join(' ');

  let summary;
  if (excepted.length === 0) {
    summary = `${baseSummary}\n\nBlocking findings:\n${unexceptedLines}\n\nTo approve, post a comment:\n/layne exception-approve ${ids} reason: <explanation>`;
  } else {
    const exceptedLines = excepted.map(f => {
      const ex = exceptions.get(f._findingId);
      return `- ${f._findingId} — excepted by @${ex.approver}: "${ex.reason}"`;
    }).join('\n');
    summary = `${baseSummary}\n\nBlocking findings (${unexcepted.length} remaining):\n${unexceptedLines}\n\nAlready excepted (${excepted.length}):\n${exceptedLines}\n\nTo approve remaining findings, post:\n/layne exception-approve ${ids} reason: <explanation>`;
  }

  return { conclusion: 'failure', summary };
}

export async function isReviewerAuthorized({
  reviewer,
  config,
  installationId,
  owner,
}) {
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
      console.error(`[exception-approvals] failed to resolve team members: ${err.message}`);
    }
  }

  return false;
}
