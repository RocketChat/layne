import { execFile } from 'child_process';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { DEFAULT_CONFIG } from '../config.js';
import { debug } from '../debug.js';
import type { DepDoctorConfig, DepDoctorFinding, Severity } from '../types.js';
import { exec } from './helpers.js';

// ---------------------------------------------------------------------------
// Lockfile detection
// ---------------------------------------------------------------------------

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'requirements.txt',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'go.sum',
]);

type Ecosystem = 'npm' | 'PyPI' | 'Go';

const LOCKFILE_ECOSYSTEM: Record<string, Ecosystem> = {
  'package-lock.json': 'npm',
  'yarn.lock':         'npm',
  'pnpm-lock.yaml':    'npm',
  'requirements.txt':  'PyPI',
  'Pipfile.lock':      'PyPI',
  'poetry.lock':       'PyPI',
  'uv.lock':           'PyPI',
  'go.sum':            'Go',
};

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
}

interface OsvParsedEntry {
  pkg:   OsvPackage;
  vulns: OsvVuln[];
}

interface DirectPackage {
  name:      string;
  version:   string;
  ecosystem: Ecosystem;
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

// ---------------------------------------------------------------------------
// Exported adapter entry point
// ---------------------------------------------------------------------------

export async function runDepDoctor({
  workspacePath,
  changedFiles,
  baseSha,
  toolConfig = DEFAULT_CONFIG.depDoctor,
}: {
  workspacePath: string;
  changedFiles?: string[] | null;
  baseSha: string;
  toolConfig?: DepDoctorConfig;
}): Promise<DepDoctorFinding[]> {
  if (!toolConfig.enabled) return [];
  if (!changedFiles?.length) return [];

  const lockfiles = changedFiles.filter(f => LOCKFILE_NAMES.has(basename(f)));
  if (lockfiles.length === 0) return [];

  debug('dep-doctor', `scanning ${lockfiles.length} lockfile(s): ${lockfiles.join(', ')}`);

  const results = await Promise.all(
    lockfiles.map(lf => processLockfile(lf, workspacePath, baseSha, toolConfig))
  );
  const findings = results.flat();

  console.log(`[dep-doctor] ${findings.length} finding(s) across ${lockfiles.length} lockfile(s)`);
  for (const f of findings) {
    console.log(`[dep-doctor]   ${f.severity.toUpperCase()} ${f.file}:${f.line} [${f.ruleId}] ${f.message}`);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Per-lockfile processing
// ---------------------------------------------------------------------------

async function processLockfile(
  lockfilePath: string,
  workspacePath: string,
  baseSha: string,
  toolConfig: DepDoctorConfig,
): Promise<DepDoctorFinding[]> {
  const absPath = join(workspacePath, lockfilePath);

  // A — get base lockfile content
  let baseLockfileContent: string | null = null;
  try {
    baseLockfileContent = await gitShow(workspacePath, baseSha, lockfilePath);
  } catch {
    debug('dep-doctor', `${lockfilePath}: no base version (new file) — treating all packages as new`);
  }

  // B — run OSV-Scanner on head lockfile
  let headOutput = '';
  try {
    headOutput = await exec('osv-scanner', [
      'scan', '--lockfile', absPath, '--format', 'json',
      ...(toolConfig.extraArgs ?? []),
    ]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn('[dep-doctor] osv-scanner not found in PATH — install it to enable CVE scanning');
    } else {
      console.error(`[dep-doctor] osv-scanner failed for ${lockfilePath}: ${(err as Error).message}`);
    }
  }

  const headParsed = parseOsvOutput(headOutput);
  if (headParsed.length === 0 && !toolConfig.checkAbandoned && !toolConfig.checkDeprecated) {
    return [];
  }

  // C — run OSV-Scanner on base lockfile (if it exists) to build the baseline package set
  let basePackageSet = new Set<string>();
  if (baseLockfileContent !== null) {
    const tempDir  = join(workspacePath, '.layne');
    const tempPath = join(tempDir, `dep-doctor-base-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await mkdir(tempDir, { recursive: true });
      await writeFile(tempPath, baseLockfileContent, 'utf8');
      let baseOutput = '';
      try {
        baseOutput = await exec('osv-scanner', [
          'scan', '--lockfile', tempPath, '--format', 'json',
          ...(toolConfig.extraArgs ?? []),
        ]);
      } catch {
        // Base scan failure → treat all head packages as new
      }
      basePackageSet = buildPackageSet(parseOsvOutput(baseOutput));
    } finally {
      try { await unlink(tempPath); } catch { /* ignore */ }
    }
  }

  // D + E — CVE findings for new packages only
  const findings: DepDoctorFinding[] = [];
  const seen = new Set<string>();

  for (const { pkg, vulns } of headParsed) {
    const pkgKey = `${pkg.ecosystem}:${pkg.name}@${pkg.version}`;
    if (basePackageSet.has(pkgKey)) continue; // pre-existing dep

    for (const vuln of vulns) {
      const dedupeKey = `${lockfilePath}:${pkgKey}:${vuln.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const rawSeverity = vuln.database_specific?.severity?.toUpperCase() ?? '';
      const severity: Severity = OSV_SEVERITY_MAP[rawSeverity] ?? 'high';
      if (!meetsSeverityThreshold(severity, toolConfig.minCveSeverity)) continue;

      const line = await findLineInLockfile(absPath, pkg.name);
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
  if (toolConfig.checkAbandoned || toolConfig.checkDeprecated) {
    let headContent = '';
    try {
      headContent = await readFile(absPath, 'utf8');
    } catch { /* skip health checks if lockfile unreadable */ }

    const allHeadPackages = parseLockfilePackages(headContent, basename(absPath));

    const baseHealthKeys = new Set<string>();
    if (baseLockfileContent !== null) {
      for (const p of parseLockfilePackages(baseLockfileContent, basename(absPath))) {
        baseHealthKeys.add(`${p.name}@${p.version}`);
      }
    }

    const newPackages = allHeadPackages.filter(p => !baseHealthKeys.has(`${p.name}@${p.version}`));

    const BATCH = 5;
    for (let i = 0; i < newPackages.length; i += BATCH) {
      const batch = newPackages.slice(i, i + BATCH);
      const healthResults = await Promise.all(
        batch.map(pkg => checkPackageHealth({ name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem }, toolConfig))
      );

      for (let j = 0; j < batch.length; j++) {
        const pkg    = batch[j]!;
        const health = healthResults[j]!;
        const line   = await findLineInLockfile(absPath, pkg.name);

        if (health.abandoned && toolConfig.checkAbandoned) {
          findings.push({
            file:     lockfilePath,
            line,
            severity: 'medium',
            message:  `New dependency ${pkg.name}@${pkg.version} appears abandoned. ${health.reason}`,
            ruleId:   'abandoned/deprecated',
            tool:     'dep-doctor',
          });
        }
        if (health.deprecated && toolConfig.checkDeprecated) {
          findings.push({
            file:     lockfilePath,
            line,
            severity: 'medium',
            message:  `New dependency ${pkg.name}@${pkg.version} is deprecated. ${health.reason}`,
            ruleId:   'abandoned/deprecated',
            tool:     'dep-doctor',
          });
        }
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gitShow(workspacePath: string, sha: string, filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git', ['-C', workspacePath, 'show', `${sha}:${filePath}`],
      { maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout as string);
      },
    );
  });
}

function parseOsvOutput(stdout: string): OsvParsedEntry[] {
  if (!stdout.trim()) return [];
  try {
    const raw = JSON.parse(stdout) as {
      results?: Array<{
        packages?: Array<{
          package?:        OsvPackage;
          vulnerabilities?: OsvVuln[];
        }>;
      }>;
    };
    const entries: OsvParsedEntry[] = [];
    for (const result of raw.results ?? []) {
      for (const pkg of result.packages ?? []) {
        if (!pkg.package) continue;
        entries.push({ pkg: pkg.package, vulns: pkg.vulnerabilities ?? [] });
      }
    }
    return entries;
  } catch {
    console.error('[dep-doctor] Failed to parse OSV-Scanner JSON output');
    return [];
  }
}

function buildPackageSet(entries: OsvParsedEntry[]): Set<string> {
  return new Set(entries.map(({ pkg }) => `${pkg.ecosystem}:${pkg.name}@${pkg.version}`));
}

async function findLineInLockfile(absPath: string, packageName: string): Promise<number> {
  let content: string;
  try {
    content = await readFile(absPath, 'utf8');
  } catch {
    return 1;
  }
  const file    = basename(absPath);
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
// Direct lockfile parsing (all packages, regardless of CVE status)
// Used for health checks so packages with no CVEs are still flagged as abandoned/deprecated.
// ---------------------------------------------------------------------------

function parseLockfilePackages(content: string, filename: string): DirectPackage[] {
  if (filename === 'package-lock.json') {
    try {
      const json = JSON.parse(content) as {
        packages?:     Record<string, { version?: string }>;
        dependencies?: Record<string, { version?: string }>;
      };
      if (json.packages) {
        return Object.entries(json.packages)
          .filter(([k, v]) => k.startsWith('node_modules/') && v.version)
          .map(([k, v]) => {
            const lastIdx = k.lastIndexOf('node_modules/');
            const name    = k.slice(lastIdx + 'node_modules/'.length);
            return { name, version: v.version!, ecosystem: 'npm' as Ecosystem };
          });
      }
      if (json.dependencies) {
        return Object.entries(json.dependencies)
          .filter(([, v]) => v.version)
          .map(([k, v]) => ({ name: k, version: v.version!, ecosystem: 'npm' as Ecosystem }));
      }
    } catch { /* fall through */ }
    return [];
  }

  if (filename === 'yarn.lock') {
    const packages: DirectPackage[] = [];
    let currentName: string | null = null;
    for (const line of content.split('\n')) {
      if (!line.startsWith(' ') && !line.startsWith('#')) {
        const m = line.match(/^"?(@?[^@\s"]+)@/);
        currentName = m ? (m[1] ?? null) : null;
      }
      if (currentName) {
        const m = line.match(/^\s+version\s+"([^"]+)"/);
        if (m) {
          packages.push({ name: currentName, version: m[1]!, ecosystem: 'npm' });
          currentName = null;
        }
      }
    }
    return packages;
  }

  if (filename === 'requirements.txt') {
    return content.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .flatMap(l => {
        const m = l.match(/^([A-Za-z0-9_.-]+)==([^\s;#]+)/);
        return m ? [{ name: m[1]!, version: m[2]!, ecosystem: 'PyPI' as Ecosystem }] : [];
      });
  }

  return [];
}

// ---------------------------------------------------------------------------
// Registry health checks
// ---------------------------------------------------------------------------

interface HealthResult {
  abandoned:  boolean;
  deprecated: boolean;
  reason:     string;
}

async function checkPackageHealth(pkg: OsvPackage, config: DepDoctorConfig): Promise<HealthResult> {
  const eco = LOCKFILE_ECOSYSTEM[pkg.ecosystem] ?? pkg.ecosystem as Ecosystem;
  if (eco === 'npm')  return checkNpmHealth(pkg.name, pkg.version, config);
  if (eco === 'PyPI') return checkPypiHealth(pkg.name, config);
  return { abandoned: false, deprecated: false, reason: '' };
}

async function checkNpmHealth(name: string, version: string, config: DepDoctorConfig): Promise<HealthResult> {
  try {
    const url  = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'layne-dep-doctor/1.0' },
      signal:  AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { abandoned: false, deprecated: false, reason: '' };

    const data = await resp.json() as {
      time?:     Record<string, string>;
      versions?: Record<string, { deprecated?: string }>;
    };

    if (config.checkDeprecated) {
      const deprecatedMsg = data.versions?.[version]?.deprecated;
      if (deprecatedMsg) {
        return { abandoned: false, deprecated: true, reason: String(deprecatedMsg).slice(0, 200) };
      }
    }

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
          return { abandoned: true, deprecated: false, reason: `Last published: ${lastDate}` };
        }
      }
    }

    return { abandoned: false, deprecated: false, reason: '' };
  } catch (err) {
    debug('dep-doctor', `npm registry check failed for ${name}: ${(err as Error).message}`);
    return { abandoned: false, deprecated: false, reason: '' };
  }
}

async function checkPypiHealth(name: string, config: DepDoctorConfig): Promise<HealthResult> {
  try {
    const url  = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'layne-dep-doctor/1.0' },
      signal:  AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { abandoned: false, deprecated: false, reason: '' };

    const data = await resp.json() as {
      info?:     { classifiers?: string[] };
      releases?: Record<string, Array<{ upload_time_iso_8601?: string }>>;
    };

    if (config.checkDeprecated) {
      const classifiers = data.info?.classifiers ?? [];
      const inactive = classifiers.some(c =>
        c.includes('Development Status :: 7 - Inactive') || c.toLowerCase().includes('deprecated')
      );
      if (inactive) {
        return { abandoned: false, deprecated: true, reason: 'Package marked inactive/deprecated' };
      }
    }

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
          return { abandoned: true, deprecated: false, reason: `Last published: ${lastDate}` };
        }
      }
    }

    return { abandoned: false, deprecated: false, reason: '' };
  } catch (err) {
    debug('dep-doctor', `PyPI registry check failed for ${name}: ${(err as Error).message}`);
    return { abandoned: false, deprecated: false, reason: '' };
  }
}
