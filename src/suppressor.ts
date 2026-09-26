import { execFile } from 'child_process';
import { buildLineMapForFile } from './fetcher.js';
import type { ProcessedFinding, LineMap } from './types.js';

const SECURITY_COMMENT_RE = /(?:\/\/|#)\s*SECURITY:\s+\S/;

function gitShow(workspacePath: string, baseSha: string, filePath: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', workspacePath, 'show', `${baseSha}:${filePath}`],
      { maxBuffer: 200 * 1024 * 1024, ...(signal && { signal }) },
      (err, stdout) => {
        if (signal?.aborted) reject(signal.reason);
        else if (err && !stdout) reject(err);
        else resolve(stdout ?? '');
      }
    );
  });
}

/**
 * Suppresses findings that already have a `// SECURITY: <reason>` comment at
 * the base SHA.
 */
export async function suppressFindings(
  findings: ProcessedFinding[],
  { workspacePath, baseSha, headSha, signal }: { workspacePath: string; baseSha: string; headSha: string; signal?: AbortSignal },
): Promise<ProcessedFinding[]> {
  signal?.throwIfAborted();
  if (findings.length === 0) return [];

  const fileCache    = new Map<string, string[] | null>();
  const lineMapCache = new Map<string, LineMap | null>();

  async function getLines(filePath: string): Promise<string[] | null> {
    if (fileCache.has(filePath)) return fileCache.get(filePath)!;
    let lines: string[] | null = null;
    try {
      const content = await gitShow(workspacePath, baseSha, filePath, signal);
      signal?.throwIfAborted();
      lines = content.split('\n');
    } catch {
      signal?.throwIfAborted();
      // New file or blob unavailable — no suppression possible
    }
    fileCache.set(filePath, lines);
    return lines;
  }

  async function getLineMap(filePath: string): Promise<LineMap | null> {
    if (lineMapCache.has(filePath)) return lineMapCache.get(filePath)!;
    let map: LineMap | null = null;
    try {
      map = await buildLineMapForFile({ workspacePath, baseSha, headSha, filePath, signal });
    } catch {
      signal?.throwIfAborted();
      // Diff unavailable — fall back to using head line numbers directly
    }
    lineMapCache.set(filePath, map);
    return map;
  }

  const kept: ProcessedFinding[] = [];
  for (const finding of findings) {
    signal?.throwIfAborted();
    if (finding.tool === 'claude' && finding.locationValidated !== true) {
      kept.push(finding);
      continue;
    }

    const headLineNumber = finding.suppressionLine ?? finding.startLine ?? finding.line;

    const lineMap = await getLineMap(finding.file);
    let baseLookupLine: number;

    if (lineMap === null || !lineMap.has(headLineNumber)) {
      // Diff unavailable or line not in map — fall back to head line number
      baseLookupLine = headLineNumber;
    } else {
      const mapped = lineMap.get(headLineNumber);
      if (mapped === null) {
        // Newly added line in this PR — cannot have a pre-existing approval
        kept.push(finding);
        continue;
      }
      baseLookupLine = mapped!;
    }

    const lines = await getLines(finding.file);
    if (lines === null) {
      kept.push(finding);
      continue;
    }

    const sameLine  = lines[baseLookupLine - 1] ?? '';
    const lineAbove = lines[baseLookupLine - 2] ?? '';

    if (SECURITY_COMMENT_RE.test(sameLine) || SECURITY_COMMENT_RE.test(lineAbove)) {
      console.log(`[suppressor] suppressed finding ${finding.file}:${headLineNumber} [${finding.ruleId}] — SECURITY: comment found at base`);
    } else {
      kept.push(finding);
    }
  }

  return kept;
}
