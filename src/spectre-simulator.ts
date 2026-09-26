import { execFile } from 'child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'fs/promises';
import { dirname, relative, resolve, sep } from 'path';
import { promisify, isDeepStrictEqual } from 'util';
import { runSpectreCore } from './spectre-core.js';
import { createSpectreGovernor } from './spectre-governor.js';
import { createScriptedSpectreTransport } from './spectre-transports/scripted.js';
import { checkoutGitChanges, cleanupWorkspace, createWorkspace, getGitChanges, getUnifiedDiff } from './fetcher.js';
import { applySpectreValidationCoverage, validateFindingLocations } from './location-validator.js';
import { deriveChangedHeadRanges } from './unified-diff.js';
import { routeSpectreSignals } from './spectre-routing.js';
import { shouldSkipSpectreFile } from './spectre-signals.js';
import type {
  GitChangeStatus,
  LineRange,
  PullRequestMetadata,
  ProcessedFinding,
  Severity,
  SpectreAstSignalsConfig,
  SpectreConfig,
  SpectreScanStatus,
} from './types.js';

const execFileAsync = promisify(execFile);
const MAX_FIXTURE_FILES = 100;
const MAX_FIXTURE_FILE_BYTES = 128 * 1024;
const MAX_FIXTURE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_BYTES = 512;
const MAX_BODY_BYTES = 4 * 1024;
const MAX_AUTHOR_BYTES = 128;

export type SpectreSimulationSnapshot =
  | { files: Record<string, string> }
  | { directory: string };

export interface SpectreSimulationFinding {
  file: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  ruleId: string;
  message: string;
  evidence: string;
}

export interface SpectreSimulationCoverage {
  changes: Array<{ status: GitChangeStatus; oldPath: string | null; newPath: string | null }>;
  regularHeadFiles: string[];
  changedHeadRanges: Record<string, LineRange[]>;
}

export interface SpectreSimulationFixture {
  id: string;
  tags: string[];
  base: SpectreSimulationSnapshot;
  head: SpectreSimulationSnapshot;
  pullRequest: Omit<PullRequestMetadata, 'trust'>;
  contextLines?: number;
  config?: SpectreSimulationConfig;
  scriptedResponses: Record<string, Array<{ findings: unknown[] }>>;
  expectedRequests: string[];
  expected: {
    findings: SpectreSimulationFinding[];
    status: SpectreScanStatus;
    coverage: SpectreSimulationCoverage;
  };
}

type SpectreSimulationConfig = Omit<Partial<SpectreConfig>, 'astSignals'> & {
  astSignals?: Partial<SpectreAstSignalsConfig>;
};

export interface SpectreSimulationCorpus {
  version: 1;
  cases: SpectreSimulationFixture[];
}

export interface SpectreSimulationCaseResult {
  id: string;
  tags: string[];
  passed: boolean;
  errors: string[];
  expectedFindings: SpectreSimulationFinding[];
  actualFindings: SpectreSimulationFinding[];
  expectedStatus: SpectreScanStatus;
  actualStatus?: SpectreScanStatus;
  expectedCoverage: SpectreSimulationCoverage;
  actualCoverage?: SpectreSimulationCoverage;
  expectedRequests: string[];
  actualRequests: string[];
  expectedConclusion: 'success' | 'failure' | 'neutral';
  actualConclusion?: 'success' | 'failure' | 'neutral';
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
}

export interface SpectreSimulationReport {
  fixturePath: string;
  total: number;
  passed: number;
  failed: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
  cases: SpectreSimulationCaseResult[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, maximumBytes = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
  return value;
}

function boundedString(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${label} must be a string array`);
  return value as string[];
}

function assertSafeFixturePath(path: string, label: string): void {
  if (path.length > 300 || path.includes('\0') || path.includes('\\') || path.startsWith('/')
    || path.split('/').some(part => part === '' || part === '.' || part === '..' || part === '.git')) {
    throw new Error(`${label} contains an unsafe repository path: ${JSON.stringify(path)}`);
  }
}

function parseSnapshot(value: unknown, label: string): SpectreSimulationSnapshot {
  const source = record(value, label);
  if (Object.keys(source).length !== 1 || (!('files' in source) && !('directory' in source))) {
    throw new Error(`${label} must contain exactly one of "files" or "directory"`);
  }
  if ('directory' in source) return { directory: string(source.directory, `${label}.directory`, 500) };
  const files = record(source.files, `${label}.files`);
  const parsed: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    assertSafeFixturePath(path, label);
    if (typeof content !== 'string') throw new Error(`${label}.files[${JSON.stringify(path)}] must be a string`);
    parsed[path] = content;
  }
  return { files: parsed };
}

const STATUS_COUNTERS: Array<keyof SpectreScanStatus> = [
  'selected', 'scanned', 'skipped', 'oversized', 'capped', 'truncated', 'failed', 'invalidResponses',
  'cancelled', 'rateLimited', 'concurrencyLimited', 'circuitOpen', 'plannedChunks', 'attemptedChunks',
  'completedChunks', 'cappedChunks', 'truncatedHunks', 'contextGaps', 'rejectedFindings',
  'repairAttempts', 'repairedResponses', 'repairedFindings',
];

function parseStatus(value: unknown, label: string): SpectreScanStatus {
  const source = record(value, label);
  if (source.outcome !== 'complete' && source.outcome !== 'incomplete' && source.outcome !== 'disabled') {
    throw new Error(`${label}.outcome is invalid`);
  }
  const normalized = { ...source };
  for (const field of ['repairAttempts', 'repairedResponses', 'repairedFindings'] as const) {
    normalized[field] ??= 0;
  }
  for (const field of STATUS_COUNTERS) {
    if (!Number.isSafeInteger(normalized[field]) || (normalized[field] as number) < 0) throw new Error(`${label}.${field} must be a non-negative integer`);
  }
  if (normalized.reason !== undefined && typeof normalized.reason !== 'string') throw new Error(`${label}.reason must be a string`);
  return normalized as unknown as SpectreScanStatus;
}

function parseFinding(value: unknown, label: string): SpectreSimulationFinding {
  const source = record(value, label);
  const severity = source.severity;
  if (!['critical', 'high', 'medium', 'low', 'info'].includes(String(severity))) throw new Error(`${label}.severity is invalid`);
  if (!Number.isSafeInteger(source.startLine) || (source.startLine as number) < 1
    || !Number.isSafeInteger(source.endLine) || (source.endLine as number) < (source.startLine as number)) {
    throw new Error(`${label} has invalid line coordinates`);
  }
  return {
    file: string(source.file, `${label}.file`, 300),
    startLine: source.startLine as number,
    endLine: source.endLine as number,
    severity: severity as Severity,
    ruleId: string(source.ruleId, `${label}.ruleId`, 100),
    message: string(source.message, `${label}.message`, 300),
    evidence: string(source.evidence, `${label}.evidence`, 1_000),
  };
}

function parseCoverage(value: unknown, label: string): SpectreSimulationCoverage {
  const source = record(value, label);
  if (!Array.isArray(source.changes)) throw new Error(`${label}.changes must be an array`);
  const changes = source.changes.map((item, index) => {
    const change = record(item, `${label}.changes[${index}]`);
    if (!['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed'].includes(String(change.status))) {
      throw new Error(`${label}.changes[${index}].status is invalid`);
    }
    if (change.oldPath !== null && typeof change.oldPath !== 'string') throw new Error(`${label}.changes[${index}].oldPath is invalid`);
    if (change.newPath !== null && typeof change.newPath !== 'string') throw new Error(`${label}.changes[${index}].newPath is invalid`);
    return { status: change.status as GitChangeStatus, oldPath: change.oldPath as string | null, newPath: change.newPath as string | null };
  });
  const changedHeadRangesSource = record(source.changedHeadRanges, `${label}.changedHeadRanges`);
  const changedHeadRanges: Record<string, LineRange[]> = {};
  for (const [path, rangesValue] of Object.entries(changedHeadRangesSource)) {
    if (!Array.isArray(rangesValue)) throw new Error(`${label}.changedHeadRanges[${JSON.stringify(path)}] must be an array`);
    changedHeadRanges[path] = rangesValue.map((rangeValue, index) => {
      const range = record(rangeValue, `${label}.changedHeadRanges[${JSON.stringify(path)}][${index}]`);
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || (range.start as number) < 1 || (range.end as number) < (range.start as number)) {
        throw new Error(`${label}.changedHeadRanges[${JSON.stringify(path)}][${index}] is invalid`);
      }
      return { start: range.start as number, end: range.end as number };
    });
  }
  return { changes, regularHeadFiles: stringArray(source.regularHeadFiles, `${label}.regularHeadFiles`), changedHeadRanges };
}

function parseConfig(value: unknown, label: string): SpectreSimulationConfig | undefined {
  if (value === undefined) return undefined;
  const source = record(value, label);
  const allowed = new Set(['fileCap', 'secondaryFileCap', 'maxInputBytes', 'maxDiffLines', 'maxCallsPerFile', 'maxCallsPerPullRequest', 'maxRepairCallsPerPullRequest', 'minSeverity', 'prompt', 'requestTimeoutSeconds', 'astSignals']);
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported by deterministic simulations`);
  for (const key of ['maxInputBytes', 'maxDiffLines', 'maxCallsPerFile', 'maxCallsPerPullRequest', 'requestTimeoutSeconds']) {
    if (source[key] !== undefined && (!Number.isSafeInteger(source[key]) || (source[key] as number) < 1)) throw new Error(`${label}.${key} must be a positive integer`);
  }
  if (source.fileCap !== undefined
    && (!Number.isSafeInteger(source.fileCap) || (source.fileCap as number) < 0 || (source.fileCap as number) > 30)) {
    throw new Error(`${label}.fileCap must be an integer from 0 through 30`);
  }
  if (source.secondaryFileCap !== undefined
    && (!Number.isSafeInteger(source.secondaryFileCap)
      || (source.secondaryFileCap as number) < 0
      || (source.secondaryFileCap as number) > 50)) {
    throw new Error(`${label}.secondaryFileCap must be an integer from 0 through 50`);
  }
  if (source.maxRepairCallsPerPullRequest !== undefined
    && (!Number.isSafeInteger(source.maxRepairCallsPerPullRequest)
      || (source.maxRepairCallsPerPullRequest as number) < 0
      || (source.maxRepairCallsPerPullRequest as number) > 10)) {
    throw new Error(`${label}.maxRepairCallsPerPullRequest must be an integer from 0 through 10`);
  }
  if (source.minSeverity !== undefined && !['critical', 'high', 'medium', 'low', 'info'].includes(String(source.minSeverity))) {
    throw new Error(`${label}.minSeverity is invalid`);
  }
  if (source.prompt !== undefined && source.prompt !== null && (typeof source.prompt !== 'string' || Buffer.byteLength(source.prompt, 'utf8') > 8_192)) {
    throw new Error(`${label}.prompt must be null or a string of at most 8192 UTF-8 bytes`);
  }
  if (source.astSignals !== undefined) {
    const astSignals = record(source.astSignals, `${label}.astSignals`);
    const astAllowed = new Set(['mode', 'maxFiles', 'maxTotalBytes', 'timeoutSeconds']);
    for (const key of Object.keys(astSignals)) if (!astAllowed.has(key)) throw new Error(`${label}.astSignals.${key} is not supported`);
    if (astSignals.mode !== undefined && !['off', 'shadow', 'enabled'].includes(String(astSignals.mode))) throw new Error(`${label}.astSignals.mode is invalid`);
    const limits: Record<string, [number, number]> = {
      maxFiles: [1, 500], maxTotalBytes: [1, 64 * 1024 * 1024], timeoutSeconds: [1, 30],
    };
    for (const [key, [minimum, maximum]] of Object.entries(limits)) {
      const item = astSignals[key];
      if (item !== undefined && (!Number.isSafeInteger(item) || (item as number) < minimum || (item as number) > maximum)) {
        throw new Error(`${label}.astSignals.${key} must be an integer from ${minimum} through ${maximum}`);
      }
    }
  }
  return source as SpectreSimulationConfig;
}

function parseFixture(value: unknown, index: number): SpectreSimulationFixture {
  const label = `cases[${index}]`;
  const source = record(value, label);
  const pullRequest = record(source.pullRequest, `${label}.pullRequest`);
  const responsesSource = record(source.scriptedResponses, `${label}.scriptedResponses`);
  const scriptedResponses: SpectreSimulationFixture['scriptedResponses'] = {};
  for (const [key, steps] of Object.entries(responsesSource)) {
    string(key, `${label}.scriptedResponses key`, 500);
    if (!Array.isArray(steps)) throw new Error(`${label}.scriptedResponses[${JSON.stringify(key)}] must be an array`);
    scriptedResponses[key] = steps.map((step, stepIndex) => {
      const envelope = record(step, `${label}.scriptedResponses[${JSON.stringify(key)}][${stepIndex}]`);
      if (!Array.isArray(envelope.findings)) throw new Error(`${label} scripted response must contain a findings array`);
      return { findings: envelope.findings };
    });
  }
  const expected = record(source.expected, `${label}.expected`);
  if (!Array.isArray(expected.findings)) throw new Error(`${label}.expected.findings must be an array`);
  const contextLines = source.contextLines === undefined ? undefined : source.contextLines;
  if (contextLines !== undefined && (!Number.isSafeInteger(contextLines) || (contextLines as number) < 0 || (contextLines as number) > 20)) {
    throw new Error(`${label}.contextLines must be an integer from 0 through 20`);
  }
  return {
    id: string(source.id, `${label}.id`, 100),
    tags: stringArray(source.tags, `${label}.tags`),
    base: parseSnapshot(source.base, `${label}.base`),
    head: parseSnapshot(source.head, `${label}.head`),
    pullRequest: {
      title: boundedString(pullRequest.title, `${label}.pullRequest.title`, MAX_TITLE_BYTES),
      body: boundedString(pullRequest.body, `${label}.pullRequest.body`, MAX_BODY_BYTES),
      author: string(pullRequest.author, `${label}.pullRequest.author`, MAX_AUTHOR_BYTES),
    },
    contextLines: contextLines as number | undefined,
    config: parseConfig(source.config, `${label}.config`),
    scriptedResponses,
    expectedRequests: stringArray(source.expectedRequests, `${label}.expectedRequests`),
    expected: {
      findings: expected.findings.map((finding, findingIndex) => parseFinding(finding, `${label}.expected.findings[${findingIndex}]`)),
      status: parseStatus(expected.status, `${label}.expected.status`),
      coverage: parseCoverage(expected.coverage, `${label}.expected.coverage`),
    },
  };
}

export async function loadSpectreSimulationCorpus(fixturePath: string): Promise<SpectreSimulationCorpus> {
  const absolutePath = resolve(fixturePath);
  const parsed = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  const source = record(parsed, 'simulation corpus');
  if (source.version !== 1 || !Array.isArray(source.cases)) throw new Error('simulation corpus must have version 1 and a cases array');
  const cases = source.cases.map(parseFixture);
  if (new Set(cases.map(fixture => fixture.id)).size !== cases.length) throw new Error('simulation fixture IDs must be unique');
  return { version: 1, cases };
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function readDirectorySnapshot(directory: string, fixtureRoot: string): Promise<Record<string, string>> {
  const root = resolve(fixtureRoot, directory);
  if (!within(root, resolve(fixtureRoot))) throw new Error(`Snapshot directory escapes the fixture root: ${JSON.stringify(directory)}`);
  const rootReal = await realpath(root);
  if (!within(rootReal, await realpath(fixtureRoot))) throw new Error(`Snapshot directory escapes the fixture root: ${JSON.stringify(directory)}`);
  const files: Record<string, string> = {};
  const visit = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(current, entry.name);
      const path = relative(rootReal, absolute).split(sep).join('/');
      assertSafeFixturePath(path, 'snapshot directory');
      if (entry.isSymbolicLink()) throw new Error(`Snapshot directories cannot contain symlinks: ${JSON.stringify(path)}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files[path] = await readFile(absolute, 'utf8');
      else throw new Error(`Snapshot directories can contain only regular files: ${JSON.stringify(path)}`);
    }
  };
  await visit(rootReal);
  return files;
}

async function materializeSnapshot(snapshot: SpectreSimulationSnapshot, fixtureRoot: string): Promise<Record<string, string>> {
  const files = 'files' in snapshot ? { ...snapshot.files } : await readDirectorySnapshot(snapshot.directory, fixtureRoot);
  const entries = Object.entries(files);
  if (entries.length > MAX_FIXTURE_FILES) throw new Error(`Snapshot exceeds ${MAX_FIXTURE_FILES} files`);
  let total = 0;
  for (const [path, content] of entries) {
    assertSafeFixturePath(path, 'snapshot');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FIXTURE_FILE_BYTES) throw new Error(`Snapshot file ${JSON.stringify(path)} exceeds ${MAX_FIXTURE_FILE_BYTES} bytes`);
    total += bytes;
  }
  if (total > MAX_FIXTURE_TOTAL_BYTES) throw new Error(`Snapshot exceeds ${MAX_FIXTURE_TOTAL_BYTES} total bytes`);
  return files;
}

async function writeSnapshot(workspacePath: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    const destination = resolve(workspacePath, path);
    if (!within(destination, workspacePath)) throw new Error(`Snapshot path escapes workspace: ${JSON.stringify(path)}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, 'utf8');
  }
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Layne Spectre Simulator',
  GIT_AUTHOR_EMAIL: 'spectre-simulator@layne.invalid',
  GIT_COMMITTER_NAME: 'Layne Spectre Simulator',
  GIT_COMMITTER_EMAIL: 'spectre-simulator@layne.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  LC_ALL: 'C',
  TZ: 'UTC',
};

async function git(workspacePath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', workspacePath, ...args], {
    encoding: 'utf8', env: GIT_ENV, maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

async function createRepository(workspacePath: string, base: Record<string, string>, head: Record<string, string>): Promise<{ baseSha: string; headSha: string }> {
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', '--template=', workspacePath], { env: GIT_ENV });
  await git(workspacePath, 'config', 'core.autocrlf', 'false');
  await git(workspacePath, 'config', 'commit.gpgsign', 'false');
  await writeSnapshot(workspacePath, base);
  await git(workspacePath, 'add', '--all');
  await git(workspacePath, 'commit', '--quiet', '--allow-empty', '--message', 'spectre simulation base');
  const baseSha = await git(workspacePath, 'rev-parse', 'HEAD');

  for (const entry of await readdir(workspacePath)) {
    if (entry !== '.git') await rm(resolve(workspacePath, entry), { recursive: true, force: true });
  }
  await writeSnapshot(workspacePath, head);
  await git(workspacePath, 'add', '--all');
  await git(workspacePath, 'commit', '--quiet', '--allow-empty', '--message', 'spectre simulation head');
  const headSha = await git(workspacePath, 'rev-parse', 'HEAD');
  await git(workspacePath, 'sparse-checkout', 'init', '--no-cone');
  return { baseSha, headSha };
}

function simulationConfig(overrides: SpectreSimulationConfig | undefined): SpectreConfig {
  const defaultAstSignals: SpectreAstSignalsConfig = {
    mode: 'off', maxFiles: 200, maxTotalBytes: 2 * 1024 * 1024, timeoutSeconds: 3,
  };
  return {
    enabled: true,
    provider: 'scripted',
    model: 'deterministic',
    maxInputBytes: 64 * 1024,
    maxDiffLines: 400,
    maxCallsPerFile: 4,
    maxCallsPerPullRequest: 40,
    maxRepairCallsPerPullRequest: 3,
    requestTimeoutSeconds: 30,
    minSeverity: 'high',
    ...overrides,
    astSignals: { ...defaultAstSignals, ...(overrides?.astSignals ?? {}) },
    concurrency: 1,
  };
}

function simulationGovernor() {
  return createSpectreGovernor({
    concurrency: 1,
    requestsPerMinute: 10_000,
    burst: 10_000,
    queueTimeoutMs: 1_000,
    failureThreshold: 100,
    failureWindowMs: 60_000,
    cooldownMs: 60_000,
    now: () => 0,
  });
}

function canonicalFinding(finding: {
  file: string; startLine?: number; endLine?: number; line: number; severity: Severity; ruleId: string; message: string; evidence?: string;
}): SpectreSimulationFinding {
  return {
    file: finding.file,
    startLine: finding.startLine ?? finding.line,
    endLine: finding.endLine ?? finding.startLine ?? finding.line,
    severity: finding.severity,
    ruleId: finding.ruleId,
    message: finding.message,
    evidence: finding.evidence ?? '',
  };
}

function findingMetrics(expected: SpectreSimulationFinding[], actual: SpectreSimulationFinding[]): { truePositive: number; falsePositive: number; falseNegative: number } {
  const remaining = expected.map(finding => JSON.stringify(finding));
  let truePositive = 0;
  let falsePositive = 0;
  for (const finding of actual) {
    const index = remaining.indexOf(JSON.stringify(finding));
    if (index >= 0) {
      truePositive++;
      remaining.splice(index, 1);
    } else {
      falsePositive++;
    }
  }
  return { truePositive, falsePositive, falseNegative: remaining.length };
}

function rangesRecord(ranges: Map<string, LineRange[]>): Record<string, LineRange[]> {
  return Object.fromEntries([...ranges.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

function simulationConclusion(findings: SpectreSimulationFinding[], status: SpectreScanStatus): 'success' | 'failure' | 'neutral' {
  if (findings.some(finding => finding.severity === 'critical' || finding.severity === 'high')) return 'failure';
  if ((status.highRiskCapped ?? 0) > 0) return 'failure';
  return status.outcome === 'incomplete' ? 'neutral' : 'success';
}

export async function runSpectreSimulation(fixture: SpectreSimulationFixture, fixtureRoot: string): Promise<SpectreSimulationCaseResult> {
  const errors: string[] = [];
  let workspacePath: string | undefined;
  let actualFindings: SpectreSimulationFinding[] = [];
  let actualStatus: SpectreScanStatus | undefined;
  let actualCoverage: SpectreSimulationCoverage | undefined;
  let actualRequests: string[] = [];
  let actualConclusion: 'success' | 'failure' | 'neutral' | undefined;

  try {
    const base = await materializeSnapshot(fixture.base, fixtureRoot);
    const head = await materializeSnapshot(fixture.head, fixtureRoot);
    workspacePath = await createWorkspace(`spectre-sim-${fixture.id}`);
    const { baseSha, headSha } = await createRepository(workspacePath, base, head);
    const changes = await getGitChanges({ workspacePath, baseSha, headSha });
    const diffFiles = changes.map(change => change.newPath ?? change.oldPath).filter((path): path is string => path !== null);
    const unifiedDiff = await getUnifiedDiff({
      workspacePath,
      baseSha,
      headSha,
      contextLines: fixture.contextLines ?? 3,
      files: diffFiles,
      changes,
    });
    const changedHeadRanges = deriveChangedHeadRanges(unifiedDiff);
    const preparedChanges = await checkoutGitChanges({ workspacePath, headSha, changes });
    const regularHeadFiles = preparedChanges.files;
    const activeConfig = simulationConfig(fixture.config);
    const eligibleHeadFiles = regularHeadFiles.filter(file => {
      const newMode = changes.find(change => change.newPath === file)?.newMode;
      return !shouldSkipSpectreFile(file, activeConfig, newMode);
    });
    const sources = [];
    for (const file of eligibleHeadFiles) {
      const absolute = resolve(workspacePath, file);
      sources.push({ file, content: await readFile(absolute, 'utf8'), changedLineRanges: changedHeadRanges.get(file) ?? [] });
    }
    const routing = await routeSpectreSignals({ config: activeConfig, files: sources.map(source => {
      const diffFile = unifiedDiff.files.find(file => file.change.newPath === source.file);
      return {
        file: source.file,
        content: source.content,
        addedLines: diffFile?.hunks.flatMap(hunk => hunk.lines.flatMap(line =>
          line.type === 'addition' ? [{ line: line.newLine, content: line.content }] : []
        )),
      };
    }) });
    const routingContext = routing.context;
    const selection = routing.selection;
    actualCoverage = {
      changes: changes.map(change => ({ status: change.status, oldPath: change.oldPath, newPath: change.newPath })),
      regularHeadFiles,
      changedHeadRanges: rangesRecord(changedHeadRanges),
    };

    const expectedCounts = new Map<string, number>();
    for (const key of fixture.expectedRequests) expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
    for (const [key, steps] of Object.entries(fixture.scriptedResponses)) {
      if ((expectedCounts.get(key) ?? 0) !== steps.length) errors.push(`scripted response count for ${JSON.stringify(key)} does not match expected requests`);
    }
    for (const key of expectedCounts.keys()) {
      if (!(key in fixture.scriptedResponses)) errors.push(`expected request ${JSON.stringify(key)} has no scripted response queue`);
    }

    const transport = createScriptedSpectreTransport(Object.fromEntries(
      Object.entries(fixture.scriptedResponses).map(([key, steps]) => [key, steps.map(step => ({ text: JSON.stringify(step) }))]),
    ));
    const pullRequestMetadata: PullRequestMetadata = { trust: 'untrusted', ...fixture.pullRequest };
    const result = await runSpectreCore({
      selectedFiles: selection.selected,
      sources,
      unifiedDiff,
      pullRequestMetadata,
      routingContext,
      transport,
      governor: simulationGovernor(),
      config: activeConfig,
    });
    result.status.skipped = regularHeadFiles.length - eligibleHeadFiles.length;
    result.status.capped = selection.capped;
    if (selection.highRiskCapped.length > 0) {
      result.status.highRiskCapped = selection.highRiskCapped.length;
      result.status.highRiskCappedFiles = selection.highRiskCapped
        .slice(0, 10)
        .map(({ file, score, signals }) => ({ file, score, signals }));
      result.status.outcome = 'incomplete';
      result.status.reason = 'high-risk-file-cap-exceeded';
    } else if (selection.capped > 0) {
      result.status.outcome = 'incomplete';
      result.status.reason ??= 'file-cap-exceeded';
    }
    const validated = await validateFindingLocations(result.findings as ProcessedFinding[], {
      workspacePath,
      changedFiles: regularHeadFiles,
      changedLineRanges: changedHeadRanges,
    });
    applySpectreValidationCoverage(result.status, validated);
    actualFindings = validated.filter(finding => finding.locationValidated === true).map(canonicalFinding);
    actualStatus = result.status;
    actualConclusion = simulationConclusion(actualFindings, actualStatus);
    actualRequests = transport.requests.map(request => request.key);

    if (transport.remaining() !== 0) errors.push(`${transport.remaining()} scripted response(s) remain unused`);
    if (!jsonEqual(actualRequests, fixture.expectedRequests)) errors.push('core request sequence does not match expectedRequests');
    if (!jsonEqual(actualFindings, fixture.expected.findings)) errors.push('findings do not match expected findings');
    if (!jsonEqual(actualStatus, fixture.expected.status)) errors.push('scan status does not match expected status');
    if (actualConclusion !== simulationConclusion(fixture.expected.findings, fixture.expected.status)) errors.push('scan conclusion does not match expected conclusion');
    if (!jsonEqual(actualCoverage, fixture.expected.coverage)) errors.push('Git coverage does not match expected coverage');
  } catch (error) {
    errors.push(`simulation failed: ${(error as Error).message}`);
  } finally {
    if (workspacePath !== undefined) {
      try {
        await cleanupWorkspace(workspacePath);
        try {
          await lstat(workspacePath);
          errors.push('temporary workspace still exists after cleanup');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') errors.push(`temporary workspace cleanup verification failed: ${(error as Error).message}`);
        }
      } catch (error) {
        errors.push(`temporary workspace cleanup failed: ${(error as Error).message}`);
      }
    }
  }

  const metrics = findingMetrics(fixture.expected.findings, actualFindings);
  const expectedConclusion = simulationConclusion(fixture.expected.findings, fixture.expected.status);
  return {
    id: fixture.id,
    tags: fixture.tags,
    passed: errors.length === 0,
    errors,
    expectedFindings: fixture.expected.findings,
    actualFindings,
    expectedStatus: fixture.expected.status,
    actualStatus,
    expectedCoverage: fixture.expected.coverage,
    actualCoverage,
    expectedRequests: fixture.expectedRequests,
    actualRequests,
    expectedConclusion,
    actualConclusion,
    ...metrics,
  };
}

export async function runSpectreSimulationCorpus(fixturePath: string): Promise<SpectreSimulationReport> {
  const absolutePath = resolve(fixturePath);
  const corpus = await loadSpectreSimulationCorpus(absolutePath);
  const fixtureRoot = dirname(absolutePath);
  const cases: SpectreSimulationCaseResult[] = [];
  for (const fixture of corpus.cases) cases.push(await runSpectreSimulation(fixture, fixtureRoot));
  const truePositive = cases.reduce((total, result) => total + result.truePositive, 0);
  const falsePositive = cases.reduce((total, result) => total + result.falsePositive, 0);
  const falseNegative = cases.reduce((total, result) => total + result.falseNegative, 0);
  const precision = truePositive + falsePositive === 0 ? 1 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 1 : truePositive / (truePositive + falseNegative);
  return {
    fixturePath: absolutePath,
    total: cases.length,
    passed: cases.filter(result => result.passed).length,
    failed: cases.filter(result => !result.passed).length,
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    cases,
  };
}
