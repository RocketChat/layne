import { execFile } from 'child_process';
import { buildLineMapForFile } from './fetcher.js';
const SECURITY_COMMENT_RE = /(?:\/\/|#)\s*SECURITY:\s+\S/;
function gitShow(workspacePath, baseSha, filePath) {
    return new Promise((resolve, reject) => {
        execFile('git', ['-C', workspacePath, 'show', `${baseSha}:${filePath}`], (err, stdout) => { if (err && !stdout)
            reject(err);
        else
            resolve(stdout ?? ''); });
    });
}
/**
 * Suppresses findings that already have a `// SECURITY: <reason>` comment at
 * the base SHA.
 */
export async function suppressFindings(findings, { workspacePath, baseSha, headSha }) {
    if (findings.length === 0)
        return [];
    const fileCache = new Map();
    const lineMapCache = new Map();
    async function getLines(filePath) {
        if (fileCache.has(filePath))
            return fileCache.get(filePath);
        let lines = null;
        try {
            const content = await gitShow(workspacePath, baseSha, filePath);
            lines = content.split('\n');
        }
        catch {
            // New file or blob unavailable — no suppression possible
        }
        fileCache.set(filePath, lines);
        return lines;
    }
    async function getLineMap(filePath) {
        if (lineMapCache.has(filePath))
            return lineMapCache.get(filePath);
        let map = null;
        try {
            map = await buildLineMapForFile({ workspacePath, baseSha, headSha, filePath });
        }
        catch {
            // Diff unavailable — fall back to using head line numbers directly
        }
        lineMapCache.set(filePath, map);
        return map;
    }
    const kept = [];
    for (const finding of findings) {
        if (finding.tool === 'claude' && finding.locationValidated !== true) {
            kept.push(finding);
            continue;
        }
        const headLineNumber = finding.suppressionLine ?? finding.startLine ?? finding.line;
        const lineMap = await getLineMap(finding.file);
        let baseLookupLine;
        if (lineMap === null || !lineMap.has(headLineNumber)) {
            // Diff unavailable or line not in map — fall back to head line number
            baseLookupLine = headLineNumber;
        }
        else {
            const mapped = lineMap.get(headLineNumber);
            if (mapped === null) {
                // Newly added line in this PR — cannot have a pre-existing approval
                kept.push(finding);
                continue;
            }
            baseLookupLine = mapped;
        }
        const lines = await getLines(finding.file);
        if (lines === null) {
            kept.push(finding);
            continue;
        }
        const sameLine = lines[baseLookupLine - 1] ?? '';
        const lineAbove = lines[baseLookupLine - 2] ?? '';
        if (SECURITY_COMMENT_RE.test(sameLine) || SECURITY_COMMENT_RE.test(lineAbove)) {
            console.log(`[suppressor] suppressed finding ${finding.file}:${headLineNumber} [${finding.ruleId}] — SECURITY: comment found at base`);
        }
        else {
            kept.push(finding);
        }
    }
    return kept;
}
//# sourceMappingURL=suppressor.js.map