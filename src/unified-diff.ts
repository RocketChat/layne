import type {
  GitChange,
  LineRange,
  LineRangesByFile,
  UnifiedDiff,
  UnifiedDiffFile,
  UnifiedDiffHunk,
  UnifiedDiffLine,
} from './types.js';

const NO_NEWLINE_MARKER = '\\ No newline at end of file';

export function parseUnifiedDiff(patch: string, changes: GitChange[]): UnifiedDiff {
  const files: UnifiedDiffFile[] = changes.map(change => ({ change, hunks: [] }));
  const seen = new Set<UnifiedDiffFile>();
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();

  let currentFile: UnifiedDiffFile | null = null;

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;

    if (line.startsWith('--- ')) {
      const nextLine = lines[index + 1];
      if (nextLine === undefined || !nextLine.startsWith('+++ ')) {
        throw new Error('Malformed unified diff: missing new file path');
      }

      const oldPath = parsePatchPath(line.slice(4), 'a/');
      const newPath = parsePatchPath(nextLine.slice(4), 'b/');
      currentFile = findFile(files, oldPath, newPath);
      if (seen.has(currentFile)) {
        throw new Error(`Malformed unified diff: duplicate file section for ${JSON.stringify(newPath ?? oldPath)}`);
      }
      seen.add(currentFile);
      index += 2;
      continue;
    }

    if (line.startsWith('+++ ')) {
      throw new Error('Malformed unified diff: new file path without old file path');
    }

    if (line.startsWith('@@')) {
      if (currentFile === null) throw new Error('Malformed unified diff: hunk without a file');
      const { hunk, nextIndex } = parseHunk(lines, index);
      currentFile.hunks.push(hunk);
      index = nextIndex;
      continue;
    }

    if (currentFile !== null && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'))) {
      throw new Error(`Malformed unified diff: content outside hunk at patch line ${index + 1}`);
    }

    index++;
  }

  return { files };
}

export function renderUnifiedDiff(diff: UnifiedDiff): string {
  const output: string[] = [];

  for (const file of diff.files) {
    output.push(`--- ${formatPatchPath(file.change.oldPath, 'a/')}`);
    output.push(`+++ ${formatPatchPath(file.change.newPath, 'b/')}`);

    for (const hunk of file.hunks) {
      output.push(`@@ -${formatRange(hunk.oldStart, hunk.oldCount)} +${formatRange(hunk.newStart, hunk.newCount)} @@${hunk.section}`);
      for (const line of hunk.lines) {
        const prefix = line.type === 'context' ? ' ' : line.type === 'addition' ? '+' : '-';
        output.push(`${prefix}${line.content}`);
        if (line.noNewlineAtEnd) output.push(NO_NEWLINE_MARKER);
      }
    }
  }

  return output.length === 0 ? '' : `${output.join('\n')}\n`;
}

export function deriveChangedHeadRanges(diff: UnifiedDiff): LineRangesByFile {
  const rangesByFile = new Map<string, LineRange[]>();

  for (const file of diff.files) {
    const path = file.change.newPath;
    if (path === null) continue;

    const ranges: LineRange[] = [];
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type !== 'addition') continue;
        const previous = ranges.at(-1);
        if (previous !== undefined && line.newLine === previous.end + 1) {
          previous.end = line.newLine;
        } else {
          ranges.push({ start: line.newLine, end: line.newLine });
        }
      }
    }
    rangesByFile.set(path, ranges);
  }

  return rangesByFile;
}

function parseHunk(lines: string[], startIndex: number): { hunk: UnifiedDiffHunk; nextIndex: number } {
  const header = lines[startIndex]!;
  const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!match) throw new Error(`Malformed unified diff hunk header: ${JSON.stringify(header)}`);

  const oldStart = parseCoordinate(match[1]!, 'old start');
  const oldCount = parseCoordinate(match[2] ?? '1', 'old count');
  const newStart = parseCoordinate(match[3]!, 'new start');
  const newCount = parseCoordinate(match[4] ?? '1', 'new count');
  assertValidRange(oldStart, oldCount, 'old');
  assertValidRange(newStart, newCount, 'new');
  const hunkLines: UnifiedDiffLine[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  let oldConsumed = 0;
  let newConsumed = 0;
  let index = startIndex + 1;
  let previousLine: UnifiedDiffLine | null = null;

  while (oldConsumed < oldCount || newConsumed < newCount) {
    const line = lines[index];
    if (line === undefined) throw new Error(`Malformed unified diff hunk: line counts do not match ${JSON.stringify(header)}`);

    if (line === NO_NEWLINE_MARKER) {
      markNoNewline(previousLine, index);
      index++;
      continue;
    }

    let parsed: UnifiedDiffLine;
    if (line.startsWith(' ')) {
      parsed = { type: 'context', content: line.slice(1), oldLine, newLine };
      oldLine++;
      newLine++;
      oldConsumed++;
      newConsumed++;
    } else if (line.startsWith('+')) {
      parsed = { type: 'addition', content: line.slice(1), oldLine: null, newLine };
      newLine++;
      newConsumed++;
    } else if (line.startsWith('-')) {
      parsed = { type: 'deletion', content: line.slice(1), oldLine, newLine: null };
      oldLine++;
      oldConsumed++;
    } else {
      throw new Error(`Malformed unified diff hunk content at patch line ${index + 1}`);
    }

    if (oldConsumed > oldCount || newConsumed > newCount) {
      throw new Error(`Malformed unified diff hunk: line counts exceed ${JSON.stringify(header)}`);
    }
    hunkLines.push(parsed);
    previousLine = parsed;
    index++;
  }

  if (lines[index] === NO_NEWLINE_MARKER) {
    markNoNewline(previousLine, index);
    index++;
  }

  const nextLine = lines[index];
  if (nextLine !== undefined
    && !nextLine.startsWith('--- ')
    && !nextLine.startsWith('+++ ')
    && (nextLine.startsWith(' ') || nextLine.startsWith('+') || nextLine.startsWith('-') || nextLine.startsWith('\\'))) {
    throw new Error(`Malformed unified diff hunk: line counts are smaller than the hunk content at patch line ${index + 1}`);
  }

  return {
    hunk: { oldStart, oldCount, newStart, newCount, section: match[5]!, lines: hunkLines },
    nextIndex: index,
  };
}

function markNoNewline(line: UnifiedDiffLine | null, markerIndex: number): void {
  if (line === null || line.noNewlineAtEnd) {
    throw new Error(`Malformed unified diff: misplaced no-newline marker at patch line ${markerIndex + 1}`);
  }
  line.noNewlineAtEnd = true;
}

function findFile(files: UnifiedDiffFile[], oldPath: string | null, newPath: string | null): UnifiedDiffFile {
  const matches = files.filter(file => file.change.oldPath === oldPath && file.change.newPath === newPath);
  if (matches.length !== 1) {
    throw new Error(`Unified diff path does not map to exactly one Git change: ${JSON.stringify({ oldPath, newPath })}`);
  }
  return matches[0]!;
}

function parsePatchPath(value: string, prefix: 'a/' | 'b/'): string | null {
  if (value === '/dev/null') return null;
  const decoded = value.startsWith('"') ? decodeGitQuotedPath(value) : value;
  if (!decoded.startsWith(prefix)) {
    throw new Error(`Malformed unified diff path: ${JSON.stringify(value)}`);
  }
  const path = decoded.slice(prefix.length);
  assertSafePath(path);
  return path;
}

function decodeGitQuotedPath(value: string): string {
  if (value.length < 2 || !value.endsWith('"')) {
    throw new Error(`Malformed quoted unified diff path: ${JSON.stringify(value)}`);
  }

  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const escapes: Record<string, number> = {
    a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '"': 0x22, '\\': 0x5c,
  };

  for (let index = 0; index < body.length;) {
    const character = body[index]!;
    if (character !== '\\') {
      const codePoint = body.codePointAt(index)!;
      bytes.push(...Buffer.from(String.fromCodePoint(codePoint)));
      index += codePoint > 0xffff ? 2 : 1;
      continue;
    }

    const escaped = body[index + 1];
    if (escaped === undefined) throw new Error(`Malformed quoted unified diff path: ${JSON.stringify(value)}`);
    if (escapes[escaped] !== undefined) {
      bytes.push(escapes[escaped]);
      index += 2;
      continue;
    }

    const octal = body.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal === undefined) throw new Error(`Malformed quoted unified diff path: ${JSON.stringify(value)}`);
    bytes.push(Number.parseInt(octal, 8));
    index += octal.length + 1;
  }

  return Buffer.from(bytes).toString('utf8');
}

function assertSafePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) {
    throw new Error(`Unsafe path in unified diff: ${JSON.stringify(path)}`);
  }
}

function parseCoordinate(value: string, label: string): number {
  const coordinate = Number(value);
  if (!Number.isSafeInteger(coordinate) || coordinate < 0) {
    throw new Error(`Malformed unified diff ${label}: ${JSON.stringify(value)}`);
  }
  return coordinate;
}

function assertValidRange(start: number, count: number, label: string): void {
  const overflows = count > 0 && count - 1 > Number.MAX_SAFE_INTEGER - start;
  if ((count > 0 && start === 0) || overflows) {
    throw new Error(`Malformed unified diff ${label} range: ${JSON.stringify({ start, count })}`);
  }
}

function formatRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function formatPatchPath(path: string | null, prefix: 'a/' | 'b/'): string {
  if (path === null) return '/dev/null';
  assertSafePath(path);
  const value = `${prefix}${path}`;
  if (!/[\x00-\x1f\x7f"\\]/u.test(value)) return value;

  let quoted = '"';
  for (const byte of Buffer.from(value)) {
    if (byte === 0x22 || byte === 0x5c) quoted += `\\${String.fromCharCode(byte)}`;
    else if (byte >= 0x20 && byte < 0x7f) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${quoted}"`;
}
