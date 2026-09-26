import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DepDoctorConfig } from '../../types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({ execFile: mockExecFile }));

const mockReadFile  = vi.fn();
const mockWriteFile = vi.fn();
const mockRm        = vi.fn();
const mockMkdir     = vi.fn().mockResolvedValue('/tmp/ws/.layne-dep-doctor-test');
vi.mock('fs/promises', () => ({
  readFile:  mockReadFile,
  writeFile: mockWriteFile,
  rm:        mockRm,
  mkdtemp:   mockMkdir,
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

async function runFindings(args: Parameters<typeof runDepDoctor>[0]) {
  return (await runDepDoctor(args)).findings;
}

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
  let lockfileContent = content;
  try {
    const parsed = JSON.parse(content) as {
      results?: Array<{ packages?: Array<{ package?: { name?: string; version?: string } }> }>;
    };
    if (Array.isArray(parsed.results)) {
      const packagePairs = parsed.results.flatMap(result => result.packages ?? [])
        .flatMap(entry => entry.package?.name && entry.package.version
          ? [{ name: entry.package.name, version: entry.package.version }]
          : []);
      lockfileContent = buildPkgLock(packagePairs);
    }
  } catch { /* preserve explicit non-JSON lockfile fixtures */ }
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => cb(null, lockfileContent, '')
  );
}

function stubGitShowMissing() {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) =>
      cb(new Error('fatal: Path not found in commit'), '', 'fatal: Path not found in commit')
  );
}

function stubGitShowFailure() {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) =>
      cb(Object.assign(new Error('fatal: bad object base-sha-abc'), { code: 128 }), '', 'fatal: bad object base-sha-abc')
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
  return JSON.stringify({ lockfileVersion: 3, packages: pkgs });
}

function buildRequirementsTxt(packages: Array<{ name: string; version: string }>) {
  return packages.map(({ name, version }) => `${name}==${version}`).join('\n');
}

const HEALTH_FORMAT_FIXTURES = [
  {
    filename: 'pnpm-lock.yaml',
    packageName: 'old-lib',
    content: "lockfileVersion: '9.0'\npackages:\n  'old-lib@1.0.0':\n    resolution: {integrity: sha512-test}\n",
    line: 3,
    registry: 'npm',
  },
  {
    filename: 'Pipfile.lock',
    packageName: 'old-pylib',
    content: JSON.stringify({
      _meta: { 'pipfile-spec': 6, sources: [{ name: 'pypi', url: 'https://pypi.org/simple' }] },
      default: { 'old-pylib': { version: '==1.0.0', index: 'pypi' } },
    }, null, 2),
    line: 12,
    registry: 'PyPI',
  },
  {
    filename: 'poetry.lock',
    packageName: 'old-pylib',
    content: '[[package]]\nname = "old-pylib"\nversion = "1.0.0"\n\n[metadata]\nlock-version = "2.1"\n',
    line: 2,
    registry: 'PyPI',
  },
  {
    filename: 'uv.lock',
    packageName: 'old-pylib',
    content: 'version = 1\nrevision = 3\n\n[[package]]\nname = "old-pylib"\nversion = "1.0.0"\nsource = { registry = "https://pypi.org/simple" }\n',
    line: 5,
    registry: 'PyPI',
  },
] as const;

// ---------------------------------------------------------------------------
// Guard clause tests
// ---------------------------------------------------------------------------

// Set default resolved values for fs mocks so tests that trigger temp-file
// handling don't throw when they don't explicitly configure these mocks.
function setupFsMocks() {
  mockMkdir.mockResolvedValue('/tmp/ws/.layne-dep-doctor-test');
  mockReadFile.mockResolvedValue('');
  mockWriteFile.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
}

describe('runDepDoctor() — guard clauses', () => {
  beforeEach(() => { vi.clearAllMocks(); setupFsMocks(); });

  it('returns disabled status when disabled', async () => {
    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, enabled: false },
    });
    expect(result).toEqual({ findings: [], status: { outcome: 'disabled' } });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns complete empty result when changedFiles is null', async () => {
    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  null,
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });
    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns complete empty result when changedFiles is empty', async () => {
    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });
    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns complete empty result when no lockfile is in changedFiles', async () => {
    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  ['src/app.js', 'src/utils.ts'],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });
    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('propagates a pre-existing parent cancellation without starting work', async () => {
    const controller = new AbortController();
    const reason = new Error('scan cancelled');
    controller.abort(reason);

    await expect(runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: ENABLED,
      signal: controller.signal,
    })).rejects.toBe(reason);
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

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });
    const { findings } = result;

    expect(result.status).toEqual({ outcome: 'complete' });
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

    const findings = await runFindings({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, checkAbandoned: false, checkDeprecated: false },
    });

    expect(findings).toEqual([]);
  });

  it('does not report baseline-dependent CVEs when the base OSV scan fails', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{
      name: 'lodash', version: '4.17.11', ecosystem: 'npm',
      vulns: [{ id: 'CVE-2020-8203', severity: 'HIGH' }],
    }]), 1);
    stubOsvNotFound();
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'lodash', version: '4.17.11' }]));

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: { ...ENABLED, checkAbandoned: false, checkDeprecated: false },
    });

    expect(result.findings).toEqual([]);
    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'osv-scanner-unavailable' });
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

    const findings = await runFindings({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, minCveSeverity: 'high' },
    });

    const cveFinding = findings.find(f => f.ruleId.startsWith('CVE'));
    expect(cveFinding).toBeUndefined();
  });

  it('derives severity from a standard OSV CVSS vector', async () => {
    const output = JSON.stringify({
      results: [{
        source: { path: WORKSPACE, type: 'lockfile' },
        packages: [{
          package: { name: 'lodash', version: '4.17.11', ecosystem: 'npm' },
          vulnerabilities: [{
            id: 'CVE-2026-9999',
            severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
          }],
        }],
      }],
    });
    stubGitShow(buildOsvOutput([]));
    stubOsv(output, 1);
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('lodash');
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'lodash', version: '4.17.11' }]));

    const findings = await runFindings({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: { ...ENABLED, minCveSeverity: 'critical' },
    });

    expect(findings.find(finding => finding.ruleId === 'CVE-2026-9999')).toMatchObject({ severity: 'critical' });
  });

  it('treats all packages as new when the base lockfile does not exist', async () => {
    stubGitShowMissing();                        // no base lockfile
    stubOsv(buildOsvOutput([{
      name: 'express', version: '4.18.0', ecosystem: 'npm',
      vulns: [{ id: 'CVE-2024-1', severity: 'CRITICAL' }],
    }]), 1);
    stubNpmRegistry('express');
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'express', version: '4.18.0' }]));

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, minCveSeverity: 'critical' },
    });

    expect(result.findings.some(f => f.ruleId === 'CVE-2024-1')).toBe(true);
    expect(result.status).toEqual({ outcome: 'complete' });
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

    const findings = await runFindings({
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

  it('returns incomplete when osv-scanner is not installed', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsvNotFound();                           // ENOENT for head scan
    mockReadFile.mockResolvedValue('');

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, checkAbandoned: false, checkDeprecated: false },
    });

    expect(result).toEqual({
      findings: [],
      status: { outcome: 'incomplete', reason: 'osv-scanner-unavailable' },
    });
  });

  it('marks invalid JSON output incomplete', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv('not json');

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, checkDeprecated: false, checkAbandoned: false },
    });

    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'osv-invalid-output' });
  });

  it.each([
    '{}',
    '{"results":[{}]}',
    '{"results":[{"packages":[{}]}]}',
  ])('marks structurally incomplete OSV output incomplete: %s', async (output) => {
    stubGitShowMissing();
    stubOsv(output);
    mockReadFile.mockResolvedValue(buildPkgLock([]));

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: { ...ENABLED, checkAbandoned: false, checkDeprecated: false },
    });

    expect(result).toEqual({ findings: [], status: { outcome: 'incomplete', reason: 'osv-invalid-output' } });
  });

  it('preserves successful health findings when osv-scanner is unavailable', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsvNotFound();
    stubNpmRegistry('old-lib', { lastPublishDaysAgo: 800 });
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'old-lib', version: '1.0.0' }]));

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: ENABLED,
    });

    expect(result.findings.some(f => f.ruleId === 'abandoned/deprecated')).toBe(true);
    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'osv-scanner-unavailable' });
  });

  it('marks an unexpected osv-scanner exit incomplete', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([]), 2);

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: { ...ENABLED, checkDeprecated: false, checkAbandoned: false },
    });

    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'osv-unexpected-exit' });
  });

  it('marks an unreadable selected lockfile incomplete without starting subprocesses', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('permission denied'));

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: ENABLED,
    });

    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'lockfile-unreadable' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('marks unexpected base git failures incomplete', async () => {
    stubGitShowFailure();

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: { ...ENABLED, checkDeprecated: false, checkAbandoned: false },
    });

    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'base-git-failed' });
    expect(result.findings).toEqual([]);
    expect(mockExecFile).toHaveBeenCalledOnce();
  });

  it('does not swallow unexpected programming errors', async () => {
    stubGitShow(buildOsvOutput([]));
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => cb(new Error('unexpected bug'), '', '')
    );

    await expect(runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: { ...ENABLED, checkDeprecated: false, checkAbandoned: false },
    })).rejects.toThrow('unexpected bug');
  });

  it('passes the signal to child processes and does not swallow cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('scan cancelled');
    mockExecFile
      .mockImplementationOnce((_cmd: string, _args: string[], opts: { signal?: AbortSignal }, cb: ExecCb) => {
        expect(opts.signal).toBe(controller.signal);
        cb(null, '', '');
      })
      .mockImplementationOnce((_cmd: string, _args: string[], opts: { signal?: AbortSignal }, cb: ExecCb) => {
        expect(opts.signal).toBe(controller.signal);
        controller.abort(reason);
        cb(new Error('process aborted'), '', '');
      });

    await expect(runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: { ...ENABLED, checkAbandoned: false, checkDeprecated: false },
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
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

    const findings = await runFindings({
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

    const findings = await runFindings({
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

    const findings = await runFindings({
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

    const findings = await runFindings({
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

  it('preserves CVE findings and returns incomplete when npm registry returns non-200', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{
      name: 'some-pkg', version: '1.0.0', ecosystem: 'npm',
      vulns: [{ id: 'CVE-2026-1', severity: 'HIGH' }],
    }]), 1);
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('some-pkg', { ok: false });
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'some-pkg', version: '1.0.0' }]));

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    expect(result.findings.some(f => f.ruleId === 'CVE-2026-1')).toBe(true);
    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'registry-request-failed' });
  });

  it('returns incomplete when an enabled registry request throws', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{ name: 'some-pkg', version: '1.0.0', ecosystem: 'npm' }]));
    stubOsv(buildOsvOutput([]));
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'some-pkg', version: '1.0.0' }]));

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'registry-request-failed' });
  });

  it('combines the parent signal with the registry deadline and propagates cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('scan cancelled');
    stubGitShowMissing();
    stubOsv(buildOsvOutput([{ name: 'some-pkg', version: '1.0.0', ecosystem: 'npm' }]));
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'some-pkg', version: '1.0.0' }]));
    mockFetch.mockImplementationOnce(async (_url: string, init: { signal?: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal).not.toBe(controller.signal);
      controller.abort(reason);
      throw new Error('request aborted');
    });

    await expect(runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: ENABLED,
      signal: controller.signal,
    })).rejects.toBe(reason);
  });

  it('returns an abandoned finding for a PyPI package with no publish in 2+ years', async () => {
    stubGitShow(buildOsvOutput([]));
    stubOsv(buildOsvOutput([{ name: 'old-pylib', version: '1.0.0', ecosystem: 'PyPI' }]));
    stubOsv(buildOsvOutput([]));
    stubPypiRegistry('old-pylib', { lastPublishDaysAgo: 800 });
    mockReadFile.mockResolvedValue(buildRequirementsTxt([{ name: 'old-pylib', version: '1.0.0' }]));

    const findings = await runFindings({
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

    const findings = await runFindings({
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

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  ['go.sum'],
      baseSha:       BASE_SHA,
      toolConfig:    ENABLED,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.status).toEqual({ outcome: 'complete' });
  });

  it.each(HEALTH_FORMAT_FIXTURES)('health-checks a new dependency from $filename', async fixture => {
    stubGitShowMissing();
    stubOsv(buildOsvOutput([]));
    if (fixture.registry === 'npm') stubNpmRegistry(fixture.packageName, { lastPublishDaysAgo: 800 });
    else stubPypiRegistry(fixture.packageName, { lastPublishDaysAgo: 800 });
    mockReadFile.mockResolvedValue(fixture.content);

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [fixture.filename],
      baseSha: BASE_SHA,
      toolConfig: ENABLED,
    });

    expect(result.status).toEqual({ outcome: 'complete' });
    expect(result.findings).toEqual([
      expect.objectContaining({
        file: fixture.filename,
        line: fixture.line,
        message: expect.stringContaining(`${fixture.packageName}@1.0.0`),
      }),
    ]);
  });

  it('does not recheck a pnpm package/version pair present at merge base', async () => {
    const content = HEALTH_FORMAT_FIXTURES[0].content;
    stubGitShow(content);
    stubOsv(buildOsvOutput([]));
    stubOsv(buildOsvOutput([]));
    mockReadFile.mockResolvedValue(content);

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: ['pnpm-lock.yaml'],
      baseSha: BASE_SHA,
      toolConfig: ENABLED,
    });

    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('loads a renamed lockfile baseline from its old path', async () => {
    const content = HEALTH_FORMAT_FIXTURES[0].content;
    mockExecFile.mockImplementationOnce(
      (_cmd: string, args: string[], _opts: unknown, cb: ExecCb) => {
        expect(args.at(-1)).toBe('base-sha-abc:config/old-pnpm-lock.yaml');
        cb(null, content, '');
      },
    );
    stubOsv(buildOsvOutput([]));
    stubOsv(buildOsvOutput([]));
    mockReadFile.mockResolvedValue(content);

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: ['pnpm-lock.yaml'],
      basePaths: { 'pnpm-lock.yaml': 'config/old-pnpm-lock.yaml' },
      baseSha: BASE_SHA,
      toolConfig: ENABLED,
    });

    expect(result).toEqual({ findings: [], status: { outcome: 'complete' } });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('marks an invalid health baseline incomplete instead of treating every package as new', async () => {
    stubGitShow("lockfileVersion: '10.0'\npackages: {}\n");
    stubOsv(buildOsvOutput([]));
    stubOsv(buildOsvOutput([]));
    mockReadFile.mockResolvedValue(HEALTH_FORMAT_FIXTURES[0].content);

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: ['pnpm-lock.yaml'],
      baseSha: BASE_SHA,
      toolConfig: ENABLED,
    });

    expect(result).toEqual({
      findings: [],
      status: { outcome: 'incomplete', reason: 'lockfile-version-unsupported' },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports both abandoned and deprecated states from one registry response', async () => {
    stubGitShowMissing();
    stubOsv(buildOsvOutput([]));
    stubNpmRegistry('old-lib', { deprecated: 'Use maintained-lib', lastPublishDaysAgo: 800 });
    mockReadFile.mockResolvedValue(buildPkgLock([{ name: 'old-lib', version: '1.0.0' }]));

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [LOCKFILE],
      baseSha: BASE_SHA,
      toolConfig: ENABLED,
    });

    expect(result.findings).toHaveLength(2);
    expect(result.findings.some(finding => finding.message.includes('appears abandoned'))).toBe(true);
    expect(result.findings.some(finding => finding.message.includes('is deprecated'))).toBe(true);
  });

  it('marks an omitted lockfile incomplete without starting subprocesses', async () => {
    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles: [],
      omittedFiles: ['pnpm-lock.yaml'],
      baseSha: BASE_SHA,
      toolConfig: ENABLED,
    });

    expect(result).toEqual({
      findings: [],
      status: { outcome: 'incomplete', reason: 'lockfile-size-limit-exceeded' },
    });
    expect(mockExecFile).not.toHaveBeenCalled();
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

    const findings = await runFindings({
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

    const findings = await runFindings({
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
    expect(mockRm).toHaveBeenCalledOnce();

    const writePath = (mockWriteFile as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(writePath).toContain(WORKSPACE);
  });

  it('still deletes the temp file even when the base osv-scanner call throws', async () => {
    const pkgOutput = buildOsvOutput([{ name: 'lodash', version: '4.17.11', ecosystem: 'npm' }]);
    stubGitShow(pkgOutput);                      // base content exists
    stubOsv(pkgOutput);                          // head scan ok
    stubOsvNotFound();                           // base scan fails with ENOENT
    mockReadFile.mockResolvedValue('');

    const result = await runDepDoctor({
      workspacePath: WORKSPACE,
      changedFiles:  [LOCKFILE],
      baseSha:       BASE_SHA,
      toolConfig:    { ...ENABLED, checkAbandoned: false, checkDeprecated: false },
    });

    expect(mockRm).toHaveBeenCalledOnce();
    expect(result.status).toEqual({ outcome: 'incomplete', reason: 'osv-scanner-unavailable' });
  });
});
