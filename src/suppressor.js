import { execFile } from 'child_process';

const SECURITY_COMMENT_RE = /(?:\/\/|#)\s*SECURITY:\s+\S/;

function gitShow(workspacePath, baseSha, filePath) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', workspacePath, 'show', `${baseSha}:${filePath}`],
      (err, stdout) => { if (err && !stdout) reject(err); else resolve(stdout ?? ''); }
    );
  });
}

/**
 * Suppresses findings that already have a `// SECURITY: <reason>` comment at
 * the base SHA — meaning the comment was reviewed and merged in a prior PR.
 * New `// SECURITY:` comments added in the current PR are invisible to this
 * function (they're not in base), so self-approval is impossible.
 */
export async function suppressFindings(findings, { workspacePath, baseSha }) {
  if (findings.length === 0) return [];

  const fileCache = new Map();

  async function getLines(filePath) {
    if (fileCache.has(filePath)) return fileCache.get(filePath);
    let lines = null;
    try {
      const content = await gitShow(workspacePath, baseSha, filePath);
      lines = content.split('\n');
    } catch {
      // New file or blob unavailable — no suppression possible
    }
    fileCache.set(filePath, lines);
    return lines;
  }

  const kept = [];
  for (const finding of findings) {
    if (finding.tool === 'claude' && finding.locationValidated !== true) {
      kept.push(finding);
      continue;
    }

    const lines = await getLines(finding.file);
    if (lines === null) {
      kept.push(finding);
      continue;
    }

    const line = finding.suppressionLine ?? finding.startLine ?? finding.line;
    const sameLine  = lines[line - 1] ?? '';
    const lineAbove = lines[line - 2] ?? '';

    if (SECURITY_COMMENT_RE.test(sameLine) || SECURITY_COMMENT_RE.test(lineAbove)) {
      console.log(`[suppressor] suppressed finding ${finding.file}:${line} [${finding.ruleId}] — SECURITY: comment found at base`);
    } else {
      kept.push(finding);
    }
  }

  return kept;
}
