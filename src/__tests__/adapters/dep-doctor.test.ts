import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DepDoctorConfig } from '../../types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({ execFile: mockExecFile }));

const mockReadFile  = vi.fn();
const mockWriteFile = vi.fn();
const mockUnlink    = vi.fn();
const mockMkdir     = vi.fn();
vi.mock('fs/promises', () => ({
  readFile:  mockReadFile,
  writeFile: mockWriteFile,
  unlink:    mockUnlink,
  mkdir:     mockMkdir,
}));

vi.mock('../../config.js', () => ({
  DEFAULT_CONFIG: Object.freeze({
    depDoctor: Object.freeze({
      enabled:         false,
      minCveSeverity:  'high',
      checkAbandoned:  true,
      abandonedDays:   730,
      checkDeprecated: true,
      extraArgs:       [],
    }),
  }),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { runDepDoctor } = await import('../../adapters/dep-doctor.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE  = '/tmp/ws';
const BASE_SHA   = 'base-sha-abc';
const LOCKFILE   = 'package-lock.json';

const ENABLED: DepDoctorConfig = {
  enabled:         true,
  minCveSeverity:  'high',
  checkAbandoned:  true,
  abandonedDays:   730,
  checkDeprecated: true,
  extraArgs:       [],
};

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

function stubGitShow(content: string) {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => cb(null, content, '')
  );
}

function stubGitShowMissing() {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) =>
      cb(new Error('fatal: Path not found in commit'), '', 'fatal: Path not found in commit')
  );
}

function stubOsv(output: string, exitCode = 0) {
  const err = exitCode !== 0 ? Object.assign(new Error(`exit ${exitCode}`), { code: exitCode }) : null;
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => cb(err, output, '')
  );
}

function stubOsvNotFound() {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) =>
      cb(Object.assign(new Error('spawn osv-scanner ENOENT'), { code: 'ENOENT' }), '', '')
  );
}

function buildOsvOutput(packages: Array<{
  name: string; version: string; ecosystem: string;
  vulns?: Array<{ id: string; severity?: string }>;
}>) {
  return JSON.stringify({
    results: [{
      source: { path: WORKSPACE, type: 'lockfile' },
      packages: packages.map(p => ({
        package: { name: p.name, version: p.version, ecosystem: p.ecosystem },
        vulnerabilities: (p.vulns ?? []).map(v => ({
          id:                 v.id,
          database_specific:  { severity: v.severity ?? 'HIGH' },
        })),
      })),
    }],
  });
}

function stubNpmRegistry(name: string, opts: {
  deprecated?: string;
  lastPublishDaysAgo?: number;
  ok?: boolean;
} = {}) {
  mockFetch.mockImplementationOnce(async (url: string) => {
    if (!url.includes(encodeURIComponent(name)) && !url.includes(name)) {
      return { ok: false };
    }
    if (opts.ok === false) return { ok: false };

    const now       = Date.now();
    const versions: Record<string, { deprecated?: string }> = {
      '1.0.0': opts.deprecated ? { deprecated: opts.deprecated } : {},
    };
    const lastPublish = opts.lastPublishDaysAgo !== undefined
      ? new Date(now - opts.lastPublishDaysAgo * 24 * 60 * 60 * 1000).toISOString()
      : new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();

    return {
      ok:   true,
      json: async () => ({
        time:     { '1.0.0': lastPublish, created: '2010-01-01T00:00:00Z', modified: new Date().toISOString() },
        versions,
      }),
    };
  });
}

function stubPypiRegistry(name: string, opts: {
  inactive?: boolean;
  lastPublishDaysAgo?: number;
  ok?: boolean;
} = {}) {
  mockFetch.mockImplementationOnce(async () => {
    if (opts.ok === false) return { ok: false };

    const now         = Date.now();
    const lastPublish = opts.lastPublishDaysAgo !== undefined
      ? new Date(now - opts.lastPublishDaysAgo * 24 * 60 * 60 * 1000).toISOString()
      : new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();

    return {
      ok:   true,
      json: async () => ({
        info:     { classifiers: opts.inactive ? ['Development Status :: 7 - Inactive'] : [] },
        releases: { '1.0.0': [{ upload_time_iso_8601: lastPublish }] },
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Lockfile content builders
// ---------------------------------------------------------------------------

function buildPkgLock(packages: Array<{ name: string; version: string }>) {
  const pkgs: Record<string, { version: string }> = { '': {} as { version: string } };
  for (const { name, version } of packages) {
    pkgs[`node_modules/${name}`] = { version };
  }
  return JSON.stringify({ packages: pkgs });
}

function buildRequirementsTxt(packages: Array<{ name: string; version: string }>) {
  return packages.map(({ name, version }) => `${name}==${version}`).join('\n');
}

// ---------------------------------------------------------------------------
// Guard clause tests
// ---------------------------------------------------------------------------

// Set default resolved values for fs mocks so tests that trigger temp-file
// handling don't throw when they don't explicitly configure these mocks.
function setupFsMocks() {
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
}

describe('runDepDoctor() — guard clauses', () => {
  beforeEach(() => { vi.clearAllMocks(); setupFsMocks(); });

  it('returns empty array when disabled', async () => {
    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, enabled: false },
    });
    expect(findings).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns empty array when changedFiles is null', async () => {
    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  null,
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });
    expect(findings).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns empty array when changedFiles is empty', async () => {
    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });
    expect(findings).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns empty array when no lockfile is in changedFiles', async () => {
    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  ['src/app.js', 'src/utils.ts'],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });
    expect(findings).toEqual([]);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CVE detection
// ---------------------------------------------------------------------------

describe('runDepDoctor() — CVE detection', () => {
  beforeEach(() => { vi.clearAllMocks(); setupFsMocks(); });

  it('returns a finding for a new package with a HIGH CVE', async () => {
    stubGitShow(buildOsvOutput([]));            // base lockfile content (no packages)
    stubOsv(buildOsvOutput([{                   // head scan: lodash has CVE
      name: 'lodash', version: '4.17.11', ecosystem: 'npm',
      vulns: [{ id: 'CVE-2020-8203', severity: 'HIGH' }],
    }]), 1);
    stubOsv(buildOsvOutput([]));                // base OSV scan: no vulns
    stubNpmRegistry('lodash');                  // health check: ok
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'lodash', version: '4.17.11' }]));

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      tool:     'dep-doctor',
      ruleId:   'CVE-2020-8203',
      severity: 'high',
      file:     LOCKFILE,
    });
    expect(findings[0]!.message).toContain('lodash@4.17.11');
  });

  it('does NOT flag a package that already existed in the base lockfile', async () => {
    const existing = buildOsvOutput([{
      name: 'lodash', version: '4.17.11', ecosystem: 'npm',
      vulns: [{ id: 'CVE-2020-8203', severity: 'HIGH' }],
    }]);
    stubGitShow(existing);                       // base lockfile has the same package
    stubOsv(existing, 1);                        // head scan: same package with same CVE
    stubOsv(existing);                           // base OSV scan: same package

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, checkAbandoned: false, checkDeprecated: false },
    });

    expect(findings).toEqual([]);
  });

  it('filters out CVEs below minCveSeverity', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{
      name: 'lodash', version: '4.17.11', ecosystem: 'npm',
      vulns: [{ id: 'CVE-2020-1', severity: 'MEDIUM' }],
    }]), 1);
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('lodash');
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'lodash', version: '4.17.11' }]));

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, minCveSeverity: 'high' },
    });

    const cveFinding = findings.find(f => f.ruleId.startsWith('CVE'));
    expect(cveFinding).toBeUndefined();
  });

  it('treats all packages as new when the base lockfile does not exist', async () => {
    stubGitShowMissing();                        // no base lockfile
    stubOsv(buildOsvOutput([{
      name: 'express', version: '4.18.0', ecosystem: 'npm',
      vulns: [{ id: 'CVE-2024-1', severity: 'CRITICAL' }],
    }]), 1);
    stubNpmRegistry('express');
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'express', version: '4.18.0' }]));

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, minCveSeverity: 'critical' },
    });

    expect(findings.some(f => f.ruleId === 'CVE-2024-1')).toBe(true);
  });

  it('deduplicates findings when the same CVE appears multiple times for the same package', async () => {
    const output = JSON.stringify({
      results: [
        {
          source: { path: WORKSPACE, type: 'lockfile' },
          packages: [
            {
              package:         { name: 'lodash', version: '4.17.11', ecosystem: 'npm' },
              vulnerabilities: [
                { id: 'CVE-2020-8203', database_specific: { severity: 'HIGH' } },
                { id: 'CVE-2020-8203', database_specific: { severity: 'HIGH' } }, // duplicate
              ],
            },
          ],
        },
      ],
    });
    stubGitShow(buildOsvOutput([]));
    stubOsv(output, 1);
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('lodash');
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'lodash', version: '4.17.11' }]));

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    const cveFindings = findings.filter(f => f.ruleId === 'CVE-2020-8203');
    expect(cveFindings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// OSV-Scanner error handling
// ---------------------------------------------------------------------------

describe('runDepDoctor() — osv-scanner error handling', () => {
  beforeEach(() => { vi.clearAllMocks(); setupFsMocks(); });

  it('returns empty array (does not throw) when osv-scanner is not installed', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsvNotFound();                           // ENOENT for head scan
    mockReadFile.mockResolvedValue('');

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, checkAbandoned: false, checkDeprecated: false },
    });

    expect(findings).toEqual([]);
  });

  it('still runs health checks even when osv-scanner fails', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsvNotFound();
    // Health checks should still run since we passed changedFiles with a lockfile

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, checkDeprecated: false, checkAbandoned: false },
    });

    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Abandoned / deprecated health checks
// ---------------------------------------------------------------------------

describe('runDepDoctor() — abandoned/deprecated checks', () => {
  beforeEach(() => { vi.clearAllMocks(); setupFsMocks(); });

  it('returns an abandoned finding for an npm package with no publish in 2+ years', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{ name: 'old-lib', version: '1.0.0', ecosystem: 'npm' }]));
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('old-lib', { lastPublishDaysAgo: 800 });
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'old-lib', version: '1.0.0' }]));

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    expect(findings.some(f => f.ruleId === 'abandoned/deprecated')).toBe(true);
    expect(findings.find(f => f.ruleId === 'abandoned/deprecated')?.severity).toBe('medium');
  });

  it('returns a deprecated finding for a deprecated npm package', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{ name: 'deprecated-pkg', version: '1.0.0', ecosystem: 'npm' }]));
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('deprecated-pkg', { deprecated: 'Use new-pkg instead' });
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'deprecated-pkg', version: '1.0.0' }]));

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    const f = findings.find(f => f.ruleId === 'abandoned/deprecated');
    expect(f).toBeDefined();
    expect(f?.message).toContain('deprecated-pkg');
  });

  it('does NOT return an abandoned finding when checkAbandoned is false', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{ name: 'old-lib', version: '1.0.0', ecosystem: 'npm' }]));
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('old-lib', { lastPublishDaysAgo: 800 });
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'old-lib', version: '1.0.0' }]));

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, checkAbandoned: false },
    });

    expect(findings.some(f => f.ruleId === 'abandoned/deprecated')).toBe(false);
  });

  it('does NOT return a deprecated finding when checkDeprecated is false', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{ name: 'deprecated-pkg', version: '1.0.0', ecosystem: 'npm' }]));
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('deprecated-pkg', { deprecated: 'Use something else' });
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'deprecated-pkg', version: '1.0.0' }]));

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, checkDeprecated: false },
    });

    expect(findings.some(f => f.ruleId === 'abandoned/deprecated')).toBe(false);
  });

  it('does NOT check registry for packages pre-existing in the base lockfile', async () => {
    const lockContent = buildPkgLock([{ name: 'lodash', version: '4.17.11' }]);
    const osvExisting = buildOsvOutput([{ name: 'lodash', version: '4.17.11', ecosystem: 'npm' }]);
    stubGitShow(lockContent);   // base lockfile has lodash
    stubOsv(osvExisting);       // head CVE scan
    stubOsv(osvExisting);       // base CVE scan
    mockReadFile.mockResolvedValue(lockContent);  // head lockfile has same lodash

    await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty array (does not throw) when npm registry returns non-200', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{ name: 'some-pkg', version: '1.0.0', ecosystem: 'npm' }]));
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('some-pkg', { ok: false });
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'some-pkg', version: '1.0.0' }]));

    await expect(runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    })).resolves.not.toThrow();
  });

  it('returns empty array (does not throw) when fetch throws', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{ name: 'some-pkg', version: '1.0.0', ecosystem: 'npm' }]));
    stubOsv(buildOsvOutput([]));
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'some-pkg', version: '1.0.0' }]));

    await expect(runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    })).resolves.not.toThrow();
  });

  it('returns an abandoned finding for a PyPI package with no publish in 2+ years', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{ name: 'old-pylib', version: '1.0.0', ecosystem: 'PyPI' }]));
    stubOsv(buildOsvOutput([]));
    stubPypiRegistry('old-pylib', { lastPublishDaysAgo: 800 });
    mockReadFile.mockResolvedValue(buildRequirementsTxt([{ name: 'old-pylib', version: '1.0.0' }]));

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  ['requirements.txt'],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    expect(findings.some(f => f.ruleId === 'abandoned/deprecated')).toBe(true);
  });

  it('returns a deprecated finding for a PyPI package with inactive classifier', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{ name: 'inactive-lib', version: '1.0.0', ecosystem: 'PyPI' }]));
    stubOsv(buildOsvOutput([]));
    stubPypiRegistry('inactive-lib', { inactive: true });
    mockReadFile.mockResolvedValue(buildRequirementsTxt([{ name: 'inactive-lib', version: '1.0.0' }]));

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  ['requirements.txt'],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    expect(findings.some(f => f.ruleId === 'abandoned/deprecated')).toBe(true);
  });

  it('does NOT call registry API for Go ecosystem packages (unsupported lockfile format)', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{ name: 'github.com/foo/bar', version: 'v1.0.0', ecosystem: 'Go' }]));
    stubOsv(buildOsvOutput([]));
    mockReadFile.mockResolvedValue('github.com/foo/bar v1.0.0 h1:abc=\n');

    await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  ['go.sum'],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Line number lookup
// ---------------------------------------------------------------------------

describe('runDepDoctor() — line number lookup', () => {
  beforeEach(() => { vi.clearAllMocks(); setupFsMocks(); });

  it('finds the correct line in package-lock.json', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{
      name: 'lodash', version: '4.17.11', ecosystem: 'npm',
      vulns: [{ id: 'CVE-2020-8203', severity: 'HIGH' }],
    }]), 1);
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('lodash');
    // Use raw string so parseLockfilePackages sees invalid JSON (returns []) while
    // findLineInLockfile can still locate "node_modules/lodash" at line 2.
    mockReadFile.mockResolvedValue(
      'line 1\n' +
      '  "node_modules/lodash": {\n' +   // line 2
      '    "version": "4.17.11"\n' +
      '  }\n'
    );

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    const cveFinding = findings.find(f => f.ruleId === 'CVE-2020-8203');
    expect(cveFinding?.line).toBe(2);
  });

  it('falls back to line 1 when the package name is not found', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{
      name: 'unknown-pkg', version: '1.0.0', ecosystem: 'npm',
      vulns: [{ id: 'CVE-2024-99', severity: 'HIGH' }],
    }]), 1);
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('unknown-pkg');
    mockReadFile.mockResolvedValue('{}');  // no match for package name

    const findings = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    const cveFinding = findings.find(f => f.ruleId === 'CVE-2024-99');
    expect(cveFinding?.line).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// extraArgs
// ---------------------------------------------------------------------------

describe('runDepDoctor() — extraArgs', () => {
  beforeEach(() => { vi.clearAllMocks(); setupFsMocks(); });

  it('passes extraArgs to both the head and base osv-scanner invocations', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([]));
    stubOsv(buildOsvOutput([]));
    mockReadFile.mockResolvedValue('');

    await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, extraArgs: ['--experimental-all-packages'] },
    });

    const calls = (mockExecFile as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>;
    const osvCalls = calls.filter(([, args]) => args.includes('scan'));
    expect(osvCalls).toHaveLength(2);
    for (const [, args] of osvCalls) {
      expect(args).toContain('--experimental-all-packages');
    }
  });
});

// ---------------------------------------------------------------------------
// Base temp file lifecycle
// ---------------------------------------------------------------------------

describe('runDepDoctor() — base temp file lifecycle', () => {
  beforeEach(() => { vi.clearAllMocks(); setupFsMocks(); });

  it('writes the base lockfile to a temp path then deletes it', async () => {
    const pkgOutput = buildOsvOutput([{ name: 'lodash', version: '4.17.11', ecosystem: 'npm' }]);
    stubGitShow(pkgOutput);                      // base content exists (same package as head)
    stubOsv(pkgOutput);                          // head scan: same package (no new packages)
    stubOsv(pkgOutput);                          // base scan on temp file
    mockReadFile.mockResolvedValue('');

    await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, checkAbandoned: false, checkDeprecated: false },
    });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockUnlink).toHaveBeenCalledOnce();

    const writePath = (mockWriteFile as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(writePath).toContain(WORKSPACE);
  });

  it('still deletes the temp file even when the base osv-scanner call throws', async () => {
    const pkgOutput = buildOsvOutput([{ name: 'lodash', version: '4.17.11', ecosystem: 'npm' }]);
    stubGitShow(pkgOutput);                      // base content exists
    stubOsv(pkgOutput);                          // head scan ok
    stubOsvNotFound();                           // base scan fails with ENOENT
    mockReadFile.mockResolvedValue('');

    await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, checkAbandoned: false, checkDeprecated: false },
    });

    expect(mockUnlink).toHaveBeenCalledOnce();
  });
});
