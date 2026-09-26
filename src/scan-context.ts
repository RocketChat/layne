import { execFile } from 'child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { debug } from './debug.js';
import type { ScanContext, ScanConfig, LineRangesByFile, LineRange, UnifiedDiff } from './types.js';

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export async function createScanContext({ workspacePath, changedFiles, baseSha, headSha, scanConfig, changedLineRanges, unifiedDiff, signal }: {
  workspacePath: string;
  changedFiles: string[];
  baseSha: string;
  headSha: string;
  scanConfig?: Partial<ScanConfig>;
  changedLineRanges?: LineRangesByFile;
  unifiedDiff?: UnifiedDiff;
  signal?: AbortSignal;
}): Promise<ScanContext> {
  signal?.throwIfAborted();
  const mode = scanConfig?.mode ?? 'changed_files';
  const contextLines = scanConfig?.contextLines ?? 8;
  const metadataOnlyChanges = unifiedDiff?.files.filter(file =>
    file.hunks.length === 0
    && (file.change.status === 'renamed' || file.change.status === 'copied' || file.change.oldOid === file.change.newOid)
  ).length ?? 0;
  const unprojectableChanges = unifiedDiff?.files.filter(file =>
    file.hunks.length === 0
    && file.change.status !== 'renamed'
    && file.change.status !== 'copied'
    && file.change.oldOid !== file.change.newOid
  ).length ?? 0;
  const diffCoverage = unifiedDiff
    ? { unifiedDiff, metadataOnlyChanges, unprojectableChanges }
    : {};

  if (!changedFiles?.length) {
    return {
      mode,
      contextLines,
      headSha,
      baseSha,
      repoWorkspacePath: workspacePath,
      scanWorkspacePath: workspacePath,
      sourceFiles:       [],
      scanFiles:         [],
      promptFiles:       [],
      changedLineRanges: new Map(),
      ...diffCoverage,
    };
  }

  const rangesByFile = changedLineRanges ?? await getChangedLineRanges({
    workspacePath,
    baseSha,
    headSha,
    files: changedFiles,
    signal,
  });
  signal?.throwIfAborted();

  // Spectre and Claude use line-numbered changed hunks in every mode. In
  // changed_files mode the other scanners still receive the complete files.
  if (mode !== 'diff_only') {
    const promptFiles: Array<{ file: string; content: string }> = [];
    for (const file of changedFiles) {
      signal?.throwIfAborted();
      try {
        const content = await readFile(join(workspacePath, file), 'utf8');
        signal?.throwIfAborted();
        const { lines } = splitLines(content);
        const ranges = expandAndMergeRanges(rangesByFile.get(file) ?? [], contextLines, lines.length, signal);
        if (ranges.length > 0) promptFiles.push({ file, content: buildPromptSnippet(lines, ranges, signal) });
      } catch {
        signal?.throwIfAborted();
        // Let the individual adapter report an unreadable file if selected.
      }
    }
    return {
      mode,
      contextLines,
      headSha,
      baseSha,
      repoWorkspacePath: workspacePath,
      scanWorkspacePath: workspacePath,
      sourceFiles:       changedFiles,
      scanFiles:         changedFiles,
      promptFiles,
      changedLineRanges: rangesByFile,
      ...diffCoverage,
    };
  }

  // Never write through a repository-controlled .layne symlink or directory.
  // The worker removes this private projection with the enclosing workspace.
  const scanWorkspacePath = await mkdtemp(join(workspacePath, '.layne-diff-'));

  const scanFiles: string[] = [];
  const promptFiles: Array<{ file: string; content: string }> = [];

  for (const file of changedFiles) {
    signal?.throwIfAborted();
    const fullPath = join(workspacePath, file);
    let content: string;
    try {
      content = await readFile(fullPath, 'utf8');
      signal?.throwIfAborted();
    } catch {
      signal?.throwIfAborted();
      continue;
    }

    const { lines, hasTrailingNewline } = splitLines(content);
    const projectedRanges = expandAndMergeRanges(rangesByFile.get(file) ?? [], contextLines, lines.length, signal);
    if (projectedRanges.length === 0) continue;

    const projectedContent = buildProjectedFile(lines, projectedRanges, hasTrailingNewline, signal);
    const projectedPath = join(scanWorkspacePath, file);

    signal?.throwIfAborted();
    await mkdir(dirname(projectedPath), { recursive: true });
    signal?.throwIfAborted();
    await writeFile(projectedPath, projectedContent, 'utf8');
    signal?.throwIfAborted();

    scanFiles.push(file);
    promptFiles.push({
      file,
      content: buildPromptSnippet(lines, projectedRanges, signal),
    });
  }

  debug('scan-context', `prepared diff_only projection for ${scanFiles.length} file(s)`);

  return {
    mode,
    contextLines,
    headSha,
    baseSha,
    repoWorkspacePath: workspacePath,
    scanWorkspacePath,
    sourceFiles: changedFiles,
    scanFiles,
    promptFiles,
    changedLineRanges: rangesByFile,
    ...diffCoverage,
  };
}

export function filterFindingsToChangedLines<T extends { file: string; line?: number; tool?: string }>(
  findings: T[],
  scanContext?: ScanContext | null,
): T[] {
  if (scanContext?.mode !== 'diff_only') return findings;

  return findings.filter(finding => {
    // Dep Doctor already compares resolved package/version pairs to the merge base.
    // A version-only update can leave the package-name anchor line unchanged.
    if (finding.tool === 'dep-doctor') return true;
    const ranges = scanContext.changedLineRanges?.get(finding.file);
    if (!ranges?.length) return false;

    const line = Number.isInteger(finding.line) ? finding.line! : 1;
    return ranges.some(range => line >= range.start && line <= range.end);
  });
}

function git(args: string[], signal?: AbortSignal): Promise<string> {
  debug('git', `running: git ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    execFile('git', args, { maxBuffer: 200 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (stderr) console.error(`[git] stderr: ${stderr.trim()}`);
      if (err) reject(err);
      else resolve(stdout ?? '');
    });
  });
}

async function getChangedLineRanges({ workspacePath, baseSha, headSha, files, signal }: {
  workspacePath: string;
  baseSha: string;
  headSha: string;
  files: string[];
  signal?: AbortSignal;
}): Promise<LineRangesByFile> {
  const rangesByFile = new Map<string, LineRange[]>();

  for (const file of files) {
    signal?.throwIfAborted();
    const stdout = await git(['-C', workspacePath, 'diff', '--unified=0', '--no-color', baseSha, headSha, '--', file], signal);
    signal?.throwIfAborted();
    const ranges: LineRange[] = [];

    for (const line of stdout.split('\n')) {
      signal?.throwIfAborted();
      const match = line.match(HUNK_RE);
      if (!match) continue;

      const start = parseInt(match[1]!, 10);
      const count = parseInt(match[2] ?? '1', 10);
      if (count === 0) continue;

      ranges.push({ start, end: start + count - 1 });
    }

    rangesByFile.set(file, ranges);
  }

  return rangesByFile;
}

function splitLines(content: string): { lines: string[]; hasTrailingNewline: boolean } {
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (hasTrailingNewline) lines.pop();
  return { lines, hasTrailingNewline };
}

function expandAndMergeRanges(ranges: LineRange[], contextLines: number, lineCount: number, signal?: AbortSignal): LineRange[] {
  signal?.throwIfAborted();
  if (lineCount === 0) return [];

  const expanded = ranges
    .map(({ start, end }) => {
      signal?.throwIfAborted();
      return {
        start: Math.max(1, start - contextLines),
        end:   Math.min(lineCount, end + contextLines),
      };
    })
    .sort((a, b) => a.start - b.start);

  const merged: LineRange[] = [];
  for (const range of expanded) {
    signal?.throwIfAborted();
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + 1) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }

  return merged;
}

function buildProjectedFile(lines: string[], ranges: LineRange[], hasTrailingNewline: boolean, signal?: AbortSignal): string {
  const projected = Array(lines.length).fill('') as string[];

  for (const { start, end } of ranges) {
    for (let line = start; line <= end; line++) {
      signal?.throwIfAborted();
      projected[line - 1] = lines[line - 1] ?? '';
    }
  }

  const content = projected.join('\n');
  return hasTrailingNewline ? `${content}\n` : content;
}

function buildPromptSnippet(lines: string[], ranges: LineRange[], signal?: AbortSignal): string {
  return ranges
    .map(({ start, end }) => {
      signal?.throwIfAborted();
      const snippetLines: string[] = [];
      for (let line = start; line <= end; line++) {
        signal?.throwIfAborted();
        snippetLines.push(`${line}| ${lines[line - 1] ?? ''}`);
      }
      return `@@ lines ${start}-${end} @@\n${snippetLines.join('\n')}`;
    })
    .join('\n\n');
}
