import { parse as parseToml } from 'smol-toml';
import { isMap, isScalar, LineCounter, parseAllDocuments, parseDocument } from 'yaml';

export type DependencyEcosystem = 'npm' | 'PyPI';
export type LockfileParseFailureReason = 'lockfile-parse-failed' | 'lockfile-version-unsupported';

export interface LockedPackage {
  name: string;
  canonicalName: string;
  version: string;
  ecosystem: DependencyEcosystem;
  line: number;
}

export type LockfileParseResult =
  | { ok: true; packages: LockedPackage[] }
  | { ok: false; reason: LockfileParseFailureReason; detail: string };

type LockfileParseFailure = Extract<LockfileParseResult, { ok: false }>;

export const DEP_DOCTOR_LOCKFILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'requirements.txt',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'go.sum',
]);

const HEALTH_LOCKFILES = new Set([...DEP_DOCTOR_LOCKFILES].filter(filename => filename !== 'go.sum'));

export function isDependencyLockfile(filename: string): boolean {
  return DEP_DOCTOR_LOCKFILES.has(filename);
}

const SUPPORTED_PNPM_LOCK_VERSIONS = new Set(['5.3', '5.4', '6.0', '9.0']);
const SUPPORTED_POETRY_LOCK_VERSIONS = new Set(['1.1', '2.0', '2.1']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(reason: LockfileParseFailureReason, detail: string): LockfileParseFailure {
  return { ok: false, reason, detail };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLockfileParseFailure(value: Record<string, unknown> | LockfileParseFailure): value is LockfileParseFailure {
  return value['ok'] === false;
}

export function supportsDependencyHealth(filename: string): boolean {
  return HEALTH_LOCKFILES.has(filename);
}

export function canonicalizePackageName(ecosystem: DependencyEcosystem, name: string): string {
  const lower = name.trim().toLowerCase();
  return ecosystem === 'PyPI' ? lower.replace(/[-_.]+/g, '-') : lower;
}

export function lockedPackageKey(pkg: Pick<LockedPackage, 'ecosystem' | 'canonicalName' | 'version'>): string {
  return `${pkg.ecosystem}:${pkg.canonicalName}@${pkg.version}`;
}

function deduplicatePackages(packages: LockedPackage[]): LockedPackage[] {
  const byPair = new Map<string, LockedPackage>();
  for (const pkg of packages) {
    const key = lockedPackageKey(pkg);
    const existing = byPair.get(key);
    if (!existing || pkg.line < existing.line) byPair.set(key, pkg);
  }
  return [...byPair.values()];
}

function lockedPackage(name: string, version: string, ecosystem: DependencyEcosystem, line: number): LockedPackage {
  return {
    name,
    canonicalName: canonicalizePackageName(ecosystem, name),
    version,
    ecosystem,
    line,
  };
}

class SourceLines {
  private readonly starts = [0];

  constructor(private readonly source: string) {
    for (let index = 0; index < source.length; index++) {
      if (source.charCodeAt(index) === 10) this.starts.push(index + 1);
    }
  }

  at(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.starts[middle]! <= offset) low = middle + 1;
      else high = middle - 1;
    }
    return Math.max(1, high + 1);
  }

  findJsonKey(key: string, from = 0): number {
    const offset = this.source.indexOf(JSON.stringify(key), from);
    return offset === -1 ? 1 : this.at(offset);
  }
}

function hasNonRegistryProtocol(value: unknown): boolean {
  return typeof value === 'string' && /^(?:file|link|workspace|git|git\+|https?):/i.test(value);
}

function isPublicNpmUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'registry.npmjs.org' || host === 'registry.yarnpkg.com';
  } catch {
    return false;
  }
}

function isPublicNpmResolution(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || !/^https?:/i.test(value)) return false;
  return isPublicNpmUrl(value);
}

function parsePackageLock(content: string): LockfileParseResult {
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch (error) {
    return failure('lockfile-parse-failed', errorMessage(error));
  }
  if (!isRecord(root)) return failure('lockfile-parse-failed', 'package-lock.json root must be an object');

  const lockfileVersion = root['lockfileVersion'];
  if (!Number.isInteger(lockfileVersion) || ![1, 2, 3].includes(lockfileVersion as number)) {
    return failure('lockfile-version-unsupported', `unsupported package-lock.json lockfileVersion: ${String(lockfileVersion)}`);
  }

  const lines = new SourceLines(content);
  const packages: LockedPackage[] = [];
  if (root['packages'] !== undefined) {
    if (!isRecord(root['packages'])) return failure('lockfile-parse-failed', 'package-lock.json packages must be an object');
    for (const [installPath, raw] of Object.entries(root['packages'])) {
      if (!installPath || !isRecord(raw) || raw['link'] === true || typeof raw['version'] !== 'string') continue;
      if (hasNonRegistryProtocol(raw['version']) || !isPublicNpmResolution(raw['resolved'])) continue;
      const marker = 'node_modules/';
      const markerIndex = installPath.lastIndexOf(marker);
      if (markerIndex === -1) continue;
      const pathName = installPath.slice(markerIndex + marker.length);
      const name = typeof raw['name'] === 'string' && raw['name'].trim() ? raw['name'] : pathName;
      if (!name) continue;
      packages.push(lockedPackage(name, raw['version'], 'npm', lines.findJsonKey(installPath)));
    }
  } else {
    if (!isRecord(root['dependencies'])) return failure('lockfile-parse-failed', 'package-lock.json dependencies must be an object');
    const walk = (dependencies: Record<string, unknown>): void => {
      for (const [name, raw] of Object.entries(dependencies)) {
        if (!isRecord(raw) || typeof raw['version'] !== 'string') continue;
        if (!hasNonRegistryProtocol(raw['version']) && isPublicNpmResolution(raw['resolved'])) {
          packages.push(lockedPackage(name, raw['version'], 'npm', lines.findJsonKey(name)));
        }
        if (isRecord(raw['dependencies'])) walk(raw['dependencies']);
      }
    };
    walk(root['dependencies']);
  }
  return { ok: true, packages: deduplicatePackages(packages) };
}

function yarnDescriptorName(descriptor: string): string | null {
  const normalized = descriptor.trim().replace(/^['"]|['"]$/g, '');
  const match = normalized.match(/^(@[^/]+\/[^@]+|[^@\s]+)@/);
  return match?.[1] ?? null;
}

function parseYarnClassic(content: string): LockfileParseResult {
  const lines = content.split(/\r?\n/);
  const packages: LockedPackage[] = [];
  let currentName: string | null = null;
  let currentVersion: string | null = null;
  let currentLine = 1;
  let currentPublicSource = true;
  let malformedEntry = false;
  let sawUnexpectedContent = false;

  const flush = (): void => {
    if (!currentName) return;
    if (!currentVersion) malformedEntry = true;
    else if (currentPublicSource && !hasNonRegistryProtocol(currentVersion)) {
      packages.push(lockedPackage(currentName, currentVersion, 'npm', currentLine));
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line && !/^\s|#/.test(line) && line.endsWith(':')) {
      flush();
      const firstDescriptor = line.slice(0, -1).replace(/^"|"$/g, '').split(/,\s*/)[0] ?? '';
      currentName = yarnDescriptorName(firstDescriptor);
      if (!currentName) malformedEntry = true;
      const source = currentName ? firstDescriptor.slice(currentName.length + 1) : '';
      if (source.toLowerCase().startsWith('npm:')) {
        currentName = yarnDescriptorName(source.slice('npm:'.length)) ?? currentName;
      }
      currentPublicSource = !/^(?:file|link|workspace|https?):|^git(?:\+|:)/i.test(source);
      currentVersion = null;
      currentLine = index + 1;
      continue;
    }
    if (line.trim() && !line.trimStart().startsWith('#') && !/^\s/.test(line) && !line.endsWith(':')) sawUnexpectedContent = true;
    if (!currentName) continue;
    const version = line.match(/^\s+version\s+"([^"]+)"/);
    if (version) currentVersion = version[1]!;
    const resolved = line.match(/^\s+resolved\s+"([^"]+)"/);
    if (resolved && /^(?:file|link|workspace):|^git(?:\+|:)/i.test(resolved[1]!)) {
      currentPublicSource = false;
    } else if (resolved && /^https?:/i.test(resolved[1]!) && !isPublicNpmUrl(resolved[1]!)) {
      currentPublicSource = false;
    }
  }

  flush();
  if (malformedEntry || sawUnexpectedContent) return failure('lockfile-parse-failed', 'invalid Yarn Classic entry');
  return { ok: true, packages: deduplicatePackages(packages) };
}

function parseYarnBerry(content: string): LockfileParseResult {
  const lineCounter = new LineCounter();
  const document = parseDocument(content, { lineCounter, uniqueKeys: true });
  if (document.errors.length > 0) return failure('lockfile-parse-failed', document.errors[0]!.message);
  if (!isMap(document.contents)) return failure('lockfile-parse-failed', 'Yarn lockfile root must be a map');
  const metadataVersion: unknown = document.getIn(['__metadata', 'version']);
  if (!Number.isInteger(metadataVersion)) {
    return failure('lockfile-version-unsupported', 'Yarn Berry __metadata.version is missing or invalid');
  }

  const packages: LockedPackage[] = [];
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '__metadata' || !isMap(pair.value)) continue;
    const version: unknown = pair.value.get('version');
    const resolution: unknown = pair.value.get('resolution');
    if (typeof version !== 'string' || typeof resolution !== 'string') return failure('lockfile-parse-failed', `invalid Yarn Berry entry: ${pair.key.value}`);
    const npmMarker = resolution.lastIndexOf('@npm:');
    if (npmMarker === -1 || hasNonRegistryProtocol(version)) continue;
    const name = resolution.slice(0, npmMarker);
    if (!name) continue;
    packages.push(lockedPackage(name, version, 'npm', lineCounter.linePos(pair.key.range?.[0] ?? 0).line));
  }
  return { ok: true, packages: deduplicatePackages(packages) };
}

function parseYarnLock(content: string): LockfileParseResult {
  return /^__metadata:\s*$/m.test(content) ? parseYarnBerry(content) : parseYarnClassic(content);
}

function normalizePnpmVersion(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = typeof value === 'number' && Number.isInteger(value) ? value.toFixed(1) : String(value);
  return SUPPORTED_PNPM_LOCK_VERSIONS.has(text) ? text : null;
}

function decodePnpmPackageKey(rawKey: string): { name: string; version: string } | null {
  let key = rawKey.trim().replace(/^\//, '');
  if (!key || /^(?:file|link|workspace|git|https?):/i.test(key)) return null;
  const peerSuffix = key.indexOf('(');
  if (peerSuffix !== -1) key = key.slice(0, peerSuffix);

  let name: string;
  let version: string;
  const absoluteSegments = key.split('/');
  if (absoluteSegments.length >= 2 && absoluteSegments[0]!.includes('.')) {
    if (absoluteSegments[0]!.toLowerCase() !== 'registry.npmjs.org') return null;
    key = absoluteSegments.slice(1).join('/');
  }
  if (key.startsWith('@') && key.split('/').length >= 3) {
    const segments = key.split('/');
    name = `${segments[0]}/${segments[1]}`;
    version = segments.slice(2).join('/');
  } else if (!key.startsWith('@') && key.includes('/')) {
    const split = key.lastIndexOf('/');
    name = key.slice(0, split);
    version = key.slice(split + 1);
  } else {
    const split = key.lastIndexOf('@');
    if (split <= 0) return null;
    name = key.slice(0, split);
    version = key.slice(split + 1);
  }
  version = version.split('_')[0] ?? version;
  if (!name || !version || hasNonRegistryProtocol(version)) return null;
  return { name, version };
}

function parsePnpmLock(content: string): LockfileParseResult {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(content, { lineCounter, uniqueKeys: true });
  if (documents.length === 0) return failure('lockfile-parse-failed', 'pnpm lockfile is empty');
  const versions = new Set<string>();
  const packages: LockedPackage[] = [];

  for (const document of documents) {
    if (document.errors.length > 0) return failure('lockfile-parse-failed', document.errors[0]!.message);
    if (!isMap(document.contents)) return failure('lockfile-parse-failed', 'pnpm lockfile document root must be a map');
    const rawVersion = document.get('lockfileVersion');
    if (rawVersion !== undefined) {
      const version = normalizePnpmVersion(rawVersion);
      if (!version) return failure('lockfile-version-unsupported', `unsupported pnpm lockfileVersion: ${String(rawVersion)}`);
      versions.add(version);
    }
    const packageMap = document.get('packages', true);
    if (packageMap === undefined) continue;
    if (!isMap(packageMap)) return failure('lockfile-parse-failed', 'pnpm packages must be a map');
    for (const pair of packageMap.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') return failure('lockfile-parse-failed', 'pnpm package key must be a string');
      const decoded = decodePnpmPackageKey(pair.key.value);
      if (!decoded) continue;
      const tarball = isMap(pair.value) ? pair.value.getIn(['resolution', 'tarball']) : undefined;
      if (tarball !== undefined && !isPublicNpmResolution(tarball)) continue;
      packages.push(lockedPackage(decoded.name, decoded.version, 'npm', lineCounter.linePos(pair.key.range?.[0] ?? 0).line));
    }
  }
  if (versions.size === 0) return failure('lockfile-version-unsupported', 'pnpm lockfileVersion is missing');
  if (versions.size > 1) return failure('lockfile-version-unsupported', 'pnpm lockfile documents use inconsistent versions');
  return { ok: true, packages: deduplicatePackages(packages) };
}

function parseRequirements(content: string): LockfileParseResult {
  const directivePattern = /^(?:--index-url|-i|--extra-index-url)(?:\s+|=)(\S+)/i;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^(?:--no-index|--find-links|-f)(?:\s|=|$)/i.test(line)) return { ok: true, packages: [] };
    const directive = line.match(directivePattern);
    if (directive && !isPublicPypiUrl(directive[1])) return { ok: true, packages: [] };
  }
  const packages: LockedPackage[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('-') || /\s@\s|^(?:git|https?|file):/i.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]+\])?\s*(?:===|==)\s*([^\s;\\]+)(?:\s*;.*)?(?:\s*\\)?$/);
    if (!match) continue;
    packages.push(lockedPackage(match[1]!, match[2]!, 'PyPI', index + 1));
  }
  return { ok: true, packages: deduplicatePackages(packages) };
}

function isPublicPypiUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'pypi.org' || host === 'files.pythonhosted.org';
  } catch {
    return false;
  }
}

function parsePipfileLock(content: string): LockfileParseResult {
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch (error) {
    return failure('lockfile-parse-failed', errorMessage(error));
  }
  if (!isRecord(root) || !isRecord(root['_meta'])) return failure('lockfile-parse-failed', 'Pipfile.lock _meta is missing');
  if (root['_meta']['pipfile-spec'] !== 6) {
    return failure('lockfile-version-unsupported', `unsupported Pipfile.lock pipfile-spec: ${String(root['_meta']['pipfile-spec'])}`);
  }

  const publicIndexes = new Set<string>();
  const sources = root['_meta']['sources'];
  let defaultSourceIsPublic = false;
  if (Array.isArray(sources)) {
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      if (index === 0 && isRecord(source)) defaultSourceIsPublic = isPublicPypiUrl(source['url']);
      if (isRecord(source) && typeof source['name'] === 'string' && isPublicPypiUrl(source['url'])) publicIndexes.add(source['name']);
    }
  }

  const lines = new SourceLines(content);
  const packages: LockedPackage[] = [];
  for (const [category, rawCategory] of Object.entries(root)) {
    if (category === '_meta') continue;
    if (!isRecord(rawCategory)) return failure('lockfile-parse-failed', `Pipfile.lock category ${category} must be an object`);
    for (const [name, raw] of Object.entries(rawCategory)) {
      if (!isRecord(raw) || typeof raw['version'] !== 'string') continue;
      const version = raw['version'].match(/^==(.+)$/)?.[1];
      if (!version || ['git', 'path', 'file', 'editable'].some(key => raw[key] !== undefined)) continue;
      if (typeof raw['index'] === 'string' && !publicIndexes.has(raw['index'])) continue;
      if (raw['index'] === undefined && !defaultSourceIsPublic) continue;
      packages.push(lockedPackage(name, version, 'PyPI', lines.findJsonKey(name)));
    }
  }
  return { ok: true, packages: deduplicatePackages(packages) };
}

function tomlPackageLines(content: string, expectedCount: number): number[] | null {
  const lines = content.split(/\r?\n/);
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^\s*\[\[package\]\]\s*(?:#.*)?$/.test(lines[index]!)) starts.push(index);
  }
  if (starts.length !== expectedCount) return null;
  return starts.map((start, blockIndex) => {
    const end = starts[blockIndex + 1] ?? lines.length;
    for (let index = start + 1; index < end; index++) {
      if (/^\s*name\s*=/.test(lines[index]!)) return index + 1;
    }
    return start + 1;
  });
}

function parseTomlRoot(content: string): Record<string, unknown> | LockfileParseFailure {
  try {
    const parsed = parseToml(content) as unknown;
    return isRecord(parsed) ? parsed : failure('lockfile-parse-failed', 'TOML root must be a table');
  } catch (error) {
    return failure('lockfile-parse-failed', errorMessage(error));
  }
}

function parsePoetryLock(content: string): LockfileParseResult {
  const root = parseTomlRoot(content);
  if (isLockfileParseFailure(root)) return root;
  if (!isRecord(root['metadata'])) return failure('lockfile-parse-failed', 'poetry.lock metadata is missing');
  const lockVersion = root['metadata']['lock-version'];
  if (typeof lockVersion !== 'string' || !SUPPORTED_POETRY_LOCK_VERSIONS.has(lockVersion)) {
    return failure('lockfile-version-unsupported', `unsupported poetry.lock lock-version: ${String(lockVersion)}`);
  }
  if (!Array.isArray(root['package'])) return failure('lockfile-parse-failed', 'poetry.lock package array is missing');
  const packageLines = tomlPackageLines(content, root['package'].length);
  if (!packageLines) return failure('lockfile-parse-failed', 'poetry.lock package locations could not be resolved');

  const packages: LockedPackage[] = [];
  for (let index = 0; index < root['package'].length; index++) {
    const raw = root['package'][index];
    if (!isRecord(raw) || typeof raw['name'] !== 'string' || typeof raw['version'] !== 'string') {
      return failure('lockfile-parse-failed', `invalid poetry.lock package at index ${index}`);
    }
    if (raw['source'] !== undefined) continue;
    packages.push(lockedPackage(raw['name'], raw['version'], 'PyPI', packageLines[index]!));
  }
  return { ok: true, packages: deduplicatePackages(packages) };
}

function parseUvLock(content: string): LockfileParseResult {
  const root = parseTomlRoot(content);
  if (isLockfileParseFailure(root)) return root;
  if (root['version'] !== 1) return failure('lockfile-version-unsupported', `unsupported uv.lock version: ${String(root['version'])}`);
  if (root['revision'] !== undefined && (!Number.isInteger(root['revision']) || (root['revision'] as number) < 0)) {
    return failure('lockfile-version-unsupported', `unsupported uv.lock revision: ${String(root['revision'])}`);
  }
  if (!Array.isArray(root['package'])) return failure('lockfile-parse-failed', 'uv.lock package array is missing');
  const packageLines = tomlPackageLines(content, root['package'].length);
  if (!packageLines) return failure('lockfile-parse-failed', 'uv.lock package locations could not be resolved');

  const packages: LockedPackage[] = [];
  for (let index = 0; index < root['package'].length; index++) {
    const raw = root['package'][index];
    if (!isRecord(raw) || typeof raw['name'] !== 'string' || typeof raw['version'] !== 'string') {
      return failure('lockfile-parse-failed', `invalid uv.lock package at index ${index}`);
    }
    const source = raw['source'];
    if (!isRecord(source) || !isPublicPypiUrl(source['registry'])) continue;
    packages.push(lockedPackage(raw['name'], raw['version'], 'PyPI', packageLines[index]!));
  }
  return { ok: true, packages: deduplicatePackages(packages) };
}

export function parseDependencyLockfile(content: string, filename: string): LockfileParseResult {
  switch (filename) {
    case 'package-lock.json': return parsePackageLock(content);
    case 'yarn.lock': return parseYarnLock(content);
    case 'pnpm-lock.yaml': return parsePnpmLock(content);
    case 'requirements.txt': return parseRequirements(content);
    case 'Pipfile.lock': return parsePipfileLock(content);
    case 'poetry.lock': return parsePoetryLock(content);
    case 'uv.lock': return parseUvLock(content);
    default: return failure('lockfile-version-unsupported', `health checks are not supported for ${filename}`);
  }
}
