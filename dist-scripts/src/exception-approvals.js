import crypto from 'crypto';
import { getTeamMembers } from './github.js';
import { redis } from './queue.js';
import { fetchCommit, getChangedLineRanges, buildLineMapForFile } from './fetcher.js';
const EXCEPTION_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
export function generateFindingId(finding) {
    const input = `${finding.tool}:${finding.file}:${finding.line ?? finding.startLine}`;
    return 'LAYNE-' + crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}
// Returns { ids, reason } | { ids, reason: null, error } | null
export function parseExceptionCommand(body) {
    if (!body)
        return null;
    const lines = body.split('\n');
    const commandLine = lines.find(line => line.includes('/layne exception-approve'));
    if (!commandLine)
        return null;
    const commandIndex = commandLine.indexOf('/layne exception-approve');
    const afterCommand = commandLine.slice(commandIndex + '/layne exception-approve'.length).trim();
    const tokens = afterCommand.split(/\s+/).filter(Boolean);
    const ids = tokens.filter(t => /^LAYNE-[0-9a-f]{16}$/.test(t));
    if (ids.length === 0) {
        return { ids: [], reason: null, error: 'No valid finding IDs found. IDs must match LAYNE-xxxxxxxxxxxxxxxx format.' };
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
export async function storeExceptions({ owner, repo, prNumber, approvedHeadSha, findingIds, approver, reason }) {
    const value = JSON.stringify({ approver, reason, timestamp: new Date().toISOString(), approvedHeadSha });
    const setKey = `layne:exception-ids:${owner}/${repo}#${prNumber}`;
    await Promise.all([
        ...findingIds.map(findingId => {
            const key = `layne:exception:${owner}/${repo}#${prNumber}:${findingId}`;
            return redis.set(key, value, 'EX', EXCEPTION_TTL);
        }),
        redis.sadd(setKey, ...findingIds).then(() => redis.expire(setKey, EXCEPTION_TTL)),
    ]);
}
// Returns Map<findingId, ExceptionData>
export async function loadExceptions({ owner, repo, prNumber, findingIds }) {
    const results = await Promise.all(findingIds.map(async (findingId) => {
        const key = `layne:exception:${owner}/${repo}#${prNumber}:${findingId}`;
        const val = await redis.get(key);
        // JSON.parse result typed as ExceptionData shape
        return [findingId, val ? JSON.parse(val) : null];
    }));
    const map = new Map();
    for (const [id, data] of results) {
        if (data !== null)
            map.set(id, data);
    }
    return map;
}
export async function filterStaleExceptions({ exceptions, findings, workspacePath, currentHeadSha }) {
    if (exceptions.size === 0)
        return exceptions;
    const findingById = new Map(findings.map(f => [f._findingId, f]));
    // Group exception findingIds by the SHA at which they were approved.
    const bySha = new Map();
    for (const [findingId, data] of exceptions) {
        const { approvedHeadSha } = data;
        if (approvedHeadSha === currentHeadSha)
            continue;
        if (!bySha.has(approvedHeadSha))
            bySha.set(approvedHeadSha, []);
        bySha.get(approvedHeadSha).push(findingId);
    }
    if (bySha.size === 0)
        return exceptions;
    const filtered = new Map(exceptions);
    for (const [approvedHeadSha, findingIds] of bySha) {
        const files = [...new Set(findingIds.map(id => findingById.get(id)?.file).filter((f) => Boolean(f)))];
        let changedRanges;
        try {
            await fetchCommit({ workspacePath, sha: approvedHeadSha });
            changedRanges = await getChangedLineRanges({
                workspacePath, baseSha: approvedHeadSha, headSha: currentHeadSha, files,
            });
        }
        catch (err) {
            console.warn(`[exception-approvals] Could not check staleness for ${approvedHeadSha}: ${err.message} — invalidating as a precaution`);
            for (const id of findingIds)
                filtered.delete(id);
            continue;
        }
        for (const findingId of findingIds) {
            const finding = findingById.get(findingId);
            if (!finding)
                continue;
            const line = finding.line ?? finding.startLine;
            const ranges = changedRanges.get(finding.file) ?? [];
            if (ranges.some(r => (line ?? 0) >= r.start && (line ?? 0) <= r.end)) {
                console.log(`[exception-approvals] Invalidating exception ${findingId}: ${finding.file}:${line} changed since approval`);
                filtered.delete(findingId);
            }
        }
    }
    return filtered;
}
export async function resolveDriftedExceptions({ unmatchedFindings, owner, repo, prNumber, workspacePath, currentHeadSha }) {
    if (unmatchedFindings.length === 0)
        return new Map();
    const setKey = `layne:exception-ids:${owner}/${repo}#${prNumber}`;
    const allIds = await redis.smembers(setKey);
    if (allIds.length === 0)
        return new Map();
    const allExceptions = await loadExceptions({ owner, repo, prNumber, findingIds: allIds });
    if (allExceptions.size === 0)
        return new Map();
    // Group stored exceptions by approvedHeadSha, skipping the current SHA (no drift possible).
    const bySha = new Map();
    for (const [findingId, data] of allExceptions) {
        if (data.approvedHeadSha === currentHeadSha)
            continue;
        if (!bySha.has(data.approvedHeadSha))
            bySha.set(data.approvedHeadSha, new Map());
        bySha.get(data.approvedHeadSha).set(findingId, data);
    }
    if (bySha.size === 0)
        return new Map();
    const resolved = new Map();
    const affectedFiles = [...new Set(unmatchedFindings.map(f => f.file))];
    for (const [approvedHeadSha, exceptionsAtSha] of bySha) {
        try {
            await fetchCommit({ workspacePath, sha: approvedHeadSha });
        }
        catch (err) {
            console.warn(`[exception-approvals] Could not fetch ${approvedHeadSha} for drift check: ${err.message} — skipping`);
            continue;
        }
        for (const file of affectedFiles) {
            const findingsInFile = unmatchedFindings.filter(f => f.file === file && !resolved.has(f._findingId ?? ''));
            if (findingsInFile.length === 0)
                continue;
            let lineMap;
            try {
                lineMap = await buildLineMapForFile({ workspacePath, baseSha: approvedHeadSha, headSha: currentHeadSha, filePath: file });
            }
            catch (err) {
                console.warn(`[exception-approvals] Could not build line map for ${file}@${approvedHeadSha}: ${err.message} — skipping`);
                continue;
            }
            for (const finding of findingsInFile) {
                const currentLine = finding.line ?? finding.startLine;
                const originalLine = lineMap.get(currentLine ?? 0);
                if (originalLine === null || originalLine === undefined)
                    continue;
                const oldFindingId = generateFindingId({ tool: finding.tool, file: finding.file, line: originalLine });
                const exception = exceptionsAtSha.get(oldFindingId);
                if (exception) {
                    console.log(`[exception-approvals] Drift resolved: ${finding._findingId} (line ${currentLine}) <- ${oldFindingId} (line ${originalLine}) approved by @${exception.approver} at ${approvedHeadSha}`);
                    resolved.set(finding._findingId, exception);
                }
            }
        }
    }
    return resolved;
}
export function buildExceptionSummary({ findings, exceptions, baseSummary }) {
    const blockingFindings = findings.filter(f => f._findingId && (f.severity === 'critical' || f.severity === 'high'));
    if (blockingFindings.length === 0) {
        return { conclusion: 'success', summary: baseSummary };
    }
    const unexcepted = blockingFindings.filter(f => !exceptions.has(f._findingId));
    const excepted = blockingFindings.filter(f => exceptions.has(f._findingId));
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
    const unexceptedLines = unexcepted.map(f => `- ${f._findingId} [${f.tool}/${f.ruleId}] ${f.file}:${f.startLine ?? f.line}`).join('\n');
    const ids = unexcepted.map(f => f._findingId).join(' ');
    let summary;
    if (excepted.length === 0) {
        summary = `${baseSummary}\n\nBlocking findings:\n${unexceptedLines}\n\nTo approve, post a comment:\n/layne exception-approve ${ids} reason: <explanation>`;
    }
    else {
        const exceptedLines = excepted.map(f => {
            const ex = exceptions.get(f._findingId);
            return `- ${f._findingId} — excepted by @${ex.approver}: "${ex.reason}"`;
        }).join('\n');
        summary = `${baseSummary}\n\nBlocking findings (${unexcepted.length} remaining):\n${unexceptedLines}\n\nAlready excepted (${excepted.length}):\n${exceptedLines}\n\nTo approve remaining findings, post:\n/layne exception-approve ${ids} reason: <explanation>`;
    }
    return { conclusion: 'failure', summary };
}
export async function isReviewerAuthorized({ reviewer, config, installationId, owner }) {
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
        }
        catch (err) {
            console.error(`[exception-approvals] failed to resolve team members: ${err.message}`);
        }
    }
    return false;
}
//# sourceMappingURL=exception-approvals.js.map