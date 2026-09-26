import { describe, expect, it } from 'vitest';
import { deriveChangedHeadRanges, parseUnifiedDiff, renderUnifiedDiff } from '../unified-diff.js';
import type { GitChange } from '../types.js';

function change(overrides: Partial<GitChange> = {}): GitChange {
  return {
    status: 'modified',
    oldPath: 'src/app.ts',
    newPath: 'src/app.ts',
    oldMode: '100644',
    newMode: '100644',
    oldOid: 'aaaaaaa',
    newOid: 'bbbbbbb',
    oldKind: 'regular',
    newKind: 'regular',
    ...overrides,
  };
}

describe('parseUnifiedDiff()', () => {
  it('creates typed lines with exact old and new coordinates', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/src/app.ts b/src/app.ts',
      'index aaaaaaa..bbbbbbb 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -2,3 +2,4 @@ function run()',
      ' keep',
      '-old',
      '+first',
      '+second',
      ' tail',
      '',
    ].join('\n'), [change()]);

    expect(parsed.files[0]?.hunks[0]).toEqual({
      oldStart: 2,
      oldCount: 3,
      newStart: 2,
      newCount: 4,
      section: ' function run()',
      lines: [
        { type: 'context', content: 'keep', oldLine: 2, newLine: 2 },
        { type: 'deletion', content: 'old', oldLine: 3, newLine: null },
        { type: 'addition', content: 'first', oldLine: null, newLine: 3 },
        { type: 'addition', content: 'second', oldLine: null, newLine: 4 },
        { type: 'context', content: 'tail', oldLine: 4, newLine: 5 },
      ],
    });
  });

  it('preserves spaces in paths and maps a rename to its destination', () => {
    const renamed = change({
      status: 'renamed',
      oldPath: 'src/old name.ts',
      newPath: 'src/new name.ts',
      similarity: 80,
    });
    const parsed = parseUnifiedDiff([
      'diff --git a/src/old name.ts b/src/new name.ts',
      'similarity index 80%',
      'rename from src/old name.ts',
      'rename to src/new name.ts',
      '--- a/src/old name.ts',
      '+++ b/src/new name.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n'), [renamed]);

    expect(parsed.files[0]?.change).toBe(renamed);
    expect(parsed.files[0]?.hunks[0]?.lines[1]).toEqual({
      type: 'addition', content: 'new', oldLine: null, newLine: 1,
    });
    expect(deriveChangedHeadRanges(parsed)).toEqual(new Map([
      ['src/new name.ts', [{ start: 1, end: 1 }]],
    ]));
  });

  it('supports added and deleted files through /dev/null', () => {
    const added = change({
      status: 'added', oldPath: null, newPath: 'new file.ts', oldMode: '000000', oldKind: 'absent',
    });
    const deleted = change({
      status: 'deleted', oldPath: 'gone.ts', newPath: null, newMode: '000000', newKind: 'absent',
    });
    const parsed = parseUnifiedDiff([
      '--- /dev/null',
      '+++ b/new file.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
    ].join('\n'), [added, deleted]);

    expect(parsed.files[0]?.hunks[0]?.lines).toHaveLength(2);
    expect(parsed.files[1]?.hunks[0]?.lines[0]).toEqual({
      type: 'deletion', content: 'gone', oldLine: 1, newLine: null,
    });
  });

  it('attaches no-newline markers to the source line they follow', () => {
    const parsed = parseUnifiedDiff([
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-before',
      '\\ No newline at end of file',
      '+after',
      '\\ No newline at end of file',
    ].join('\n'), [change()]);

    expect(parsed.files[0]?.hunks[0]?.lines).toEqual([
      { type: 'deletion', content: 'before', oldLine: 1, newLine: null, noNewlineAtEnd: true },
      { type: 'addition', content: 'after', oldLine: null, newLine: 1, noNewlineAtEnd: true },
    ]);
  });

  it('rejects a misplaced or malformed no-newline marker', () => {
    const misplaced = '--- a/src/app.ts\n+++ b/src/app.ts\n\\ No newline at end of file\n';
    const malformed = '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at EOF\n';

    expect(() => parseUnifiedDiff(misplaced, [change()])).toThrow(/content outside hunk/);
    expect(() => parseUnifiedDiff(malformed, [change()])).toThrow(/line counts/);
  });

  it('keeps hunkless Git changes linked in the model', () => {
    const renamed = change({ status: 'renamed', oldPath: 'old.ts', newPath: 'new.ts', similarity: 100 });
    expect(parseUnifiedDiff([
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n'), [renamed])).toEqual({ files: [{ change: renamed, hunks: [] }] });
  });

  it('fails closed when hunk counts do not match the body', () => {
    const tooShort = [
      '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,2 +1 @@', '-old', '+new',
    ].join('\n');
    const tooLong = [
      '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-old', '+new', '+extra',
    ].join('\n');

    expect(() => parseUnifiedDiff(tooShort, [change()])).toThrow(/line counts/);
    expect(() => parseUnifiedDiff(tooLong, [change()])).toThrow(/line counts/);
  });

  it('fails closed on impossible or overflowing hunk ranges', () => {
    const lineZero = '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -0 +1 @@\n-old\n+new\n';
    const overflow = `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +${Number.MAX_SAFE_INTEGER},2 @@\n-old\n+one\n+two\n`;

    expect(() => parseUnifiedDiff(lineZero, [change()])).toThrow(/old range/);
    expect(() => parseUnifiedDiff(overflow, [change()])).toThrow(/new range/);
  });

  it('fails closed on malformed, unsafe, or unmapped paths', () => {
    expect(() => parseUnifiedDiff('--- src/app.ts\n+++ b/src/app.ts\n', [change()])).toThrow(/path/);
    expect(() => parseUnifiedDiff('--- a/../app.ts\n+++ b/src/app.ts\n', [change()])).toThrow(/Unsafe path/);
    expect(() => parseUnifiedDiff('--- a/other.ts\n+++ b/other.ts\n', [change()])).toThrow(/exactly one Git change/);
  });
});

describe('renderUnifiedDiff()', () => {
  it('renders a canonical patch that parses back to the same typed model', () => {
    const source = [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -4,2 +4,3 @@ block',
      ' same',
      '-old',
      '+new',
      '+more',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const parsed = parseUnifiedDiff(source, [change()]);
    const rendered = renderUnifiedDiff(parsed);

    expect(rendered).toBe(source);
    expect(parseUnifiedDiff(rendered, [change()])).toEqual(parsed);
  });
});

describe('deriveChangedHeadRanges()', () => {
  it('groups only contiguous additions in HEAD coordinates', () => {
    const parsed = parseUnifiedDiff([
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,4 +1,6 @@',
      ' context',
      '-old',
      '+one',
      '+two',
      ' gap',
      '+three',
      ' tail',
    ].join('\n'), [change()]);

    expect(deriveChangedHeadRanges(parsed)).toEqual(new Map([
      ['src/app.ts', [{ start: 2, end: 3 }, { start: 5, end: 5 }]],
    ]));
  });
});
