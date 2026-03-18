import { execFile } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { debug } from './debug.js';

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const PROJECTED_ROOT = join('.layne', 'diff-only');

export async function createScanContext({
  workspacePath,
  changedFiles,
  baseSha,
  headSha,
  scanConfig,
}) {
  const mode = scanConfig?.mode ?? 'changed_files';
  const contextLines = scanConfig?.contextLines ?? 8;

  if (!changedFiles?.length) {
    return {
      mode,
      contextLines,
      repoWorkspacePath: workspacePath,
      scanWorkspacePath: workspacePath,
      scanFiles:         [],
      promptFiles:       [],
      changedLineRanges: new Map(),
    };
  }

  if (mode !== 'diff_only') {
    return {
      mode,
      contextLines,
      repoWorkspacePath: workspacePath,
      scanWorkspacePath: workspacePath,
      scanFiles:         changedFiles,
      promptFiles:       [],
      changedLineRanges: new Map(),
    };
  }

  const scanWorkspacePath = join(workspacePath, PROJECTED_ROOT);
  const rangesByFile = await getChangedLineRanges({
    workspacePath,
    baseSha,
    headSha,
    files: changedFiles,
  });

  const scanFiles = [];
  const promptFiles = [];

  for (const file of changedFiles) {
    const fullPath = join(workspacePath, file);
    let content;
    try {
      content = await readFile(fullPath, 'utf8');
    } catch {
      continue;
    }

    const { lines, hasTrailingNewline } = splitLines(content);
    const projectedRanges = expandAndMergeRanges(rangesByFile.get(file) ?? [], contextLines, lines.length);
    if (projectedRanges.length === 0) continue;

    const projectedContent = buildProjectedFile(lines, projectedRanges, hasTrailingNewline);
    const projectedPath = join(scanWorkspacePath, file);

    await mkdir(dirname(projectedPath), { recursive: true });
    await writeFile(projectedPath, projectedContent, 'utf8');

    scanFiles.push(file);
    promptFiles.push({
      file,
      content: buildPromptSnippet(lines, projectedRanges),
    });
  }

  debug('scan-context', `prepared diff_only projection for ${scanFiles.length} file(s)`);

  return {
    mode,
    contextLines,
    repoWorkspacePath: workspacePath,
    scanWorkspacePath,
    scanFiles,
    promptFiles,
    changedLineRanges: rangesByFile,
  };
}

export function filterFindingsToChangedLines(findings, scanContext) {
  if (scanContext?.mode !== 'diff_only') return findings;

  return findings.filter(finding => {
    const ranges = scanContext.changedLineRanges?.get(finding.file);
    if (!ranges?.length) return false;

    const line = Number.isInteger(finding.line) ? finding.line : 1;
    return ranges.some(range => line >= range.start && line <= range.end);
  });
}

function git(args) {
  debug('git', `running: git ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    execFile('git', args, (err, stdout, stderr) => {
      if (stderr) console.error(`[git] stderr: ${stderr.trim()}`);
      if (err) reject(err);
      else resolve(stdout ?? '');
    });
  });
}

async function getChangedLineRanges({ workspacePath, baseSha, headSha, files }) {
  const rangesByFile = new Map();

  for (const file of files) {
    const stdout = await git(['-C', workspacePath, 'diff', '--unified=0', '--no-color', baseSha, headSha, '--', file]);
    const ranges = [];

    for (const line of stdout.split('\n')) {
      const match = line.match(HUNK_RE);
      if (!match) continue;

      const start = parseInt(match[1], 10);
      const count = parseInt(match[2] ?? '1', 10);
      if (count === 0) continue;

      ranges.push({ start, end: start + count - 1 });
    }

    rangesByFile.set(file, ranges);
  }

  return rangesByFile;
}

function splitLines(content) {
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (hasTrailingNewline) lines.pop();
  return { lines, hasTrailingNewline };
}

function expandAndMergeRanges(ranges, contextLines, lineCount) {
  if (lineCount === 0) return [];

  const expanded = ranges
    .map(({ start, end }) => ({
      start: Math.max(1, start - contextLines),
      end:   Math.min(lineCount, end + contextLines),
    }))
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const range of expanded) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + 1) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }

  return merged;
}

function buildProjectedFile(lines, ranges, hasTrailingNewline) {
  const projected = Array(lines.length).fill('');

  for (const { start, end } of ranges) {
    for (let line = start; line <= end; line++) {
      projected[line - 1] = lines[line - 1] ?? '';
    }
  }

  const content = projected.join('\n');
  return hasTrailingNewline ? `${content}\n` : content;
}

function buildPromptSnippet(lines, ranges) {
  return ranges
    .map(({ start, end }) => {
      const snippetLines = [];
      for (let line = start; line <= end; line++) {
        snippetLines.push(`${line}| ${lines[line - 1] ?? ''}`);
      }
      return `@@ lines ${start}-${end} @@\n${snippetLines.join('\n')}`;
    })
    .join('\n\n');
}
