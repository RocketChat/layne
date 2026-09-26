import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { DEFAULT_CONFIG } from '../config.js';
import { debug } from '../debug.js';
import type { AdapterResult, DepDoctorConfig, DepDoctorFinding, Severity } from '../types.js';
import {
  canonicalizePackageName,
  isDependencyLockfile,
  lockedPackageKey,
  parseDependencyLockfile,
  supportsDependencyHealth,
  type DependencyEcosystem,
  type LockedPackage,
  type LockfileParseResult,
} from './dep-doctor-lockfiles.js';
import { exec, throwIfAborted } from './helpers.js';

// ---------------------------------------------------------------------------
// Lockfile detection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OSV-Scanner output types
// ---------------------------------------------------------------------------

interface OsvPackage {
  name:      string;
  version:   string;
  ecosystem: string;
}

interface OsvVuln {
  id:                 string;
  database_specific?: { severity?: string };
  severity?:          Array<{ type?: string; score?: string }>;
}

interface OsvParsedEntry {
  pkg:   OsvPackage;
  vulns: OsvVuln[];
}

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

const OSV_SEVERITY_MAP: Record<string, Severity> = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MODERATE: 'medium',
  MEDIUM:   'medium',
  LOW:      'low',
};

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4, high: 3, medium: 2, low: 1, info: 0,
};

function meetsSeverityThreshold(actual: Severity, minimum: Severity): boolean {
  return SEVERITY_ORDER[actual] >= SEVERITY_ORDER[minimum];
}

function severityFromScore(score: number): Severity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'info';
}

function cvssV3BaseScore(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const metrics: Record<string, string> = {};
  for (const metric of vector.split('/').slice(1)) {
    const [name, value] = metric.split(':', 2);
    if (name && value) metrics[name] = value;
  }
  const scopeChanged = metrics.S === 'C';
  const av = ({ N: .85, A: .62, L: .55, P: .2 } as Record<string, number>)[metrics.AV ?? ''];
  const ac = ({ L: .77, H: .44 } as Record<string, number>)[metrics.AC ?? ''];
  const pr = (scopeChanged
    ? { N: .85, L: .68, H: .5 }
    : { N: .85, L: .62, H: .27 } as Record<string, number>)[metrics.PR ?? ''];
  const ui = ({ N: .85, R: .62 } as Record<string, number>)[metrics.UI ?? ''];
  const impactMetric = { H: .56, L: .22, N: 0 } as Record<string, number>;
  const confidentiality = impactMetric[metrics.C ?? ''];
  const integrity = impactMetric[metrics.I ?? ''];
  const availability = impactMetric[metrics.A ?? ''];
  if ([av, ac, pr, ui, confidentiality, integrity, availability].some(value => value === undefined)) return null;

  const impactSubScore = 1 - (1 - confidentiality!) * (1 - integrity!) * (1 - availability!);
  const impact = scopeChanged
    ? 7.52 * (impactSubScore - .029) - 3.25 * ((impactSubScore - .02) ** 15)
    : 6.42 * impactSubScore;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  const rawScore = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  return Math.ceil((rawScore - Number.EPSILON) * 10) / 10;
}

function osvSeverity(vuln: OsvVuln): Severity {
  const databaseSeverity = vuln.database_specific?.severity?.toUpperCase() ?? '';
  if (OSV_SEVERITY_MAP[databaseSeverity]) return OSV_SEVERITY_MAP[databaseSeverity];

  const scores = (vuln.severity ?? []).flatMap(({ type, score }) => {
    if (!score || !type?.startsWith('CVSS_')) return [];
    const numericScore = Number(score);
    const parsedScore = Number.isFinite(numericScore) ? numericScore : cvssV3BaseScore(score);
    return parsedScore === null ? [] : [parsedScore];
  });
  return scores.length > 0 ? severityFromScore(Math.max(...scores)) : 'high';
}

// ---------------------------------------------------------------------------
// Exported adapter entry point
// ---------------------------------------------------------------------------

export async function runDepDoctor({
  workspacePath,
  changedFiles,
  baseSha,
  toolConfig = DEFAULT_CONFIG.depDoctor,
  omittedFiles = [],
  basePaths = {},
  signal,
}: {
  workspacePath: string;
  changedFiles?: string[] | null;
  baseSha: string;
  toolConfig?: DepDoctorConfig;
  omittedFiles?: string[];
  basePaths?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<AdapterResult<DepDoctorFinding>> {
  throwIfAborted(signal);
  if (!toolConfig.enabled) return { findings: [], status: { outcome: 'disabled' } };
  if (!changedFiles?.length) {
    return omittedFiles.some(file => isDependencyLockfile(basename(file)))
      ? { findings: [], status: { outcome: 'incomplete', reason: 'lockfile-size-limit-exceeded' } }
      : { findings: [], status: { outcome: 'complete' } };
  }

  const lockfiles = changedFiles.filter(file => isDependencyLockfile(basename(file)));
  const omittedLockfiles = omittedFiles.filter(file => isDependencyLockfile(basename(file)));
  if (lockfiles.length === 0) {
    return omittedLockfiles.length > 0
      ? { findings: [], status: { outcome: 'incomplete', reason: 'lockfile-size-limit-exceeded' } }
      : { findings: [], status: { outcome: 'complete' } };
  }

  debug('dep-doctor', `scanning ${lockfiles.length} lockfile(s): ${lockfiles.join(', ')}`);

  const healthCache = new Map<string, Promise<HealthResult>>();
  const results = await Promise.all(
    lockfiles.map(lf => processLockfile(lf, basePaths[lf] ?? lf, workspacePath, baseSha, toolConfig, healthCache, signal))
  );
  throwIfAborted(signal);
  const findings = results.flatMap(result => result.findings);
  const incompleteReason = results.find(result => result.incompleteReason)?.incompleteReason
    ?? (omittedLockfiles.length > 0 ? 'lockfile-size-limit-exceeded' : undefined);

  console.log(`[dep-doctor] ${findings.length} finding(s) across ${lockfiles.length} lockfile(s)`);
  for (const f of findings) {
    console.log(`[dep-doctor]   ${f.severity.toUpperCase()} ${f.file}:${f.line} [${f.ruleId}] ${f.message}`);
  }
  return {
    findings,
    status: incompleteReason
      ? { outcome: 'incomplete', reason: incompleteReason }
      : { outcome: 'complete' },
  };
}

// ---------------------------------------------------------------------------
// Per-lockfile processing
// ---------------------------------------------------------------------------

async function processLockfile(
  lockfilePath: string,
  baseLockfilePath: string,
  workspacePath: string,
  baseSha: string,
  toolConfig: DepDoctorConfig,
  healthCache: Map<string, Promise<HealthResult>>,
  signal?: AbortSignal,
): Promise<{ findings: DepDoctorFinding[]; incompleteReason?: string }> {
  throwIfAborted(signal);
  const absPath = join(workspacePath, lockfilePath);
  let incompleteReason: string | undefined;

  let headLockfileContent: string;
  try {
    headLockfileContent = await readFile(absPath, 'utf8');
  } catch (err) {
    throwIfAborted(signal);
    console.error(`[dep-doctor] failed to read selected lockfile ${lockfilePath}: ${(err as Error).message}`);
    return { findings: [], incompleteReason: 'lockfile-unreadable' };
  }

  // A — get base lockfile content
  let baseLockfileContent: string | null = null;
  try {
    baseLockfileContent = await gitShow(workspacePath, baseSha, baseLockfilePath, signal);
  } catch (err) {
    throwIfAborted(signal);
    if (isMissingGitPathError(err)) {
      debug('dep-doctor', `${lockfilePath}: no base version (new file) — treating all packages as new`);
    } else {
      incompleteReason = 'base-git-failed';
      console.error(`[dep-doctor] failed to read base version of ${lockfilePath}: ${(err as Error).message}`);
      return { findings: [], incompleteReason };
    }
  }

  const healthEnabled = supportsDependencyHealth(basename(absPath))
    && (toolConfig.checkAbandoned || toolConfig.checkDeprecated);
  let headInventory: LockfileParseResult | null = null;
  let baseInventory: LockfileParseResult | null = null;
  if (healthEnabled) {
    headInventory = parseDependencyLockfile(headLockfileContent, basename(absPath));
    if (!headInventory.ok) {
      incompleteReason ??= headInventory.reason;
      console.error(`[dep-doctor] failed to parse ${lockfilePath} for health checks: ${headInventory.detail}`);
    }
    if (baseLockfileContent !== null) {
      baseInventory = parseDependencyLockfile(baseLockfileContent, basename(absPath));
      if (!baseInventory.ok) {
        incompleteReason ??= baseInventory.reason;
        console.error(`[dep-doctor] failed to parse base ${lockfilePath} for health checks: ${baseInventory.detail}`);
      }
    }
  }

  // B — run OSV-Scanner on head lockfile
  let headParsed: OsvParsedEntry[] = [];
  let headScanSucceeded = false;
  try {
    const { stdout, stderr, exitCode } = await exec('osv-scanner', [
      'scan', '--lockfile', absPath, '--format', 'json',
      ...(toolConfig.extraArgs ?? []),
    ], { signal });
    if (exitCode === 0 || exitCode === 1) {
      const parsed = parseOsvOutput(stdout);
      if (parsed) {
        headParsed = parsed;
        headScanSucceeded = true;
      } else {
        incompleteReason ??= 'osv-invalid-output';
      }
    } else {
      incompleteReason ??= 'osv-unexpected-exit';
      console.error(`[dep-doctor] osv-scanner exited with code ${exitCode} for ${lockfilePath}${stderr ? `: ${stderr.trim()}` : ''}`);
    }
  } catch (err) {
    throwIfAborted(signal);
    if (typeof (err as NodeJS.ErrnoException).code !== 'string') throw err;
    incompleteReason ??= 'osv-scanner-unavailable';
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn('[dep-doctor] osv-scanner not found in PATH — install it to enable CVE scanning');
    } else {
      console.error(`[dep-doctor] osv-scanner failed for ${lockfilePath}: ${(err as Error).message}`);
    }
  }

  throwIfAborted(signal);
  if (headParsed.length === 0 && !toolConfig.checkAbandoned && !toolConfig.checkDeprecated) {
    return { findings: [], incompleteReason };
  }

  // C — run OSV-Scanner on base lockfile (if it exists) to build the baseline package set
  let basePackageSet = new Set<string>();
  let baseScanSucceeded = baseLockfileContent === null;
  if (baseLockfileContent !== null && headScanSucceeded) {
    // Use a unique subdirectory so the file retains its original basename (e.g. yarn.lock).
    // OSV-Scanner v2 detects lockfile type by exact filename match, so the name must be
    // preserved — a random suffix on the filename itself breaks detection.
    const tempSubDir = await mkdtemp(join(workspacePath, '.layne-dep-doctor-'));
    const tempPath   = join(tempSubDir, basename(absPath));
    try {
      throwIfAborted(signal);
      await writeFile(tempPath, baseLockfileContent, 'utf8');
      throwIfAborted(signal);
      try {
        const { stdout, stderr, exitCode } = await exec('osv-scanner', [
          'scan', '--lockfile', tempPath, '--format', 'json',
          ...(toolConfig.extraArgs ?? []),
        ], { signal });
        if (exitCode === 0 || exitCode === 1) {
          const parsed = parseOsvOutput(stdout);
          if (parsed) {
            basePackageSet = buildPackageSet(parsed);
            baseScanSucceeded = true;
          } else {
            incompleteReason ??= 'osv-invalid-output';
          }
        } else {
          incompleteReason ??= 'osv-unexpected-exit';
          console.error(`[dep-doctor] base osv-scanner exited with code ${exitCode} for ${lockfilePath}${stderr ? `: ${stderr.trim()}` : ''}`);
        }
      } catch (err) {
        throwIfAborted(signal);
        if (typeof (err as NodeJS.ErrnoException).code !== 'string') throw err;
        incompleteReason ??= 'osv-scanner-unavailable';
        debug('dep-doctor', `base scan unavailable for ${lockfilePath}; suppressing baseline-dependent vulnerability findings: ${(err as Error).message}`);
      }
    } finally {
      try { await rm(tempSubDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // D + E — CVE findings for new packages only
  const findings: DepDoctorFinding[] = [];
  const seen = new Set<string>();

  for (const { pkg, vulns } of baseScanSucceeded ? headParsed : []) {
    throwIfAborted(signal);
    const pkgKey = osvPackageKey(pkg);
    if (basePackageSet.has(pkgKey)) continue; // pre-existing dep

    for (const vuln of vulns) {
      const dedupeKey = `${lockfilePath}:${pkgKey}:${vuln.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const severity = osvSeverity(vuln);
      if (!meetsSeverityThreshold(severity, toolConfig.minCveSeverity)) continue;

      const line = findOsvPackageLine(pkg, headInventory, headLockfileContent, basename(absPath));
      findings.push({
        file:     lockfilePath,
        line,
        severity,
        message:  `New dependency ${pkg.name}@${pkg.version} has ${severity.toUpperCase()} vulnerability ${vuln.id}`,
        ruleId:   vuln.id,
        tool:     'dep-doctor',
      });
    }
  }

  // F — registry health checks (all new packages, from direct lockfile parse)
  // We parse the lockfile directly rather than using headParsed (OSV output) so that
  // packages with no CVEs — e.g. abandoned ones — are still health-checked.
  if (healthEnabled && headInventory?.ok && (baseLockfileContent === null || baseInventory?.ok)) {
    const baseHealthKeys = new Set(
      baseInventory?.ok ? baseInventory.packages.map(lockedPackageKey) : [],
    );
    const newPackages = headInventory.packages.filter(pkg => !baseHealthKeys.has(lockedPackageKey(pkg)));

    const BATCH = 5;
    for (let i = 0; i < newPackages.length; i += BATCH) {
      throwIfAborted(signal);
      const batch = newPackages.slice(i, i + BATCH);
      const healthResults = await Promise.all(
        batch.map(pkg => checkPackageHealthCached(pkg, toolConfig, healthCache, signal))
      );
      throwIfAborted(signal);

      for (let j = 0; j < batch.length; j++) {
        const pkg    = batch[j]!;
        const health = healthResults[j]!;
        const line   = pkg.line;

        if (health.requestFailed) incompleteReason ??= 'registry-request-failed';

        if (health.abandoned && toolConfig.checkAbandoned) {
          findings.push({
            file:     lockfilePath,
            line,
            severity: 'medium',
            message:  `New dependency ${pkg.name}@${pkg.version} appears abandoned. ${health.abandonedReason}`,
            ruleId:   'abandoned/deprecated',
            tool:     'dep-doctor',
          });
        }
        if (health.deprecated && toolConfig.checkDeprecated) {
          findings.push({
            file:     lockfilePath,
            line,
            severity: 'medium',
            message:  `New dependency ${pkg.name}@${pkg.version} is deprecated. ${health.deprecatedReason}`,
            ruleId:   'abandoned/deprecated',
            tool:     'dep-doctor',
          });
        }
      }
    }
  }

  throwIfAborted(signal);
  return { findings, incompleteReason };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gitShow(workspacePath: string, sha: string, filePath: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      throwIfAborted(signal);
    } catch (err) {
      reject(err);
      return;
    }
    execFile(
      'git', ['-C', workspacePath, 'show', `${sha}:${filePath}`],
      { maxBuffer: 50 * 1024 * 1024, encoding: 'utf8', signal },
      (err, stdout, stderr) => {
        try {
          throwIfAborted(signal);
        } catch (abortErr) {
          reject(abortErr);
          return;
        }
        if (err) {
          const gitError = err as Error & { stderr?: string };
          if (!gitError.stderr && stderr) gitError.stderr = stderr as string;
          reject(gitError);
        }
        else resolve(stdout as string);
      },
    );
  });
}

function isMissingGitPathError(err: unknown): boolean {
  const error = err as { message?: string; stderr?: string };
  const output = `${error.message ?? ''}\n${error.stderr ?? ''}`;
  return /path (?:.+ )?(?:does not exist in|exists on disk, but not in|not found in commit)/i.test(output);
}

function parseOsvOutput(stdout: string): OsvParsedEntry[] | null {
  if (!stdout.trim()) {
    console.error('[dep-doctor] Failed to parse OSV-Scanner JSON output');
    return null;
  }
  try {
    const raw = JSON.parse(stdout) as {
      results?: Array<{
        packages?: Array<{
          package?:        OsvPackage;
          vulnerabilities?: OsvVuln[];
        }>;
      }>;
    };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.results)) {
      throw new Error('invalid OSV output shape');
    }
    const entries: OsvParsedEntry[] = [];
    for (const result of raw.results) {
      if (!result || typeof result !== 'object' || !Array.isArray(result.packages)) {
        throw new Error('invalid OSV result shape');
      }
      for (const pkg of result.packages) {
        if (!pkg || typeof pkg !== 'object' || !pkg.package) {
          throw new Error('invalid OSV package entry');
        }
        if (
          typeof pkg.package !== 'object'
          || typeof pkg.package.name !== 'string'
          || typeof pkg.package.version !== 'string'
          || typeof pkg.package.ecosystem !== 'string'
        ) {
          throw new Error('invalid OSV package shape');
        }
        if (pkg.vulnerabilities !== undefined && !Array.isArray(pkg.vulnerabilities)) {
          throw new Error('invalid OSV vulnerabilities shape');
        }
        if ((pkg.vulnerabilities ?? []).some(vuln => !vuln || typeof vuln !== 'object' || typeof vuln.id !== 'string')) {
          throw new Error('invalid OSV vulnerability shape');
        }
        entries.push({ pkg: pkg.package, vulns: pkg.vulnerabilities ?? [] });
      }
    }
    return entries;
  } catch {
    console.error('[dep-doctor] Failed to parse OSV-Scanner JSON output');
    return null;
  }
}

function buildPackageSet(entries: OsvParsedEntry[]): Set<string> {
  return new Set(entries.map(({ pkg }) => osvPackageKey(pkg)));
}

function osvEcosystem(ecosystem: string): DependencyEcosystem | null {
  const normalized = ecosystem.toLowerCase();
  if (normalized === 'npm') return 'npm';
  if (normalized === 'pypi') return 'PyPI';
  return null;
}

function osvPackageKey(pkg: OsvPackage): string {
  const ecosystem = osvEcosystem(pkg.ecosystem);
  return ecosystem
    ? `${ecosystem}:${canonicalizePackageName(ecosystem, pkg.name)}@${pkg.version}`
    : `${pkg.ecosystem}:${pkg.name}@${pkg.version}`;
}

function findOsvPackageLine(
  pkg: OsvPackage,
  inventory: LockfileParseResult | null,
  content: string,
  filename: string,
): number {
  const ecosystem = osvEcosystem(pkg.ecosystem);
  if (ecosystem && inventory?.ok) {
    const canonicalName = canonicalizePackageName(ecosystem, pkg.name);
    const exact = inventory.packages.find(candidate =>
      candidate.ecosystem === ecosystem
      && candidate.canonicalName === canonicalName
      && candidate.version === pkg.version
    );
    if (exact) return exact.line;
    const byName = inventory.packages.find(candidate =>
      candidate.ecosystem === ecosystem && candidate.canonicalName === canonicalName
    );
    if (byName) return byName.line;
  }
  return findLineInLockfile(content, filename, pkg.name);
}

function findLineInLockfile(content: string, file: string, packageName: string): number {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern: RegExp;

  if (file === 'package-lock.json') {
    pattern = new RegExp(`"node_modules/${escaped}"`);
  } else if (file === 'yarn.lock') {
    pattern = new RegExp(`^"?${escaped}@`, 'm');
  } else if (file === 'requirements.txt') {
    pattern = new RegExp(`^${escaped}`, 'im');
  } else if (file === 'go.sum') {
    pattern = new RegExp(`^${escaped} `, 'm');
  } else {
    pattern = new RegExp(escaped, 'i');
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i] ?? '')) return i + 1;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Registry health checks
// ---------------------------------------------------------------------------

interface HealthResult {
  abandoned:  boolean;
  deprecated: boolean;
  abandonedReason: string;
  deprecatedReason: string;
  requestFailed: boolean;
}

function checkPackageHealthCached(
  pkg: LockedPackage,
  config: DepDoctorConfig,
  cache: Map<string, Promise<HealthResult>>,
  signal?: AbortSignal,
): Promise<HealthResult> {
  const key = lockedPackageKey(pkg);
  const existing = cache.get(key);
  if (existing) return existing;
  const request = checkPackageHealth(pkg, config, signal);
  cache.set(key, request);
  return request;
}

async function checkPackageHealth(pkg: LockedPackage, config: DepDoctorConfig, signal?: AbortSignal): Promise<HealthResult> {
  throwIfAborted(signal);
  if (pkg.ecosystem === 'npm') return checkNpmHealth(pkg.name, pkg.version, config, signal);
  return checkPypiHealth(pkg.canonicalName, config, signal);
}

async function checkNpmHealth(name: string, version: string, config: DepDoctorConfig, signal?: AbortSignal): Promise<HealthResult> {
  try {
    throwIfAborted(signal);
    const url  = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'layne-dep-doctor/1.0' },
      signal:  requestSignal,
    });
    throwIfAborted(signal);
    if (!resp.ok) return { abandoned: false, deprecated: false, abandonedReason: '', deprecatedReason: '', requestFailed: true };

    const data = await resp.json() as {
      time?:     Record<string, string>;
      versions?: Record<string, { deprecated?: string }>;
    };

    const deprecatedMessage = config.checkDeprecated ? data.versions?.[version]?.deprecated : undefined;
    let abandoned = false;
    let abandonedReason = '';

    if (config.checkAbandoned) {
      const times = Object.entries(data.time ?? {})
        .filter(([k]) => k !== 'created' && k !== 'modified')
        .map(([, v]) => new Date(v).getTime())
        .filter(t => !isNaN(t));

      if (times.length > 0) {
        const lastPublish  = Math.max(...times);
        const daysSince    = (Date.now() - lastPublish) / (1000 * 60 * 60 * 24);
        if (daysSince > config.abandonedDays) {
          const lastDate = new Date(lastPublish).toISOString().slice(0, 10);
          abandoned = true;
          abandonedReason = `Last published: ${lastDate}`;
        }
      }
    }

    return {
      abandoned,
      deprecated: Boolean(deprecatedMessage),
      abandonedReason,
      deprecatedReason: deprecatedMessage ? String(deprecatedMessage).slice(0, 200) : '',
      requestFailed: false,
    };
  } catch (err) {
    throwIfAborted(signal);
    debug('dep-doctor', `npm registry check failed for ${name}: ${(err as Error).message}`);
    return { abandoned: false, deprecated: false, abandonedReason: '', deprecatedReason: '', requestFailed: true };
  }
}

async function checkPypiHealth(name: string, config: DepDoctorConfig, signal?: AbortSignal): Promise<HealthResult> {
  try {
    throwIfAborted(signal);
    const url  = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'layne-dep-doctor/1.0' },
      signal:  requestSignal,
    });
    throwIfAborted(signal);
    if (!resp.ok) return { abandoned: false, deprecated: false, abandonedReason: '', deprecatedReason: '', requestFailed: true };

    const data = await resp.json() as {
      info?:     { classifiers?: string[] };
      releases?: Record<string, Array<{ upload_time_iso_8601?: string }>>;
    };

    const inactive = config.checkDeprecated
      && (data.info?.classifiers ?? []).some(c =>
        c.includes('Development Status :: 7 - Inactive') || c.toLowerCase().includes('deprecated')
      );
    let abandoned = false;
    let abandonedReason = '';

    if (config.checkAbandoned) {
      const allDates: number[] = [];
      for (const files of Object.values(data.releases ?? {})) {
        for (const f of files) {
          if (f.upload_time_iso_8601) {
            const t = new Date(f.upload_time_iso_8601).getTime();
            if (!isNaN(t)) allDates.push(t);
          }
        }
      }
      if (allDates.length > 0) {
        const lastPublish = Math.max(...allDates);
        const daysSince   = (Date.now() - lastPublish) / (1000 * 60 * 60 * 24);
        if (daysSince > config.abandonedDays) {
          const lastDate = new Date(lastPublish).toISOString().slice(0, 10);
          abandoned = true;
          abandonedReason = `Last published: ${lastDate}`;
        }
      }
    }

    return {
      abandoned,
      deprecated: inactive,
      abandonedReason,
      deprecatedReason: inactive ? 'Package marked inactive/deprecated' : '',
      requestFailed: false,
    };
  } catch (err) {
    throwIfAborted(signal);
    debug('dep-doctor', `PyPI registry check failed for ${name}: ${(err as Error).message}`);
    return { abandoned: false, deprecated: false, abandonedReason: '', deprecatedReason: '', requestFailed: true };
  }
}
