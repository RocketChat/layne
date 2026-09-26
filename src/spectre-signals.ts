import { extname, posix } from 'path';
import type { SpectreConfig } from './types.js';

export const SPECTRE_SIGNAL_KINDS = [
  'automatic-execution',
  'manifest-lifecycle',
  'gyp-command',
  'ci-privilege',
  'ci-untrusted-input',
  'ci-secret-access',
  'ci-trust-crossing',
  'registry-override',
  'process-execution',
  'network-access',
  'network-execution',
  'remote-execution-flow',
  'secret-access',
  'secret-network-flow',
  'dynamic-execution',
  'covert-process',
  'encoded-execution',
  'startup-persistence',
  'prompt-flood',
  'content-mismatch',
  'suspicious-content',
  'custom-boost',
] as const;

export type SpectreSignalKind = typeof SPECTRE_SIGNAL_KINDS[number];

export interface SpectreSignalInputFile {
  file: string;
  content: string | null;
  /** Added HEAD lines. Omit when the whole supplied content should be treated as changed. */
  addedLines?: ReadonlyArray<{ line: number; content: string }>;
}

export interface SpectreRoutingFile {
  file: string;
  score: number;
  signals: SpectreSignalKind[];
  relations: string[];
  priorityLines: number[];
}

export interface SpectreRoutingRelation {
  key: string;
  files: string[];
}

export interface SpectreRoutingContext {
  version: 1;
  files: SpectreRoutingFile[];
  relations: SpectreRoutingRelation[];
}

export interface SpectreSelection {
  primary: string[];
  secondary: string[];
  selected: string[];
  capped: number;
  highRiskCapped: SpectreRoutingFile[];
}

export interface SpectreStructuralSignalFact {
  file: string;
  kind: SpectreSignalKind;
  startLine: number;
  endLine: number;
  intersectsAddedLine: boolean;
}

export const SPECTRE_HIGH_RISK_SCORE = 12;

const SIGNAL_WEIGHT: Record<SpectreSignalKind, number> = {
  'automatic-execution': 12,
  'manifest-lifecycle': 14,
  'gyp-command': 16,
  'ci-privilege': 8,
  'ci-untrusted-input': 14,
  'ci-secret-access': 5,
  'ci-trust-crossing': 48,
  'registry-override': 12,
  'process-execution': 8,
  'network-access': 3,
  'network-execution': 1,
  'remote-execution-flow': 36,
  'secret-access': 3,
  'secret-network-flow': 48,
  'dynamic-execution': 12,
  'covert-process': 16,
  'encoded-execution': 14,
  'startup-persistence': 16,
  'prompt-flood': 36,
  'content-mismatch': 44,
  'suspicious-content': 12,
  'custom-boost': 12,
};

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.go', '.gyp', '.gypi', '.h', '.hpp', '.java', '.js', '.jsx', '.kt', '.kts',
  '.mjs', '.php', '.py', '.rb', '.rs', '.sh', '.ts', '.tsx', '.yaml', '.yml',
]);

const BUILT_IN_SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.pyc', '.class', '.jar',
]);

const BUILT_IN_SKIP_PATTERNS = [/\.d\.ts$/, /\.min\.css$/];

const BUILT_IN_PROSE_EXTENSIONS = new Set([
  '.adoc', '.asciidoc', '.markdown', '.md', '.rst', '.txt',
]);

const CODE_BEARING_PROSE_BASENAMES = new Set([
  'CMakeLists.txt',
  'requirements.txt',
]);

const CODE_BEARING_TEXT_PATTERNS = [
  /^(?:requirements|constraints)(?:[-_.][^/]*)?\.txt$/i,
];

export type SpectreFileEligibilityReason =
  | 'eligible'
  | 'configured-path'
  | 'configured-extension'
  | 'built-in-extension'
  | 'built-in-pattern'
  | 'prose';

export interface SpectreFileEligibility {
  eligible: boolean;
  reason: SpectreFileEligibilityReason;
}

function matchesPattern(file: string, pattern: string): boolean {
  if (!pattern.includes('*')) {
    return file === pattern || file.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`);
  }
  const regexSource = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  return new RegExp(`^${regexSource}$`).test(file);
}

export function classifySpectreFile(file: string, config: SpectreConfig, newMode?: string): SpectreFileEligibility {
  const extension = extname(file).toLowerCase();
  const basename = posix.basename(file);
  if (config.skipPaths?.some(pattern => matchesPattern(file, pattern))) return { eligible: false, reason: 'configured-path' };
  if (config.skipExtensions?.some(item => file.endsWith(item))) return { eligible: false, reason: 'configured-extension' };
  if (BUILT_IN_SKIP_EXTENSIONS.has(extension)) return { eligible: false, reason: 'built-in-extension' };
  if (BUILT_IN_SKIP_PATTERNS.some(pattern => pattern.test(file))) return { eligible: false, reason: 'built-in-pattern' };
  if (newMode === '100755'
    || CODE_BEARING_PROSE_BASENAMES.has(basename)
    || CODE_BEARING_TEXT_PATTERNS.some(pattern => pattern.test(basename))) return { eligible: true, reason: 'eligible' };
  if (BUILT_IN_PROSE_EXTENSIONS.has(extension)) return { eligible: false, reason: 'prose' };
  return { eligible: true, reason: 'eligible' };
}

export function shouldSkipSpectreFile(file: string, config: SpectreConfig, newMode?: string): boolean {
  return !classifySpectreFile(file, config, newMode).eligible;
}

export function compileSpectreBoostPatterns(custom: readonly string[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const raw of custom) {
    try {
      patterns.push(new RegExp(raw));
    } catch {
      console.warn(`[spectre] ignoring invalid boostPattern: ${raw}`);
    }
  }
  return patterns;
}

const DEFAULT_REGISTRY_HOSTS = new Set([
  'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'index.crates.io',
  'rubygems.org', 'repo.packagist.org', 'repo1.maven.org', 'repo.maven.apache.org',
  'plugins.gradle.org', 'api.nuget.org', 'proxy.golang.org',
]);

const SUSPICIOUS_PATTERNS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\batob\s*\(/,
  /String\.fromCharCode\s*\(/,
  /(?:require\s*\(\s*['"`]child_process['"`]\s*\)|node:child_process)/,
  /\/bin\/(?:sh|bash|zsh|dash)\b/,
  /\/dev\/tcp\//,
  /\b(?:exec|spawn)(?:File|Sync)?\s*\(/,
  /\bnet\.Socket\b/,
  /169\.254\.169\.254/,
  /metadata\.google\.internal/,
  /\b(?:curl|wget)\s+\S*https?:\/\//,
  /\bimport\s*\(\s*[^'"`\s]/,
];

const PROCESS_PATTERN = /(?:\b(?:exec|execFile|execSync|spawn|spawnSync|fork)\s*\(|child_process|subprocess\.(?:run|call|Popen)|os\.(?:system|popen|exec\w*|posix_spawn\w*)|Command::new\s*\(|std::process::Command|exec\.Command\s*\(|ProcessBuilder\s*\(|Runtime\.getRuntime\(\)\.exec|Process\.Start\s*\(|\b(?:shell_exec|passthru|proc_open|popen)\s*\(|\bOpen3\.|\b(?:bash|sh|zsh)\s+-[ce]\b|\b(?:powershell|pwsh)\s+-(?:c|e|command|encodedcommand)\b)/i;
const NETWORK_PATTERN = /(?:\bfetch\s*\(|\baxios\.|requests\.(?:get|post|put)|urllib\.|reqwest(?:::|\.)|\b(?:curl|wget)\b|https?\.(?:get|request)|net\.(?:connect|Socket|Dial)|socket\.(?:socket|connect)|TcpStream::connect|\b(?:WebSocket|XMLHttpRequest)\s*\(|\.sendBeacon\s*\(|\b(?:got|superagent)\.|\bdns\.(?:resolve|resolve\w*|query)|\bdgram\.createSocket|\bsmtplib\.|\b(?:PutObject|UploadPart)Command\s*\(|\.(?:put_object|upload_file|upload_from_filename|upload_from_string|upload_blob)\s*\(|https?:\/\/)/i;
const SECRET_PATTERN = /(?:process\.env(?:\b|\[)|os\.environ|std::env::var|System\.getenv|github\.token|secrets\.[A-Za-z_]|document\.cookie|(?:localStorage|sessionStorage)\.getItem\s*\(\s*['"`][^'"`]*(?:token|secret|password|credential|session|auth|cookie)[^'"`]*['"`]|(?:readFile|readFileSync|read_text|ReadFile)\s*\([^\n]{0,240}(?:\.ssh\/id_|\.aws\/credentials|\.config\/gcloud|\.kube\/config|\.npmrc|\.pypirc|\.docker\/config\.json|\.git-credentials)|\$(?:env:)?(?:\{)?(?=[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRETS?|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY)(?:_[A-Z0-9]+)*\}?(?![A-Z0-9_]))[A-Z][A-Z0-9_]*\}?)/i;
const DYNAMIC_PATTERN = /(?:\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(|\bexec\s*\(\s*(?:compile\s*\(|base64|payload|decoded)|Invoke-Expression|\bvm\.(?:runIn|runInNewContext|runInThisContext)\s*\(|constructor\s*\.\s*constructor|(?:globalThis|window|global|__builtins__)\s*\[\s*(?:['"]ev['"]\s*\+\s*['"]al['"]|['"]ex['"]\s*\+\s*['"]ec['"])\s*\]\s*\(|getattr\s*\(\s*__builtins__\s*,\s*['"]ex['"]\s*\+\s*['"]ec['"]\s*\)\s*\(|Reflect\.get\s*\([^,\n]{1,100},\s*['"](?:eval|exec|Function)['"]\s*\)\s*\()/;
const COVERT_PATTERN = /(?:detached\s*:\s*true|stdio\s*:\s*['"]ignore['"]|windowsHide\s*:\s*true|\.unref\s*\(|CREATE_NO_WINDOW|start_new_session\s*=\s*True|nohup\b|\bdisown\b|(?:>|2>)\s*\/dev\/null)/;
const ENCODING_PATTERN = /(?:Buffer\.from\s*\([^\n]{0,300}['"](?:base64|hex)['"]|base64\.(?:b64decode|decodebytes)|binascii\.unhexlify|bytes\.fromhex|hex\.(?:DecodeString|Decode)|hex::decode\s*\(|FromBase64String|(?:gzip|zlib)\.(?:decompress|uncompress)|-EncodedCommand\b|fromCharCode|charCodeAt|\b(?:atob|btoa)\s*\(|\bXOR\b|\bxor\b)/i;
const PERSISTENCE_PATTERN = /(?:\bcrontab\b|@reboot\b|\bschtasks\b[^\n]{0,160}\/create\b|CurrentVersion[\\/]+Run(?:Once)?\b|\bsystemctl\s+(?:enable|reenable)\b|\blaunchctl\s+(?:load|bootstrap|enable)\b|^\s*ExecStart\s*=)/im;
const LIFECYCLE_PATTERN = /["'](?:preinstall|install|postinstall|prepare|prepack|prepublish|prepublishOnly)["']\s*:/;

function isCiExecutionFile(file: string): boolean {
  const basename = posix.basename(file);
  return /^\.github\/workflows\/.*\.ya?ml$/.test(file)
    || /(?:^|\/)\.github\/actions\/.*\/action\.ya?ml$/.test(file)
    || basename === '.gitlab-ci.yml'
    || basename === 'Jenkinsfile'
    || /(?:^|\/)\.circleci\/config\.ya?ml$/.test(file)
    || /(?:^|\/)\.buildkite\/(?:pipeline|steps)\.ya?ml$/.test(file)
    || /(?:^|\/)(?:azure-pipelines|buildkite)\.ya?ml$/.test(file);
}

function isStartupExecutionFile(file: string): boolean {
  const basename = posix.basename(file);
  return basename === 'sitecustomize.py'
    || basename === 'usercustomize.py'
    || /(?:^|\/)\.husky\//.test(file)
    || /(?:^|\/)\.devcontainer\/devcontainer\.json$/.test(file)
    || /\.(?:service|timer)$/.test(file)
    || /(?:^|\/)(?:LaunchAgents|LaunchDaemons)\/[^/]+\.plist$/.test(file)
    || basename === 'crontab'
    || /(?:^|\/)cron(?:\.d|\.daily|\.hourly|\.weekly|\.monthly)?\//.test(file);
}

function pathBaseScore(file: string): number {
  const basename = posix.basename(file);
  if (basename === 'build.rs' || basename === 'setup.py' || basename === 'binding.gyp' || file.endsWith('.gypi') || file.endsWith('.pth')) return 24;
  if (isCiExecutionFile(file)) return 22;
  if (isStartupExecutionFile(file)) return 20;
  if (['.npmrc', '.yarnrc.yml', 'pip.conf', 'pip.ini', '.pypirc', 'poetry.toml', 'NuGet.Config'].includes(basename)
    || /(?:^|\/)\.cargo\/config(?:\.toml)?$/.test(file)) return 20;
  if (/^(?:package\.json|pyproject\.toml|setup\.cfg|Cargo\.toml|Gemfile|composer\.json|go\.mod|pom\.xml|build\.gradle(?:\.kts)?)$/.test(basename)
    || basename.endsWith('.gemspec')) return 18;
  if (/^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|Pipfile\.lock|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/.test(basename)
    || file.endsWith('.lock')) return 10;
  if (/^(?:Dockerfile[^/]*|docker-compose[^/]*)$/.test(basename) || /^\.env/.test(file)) return 18;
  return 0;
}

function addedText(input: SpectreSignalInputFile): string {
  return input.addedLines === undefined
    ? (input.content ?? '')
    : input.addedLines.map(line => line.content).join('\n');
}

function matchingLines(input: SpectreSignalInputFile, pattern: RegExp): number[] {
  if (input.addedLines === undefined) return [];
  return input.addedLines.filter(line => {
    pattern.lastIndex = 0;
    return pattern.test(line.content);
  }).map(line => line.line).slice(0, 3);
}

function safeRelativePath(sourceFile: string, raw: string, repositoryRelative = false): string | null {
  const stripped = raw.trim().replace(/^['"]|['"]$/g, '').replace(/^[.][\/]/, '');
  if (!stripped || stripped.includes('\0') || stripped.includes('$') || stripped.includes('`') || stripped.startsWith('/')) return null;
  const resolved = posix.normalize(posix.join(repositoryRelative ? '' : posix.dirname(sourceFile), stripped));
  if (resolved === '..' || resolved.startsWith('../')) return null;
  return resolved;
}

function packageLifecycleCommands(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return '';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return '';
  const scriptsValue = (parsed as Record<string, unknown>)['scripts'];
  if (typeof scriptsValue !== 'object' || scriptsValue === null || Array.isArray(scriptsValue)) return '';
  const scripts = scriptsValue as Record<string, unknown>;
  const queue = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'prepublish', 'prepublishOnly'];
  const visited = new Set<string>();
  const commands: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const command = scripts[name];
    if (typeof command !== 'string') continue;
    commands.push(command);
    for (const match of command.matchAll(/(?:^|[;&|]\s*)(?:npm\s+(?:run|run-script)|yarn(?:\s+run)?|pnpm(?:\s+run)?)\s+(?:--[A-Za-z0-9_-]+\s+)*([A-Za-z0-9_.:-]+)/g)) {
      if (match[1]) queue.push(`pre${match[1]}`, match[1], `post${match[1]}`);
    }
  }
  return commands.join('\n');
}

function commandPathReferences(file: string, text: string): string[] {
  const references = new Set<string>();
  const repositoryRelative = isCiExecutionFile(file) || /^(?:Dockerfile[^/]*|docker-compose[^/]*)$/.test(posix.basename(file));
  const commandText = posix.basename(file) === 'package.json' ? packageLifecycleCommands(text) : text;
  const runners = String.raw`(?:node|tsx|bun|deno(?:\s+run)?|python(?:3)?|bash|sh|zsh|ruby|powershell|pwsh)`;
  const scriptPath = String.raw`((?:\.{0,2}\/)?[A-Za-z0-9_.\/-]+\.(?:js|cjs|mjs|jsx|ts|cts|mts|tsx|py|sh|rb|ps1))`;
  const patterns = [
    new RegExp(String.raw`(?:^|[;&|"'\s])${runners}\s+${scriptPath}`, 'g'),
    new RegExp(String.raw`<!@?\(\s*${runners}\s+${scriptPath}`, 'g'),
    /(?:<!@?|action|command)[^\n]{0,200}?["']((?:\.{0,2}\/)?[A-Za-z0-9_.\/-]+\.(?:js|cjs|mjs|jsx|ts|cts|mts|tsx|py|sh|rb|ps1))["']/g,
    /\bbuild\s*=\s*["']([^"']+)["']/g,
    /\buses\s*:\s*((?:\.\/)[A-Za-z0-9_.\/-]+)/g,
    /\b(?:include|add_subdirectory)\s*\(\s*["']?([A-Za-z0-9_.\/-]+)/gi,
    /(?:^|[;&|"'\s])(?:source|\.)\s+((?:\.{0,2}\/)?[A-Za-z0-9_.\/-]+\.(?:sh|bash|zsh))/g,
    /(?:^|[;&|]\s*)((?:\.{1,2}\/)[A-Za-z0-9_.\/-]+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of commandText.matchAll(pattern)) {
      const resolved = safeRelativePath(file, match[1] ?? '', repositoryRelative);
      if (resolved) references.add(resolved);
    }
  }
  if (/^(?:Dockerfile[^/]*|docker-compose[^/]*)$/.test(posix.basename(file))) {
    for (const line of text.split('\n')) {
      const instruction = line.match(/^\s*(?:COPY|ADD)\s+(?:--\S+\s+)*(.*)$/i)?.[1]?.trim();
      if (!instruction) continue;
      let paths: string[];
      if (instruction.startsWith('[')) {
        try {
          const parsed = JSON.parse(instruction) as unknown;
          paths = Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : [];
        } catch {
          paths = [];
        }
      } else {
        paths = instruction.match(/(?:[^\s"']+|["'][^"']+["'])+/g)?.map(item => item.replace(/^["']|["']$/g, '')) ?? [];
      }
      for (const source of paths.slice(0, -1)) {
        const resolved = safeRelativePath(file, source, true);
        if (resolved) references.add(resolved);
      }
    }
  }
  if (posix.basename(file) === 'pyproject.toml') {
    const backendPaths: string[] = [];
    for (const block of text.matchAll(/backend-path\s*=\s*\[([^\]]*)\]/g)) {
      for (const item of (block[1] ?? '').matchAll(/["']([^"']+)["']/g)) {
        const raw = item[1] ?? '';
        const resolved = safeRelativePath(file, raw);
        if (resolved) {
          backendPaths.push(raw);
          if (resolved !== '.') references.add(resolved);
        }
      }
    }
    const backendModule = text.match(/build-backend\s*=\s*["']([A-Za-z0-9_.-]+)(?::[^"']+)?["']/)?.[1]?.replace(/\./g, '/');
    if (backendModule) {
      for (const base of backendPaths.length > 0 ? backendPaths : ['.']) {
        for (const target of [`${base}/${backendModule}.py`, `${base}/${backendModule}`]) {
          const resolved = safeRelativePath(file, target);
          if (resolved) references.add(resolved);
        }
      }
    }
  }
  return [...references];
}

function registryOverride(text: string): boolean {
  const urlPattern = /https?:\/\/[^\s'"}]+/g;
  for (const match of text.matchAll(urlPattern)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase();
      if (!DEFAULT_REGISTRY_HOSTS.has(host)) return true;
    } catch {
      return true;
    }
  }
  return /(?:registry|index-url|extra-index-url|repository)\s*=\s*\$\{?\w+/i.test(text);
}

function promptFlood(text: string): boolean {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 8 * 1024) return false;
  const phrases = text.match(/(?:ignore (?:all |any )?(?:previous|prior|system)|system (?:message|prompt)|do not (?:scan|analy[sz]e|report)|return (?:no findings|findings\s*=)|you are (?:chatgpt|a security scanner))/gi)?.length ?? 0;
  const lines = text.split('\n');
  const uniqueRatio = lines.length === 0 ? 1 : new Set(lines).size / lines.length;
  return phrases >= 8 || (bytes >= 32 * 1024 && phrases >= 4) || (bytes >= 32 * 1024 && lines.length >= 200 && uniqueRatio < 0.1);
}

function contentMismatch(file: string, content: string): boolean {
  const extension = extname(file).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(extension)) return false;
  const prefix = content.slice(0, 8);
  const binaryMagic = prefix.startsWith('\x7fELF') || prefix.startsWith('MZ') || prefix.startsWith('PK\x03\x04') || prefix.startsWith('\0asm');
  return binaryMagic || content.slice(0, 8 * 1024).includes('\0') || /[\u202a-\u202e\u2066-\u2069]/u.test(content);
}

function automaticExecution(file: string, changed: string): boolean {
  const basename = posix.basename(file);
  if (basename === 'build.rs' || basename === 'setup.py' || basename === 'binding.gyp' || file.endsWith('.gypi') || isStartupExecutionFile(file)) return true;
  if (file.endsWith('.pth')) return changed.split('\n').some(line => /^import[\t ]/.test(line));
  if (basename === 'pyproject.toml') return /(?:build-backend|backend-path)\s*=/.test(changed);
  if (basename === 'CMakeLists.txt' || file.endsWith('.cmake')) {
    return /\b(?:execute_process|add_custom_command|add_custom_target|ExternalProject_Add|FetchContent_Declare)\s*\(/i.test(changed);
  }
  if (isCiExecutionFile(file)) return true;
  return false;
}

function addSignal(
  kinds: Set<SpectreSignalKind>,
  priorityLines: Set<number>,
  input: SpectreSignalInputFile,
  kind: SpectreSignalKind,
  pattern?: RegExp,
): void {
  kinds.add(kind);
  if (pattern) matchingLines(input, pattern).forEach(line => priorityLines.add(line));
}

export function extractSpectreSignals(
  files: readonly SpectreSignalInputFile[],
  customPatterns: readonly RegExp[] = [],
): SpectreRoutingContext {
  return extractSpectreSignalsWithStructuralFacts(files, customPatterns, []);
}

export function extractSpectreSignalsWithStructuralFacts(
  files: readonly SpectreSignalInputFile[],
  customPatterns: readonly RegExp[] = [],
  structuralFacts: readonly SpectreStructuralSignalFact[] = [],
): SpectreRoutingContext {
  const relationTargets = new Map<string, Set<string>>();
  const factsByFile = new Map<string, SpectreStructuralSignalFact[]>();
  for (const fact of structuralFacts) {
    if (!fact.intersectsAddedLine) continue;
    const existing = factsByFile.get(fact.file) ?? [];
    existing.push(fact);
    factsByFile.set(fact.file, existing);
  }
  const analyzed = files.map((input, index) => {
    const content = input.content ?? '';
    const changed = addedText(input);
    const kinds = new Set<SpectreSignalKind>();
    const priorityLines = new Set<number>();
    const relations = new Set<string>();
    const basename = posix.basename(input.file);

    if (automaticExecution(input.file, changed)) addSignal(kinds, priorityLines, input, 'automatic-execution');
    if (basename === 'package.json' && LIFECYCLE_PATTERN.test(changed)) {
      addSignal(kinds, priorityLines, input, 'manifest-lifecycle', LIFECYCLE_PATTERN);
    }
    if ((basename === 'binding.gyp' || input.file.endsWith('.gypi')) && /(?:<!@?\(|["'](?:actions|rules|postbuilds)["']\s*:)/.test(changed)) {
      addSignal(kinds, priorityLines, input, 'gyp-command', /(?:<!@?\(|["'](?:actions|rules|postbuilds)["']\s*:)/);
    }

    const workflow = /^\.github\/workflows\/.*\.ya?ml$/.test(input.file);
    const privileged = /(?:pull_request_target|workflow_run|permissions\s*:\s*write-all|(?:contents|packages|actions|id-token|pull-requests)\s*:\s*write)/.test(content);
    const untrusted = /(?:github\.event\.(?:pull_request\.(?:head\.(?:sha|ref)|title|body)|comment\.body)|github\.head_ref)/.test(content);
    const secret = /(?:\$\{\{\s*secrets\.|secrets\s*:\s*inherit|github\.token)/.test(content);
    if (workflow && privileged && /(?:pull_request_target|workflow_run|permissions\s*:\s*write-all|(?:contents|packages|actions|id-token|pull-requests)\s*:\s*write)/.test(changed)) addSignal(kinds, priorityLines, input, 'ci-privilege');
    if (workflow && untrusted && /(?:github\.event\.|github\.head_ref)/.test(changed)) addSignal(kinds, priorityLines, input, 'ci-untrusted-input');
    if (workflow && secret && /(?:secrets\.|secrets\s*:\s*inherit|github\.token)/.test(changed)) addSignal(kinds, priorityLines, input, 'ci-secret-access');
    if (workflow && privileged && untrusted && secret && changed.length > 0) addSignal(kinds, priorityLines, input, 'ci-trust-crossing');

    const registryConfig = ['.npmrc', '.yarnrc.yml', 'pip.conf', 'pip.ini', '.pypirc', 'poetry.toml', 'NuGet.Config'].includes(basename)
      || /(?:^|\/)\.cargo\/config(?:\.toml)?$/.test(input.file);
    if (registryConfig && registryOverride(changed)) addSignal(kinds, priorityLines, input, 'registry-override');
    if (/^(?:requirements|constraints)(?:[-_.][^/]*)?\.txt$/i.test(basename)
      && /(?:^|\s)(?:--(?:extra-)?index-url\s+|https?:\/\/|git\+https?:\/\/)/im.test(changed)) {
      addSignal(kinds, priorityLines, input, 'registry-override');
    }

    if (PROCESS_PATTERN.test(changed)) addSignal(kinds, priorityLines, input, 'process-execution', PROCESS_PATTERN);
    if (NETWORK_PATTERN.test(changed)) addSignal(kinds, priorityLines, input, 'network-access', NETWORK_PATTERN);
    if (NETWORK_PATTERN.test(content) && (PROCESS_PATTERN.test(content) || DYNAMIC_PATTERN.test(content))
      && (NETWORK_PATTERN.test(changed) || PROCESS_PATTERN.test(changed) || DYNAMIC_PATTERN.test(changed))) {
      addSignal(kinds, priorityLines, input, 'network-execution');
    }
    if (SECRET_PATTERN.test(changed)) addSignal(kinds, priorityLines, input, 'secret-access', SECRET_PATTERN);
    if (NETWORK_PATTERN.test(content) && SECRET_PATTERN.test(content) && (NETWORK_PATTERN.test(changed) || SECRET_PATTERN.test(changed))) {
      addSignal(kinds, priorityLines, input, 'secret-network-flow');
    }
    if (DYNAMIC_PATTERN.test(changed)) addSignal(kinds, priorityLines, input, 'dynamic-execution', DYNAMIC_PATTERN);
    if (PROCESS_PATTERN.test(content) && COVERT_PATTERN.test(content) && (PROCESS_PATTERN.test(changed) || COVERT_PATTERN.test(changed))) {
      addSignal(kinds, priorityLines, input, 'covert-process');
    }
    if (ENCODING_PATTERN.test(content) && (DYNAMIC_PATTERN.test(content) || PROCESS_PATTERN.test(content))
      && (ENCODING_PATTERN.test(changed) || DYNAMIC_PATTERN.test(changed) || PROCESS_PATTERN.test(changed))) {
      addSignal(kinds, priorityLines, input, 'encoded-execution');
    }
    if (PERSISTENCE_PATTERN.test(changed)) {
      addSignal(kinds, priorityLines, input, 'startup-persistence', PERSISTENCE_PATTERN);
    }
    if (promptFlood(changed)) addSignal(kinds, priorityLines, input, 'prompt-flood');
    if (contentMismatch(input.file, content)) addSignal(kinds, priorityLines, input, 'content-mismatch');
    if (SUSPICIOUS_PATTERNS.some(pattern => pattern.test(changed))) addSignal(kinds, priorityLines, input, 'suspicious-content');
    if (customPatterns.some(pattern => {
      pattern.lastIndex = 0;
      return pattern.test(changed);
    })) addSignal(kinds, priorityLines, input, 'custom-boost');

    for (const fact of factsByFile.get(input.file) ?? []) {
      kinds.add(fact.kind);
      if (input.addedLines !== undefined) {
        input.addedLines
          .filter(line => line.line >= fact.startLine && line.line <= fact.endLine)
          .slice(0, 3)
          .forEach(line => priorityLines.add(line.line));
      }
    }

    // Changed manifests can retain an existing execution hook while changing
    // only metadata, so relationships must be resolved from the full file.
    for (const target of commandPathReferences(input.file, content)) {
      const key = `path:${target}`;
      relations.add(key);
      const members = relationTargets.get(key) ?? new Set<string>();
      members.add(input.file);
      relationTargets.set(key, members);
    }

    let score = pathBaseScore(input.file);
    for (const kind of kinds) score += SIGNAL_WEIGHT[kind];
    if (kinds.has('automatic-execution') && (kinds.has('process-execution') || kinds.has('network-access') || kinds.has('dynamic-execution'))) score += 14;
    if (kinds.has('encoded-execution') && (kinds.has('dynamic-execution') || kinds.has('process-execution'))) score += 10;
    if (kinds.has('ci-trust-crossing')) score -= SIGNAL_WEIGHT['ci-privilege'] + SIGNAL_WEIGHT['ci-untrusted-input'] + SIGNAL_WEIGHT['ci-secret-access'];
    if (kinds.has('secret-network-flow')) score -= SIGNAL_WEIGHT['network-access'] + SIGNAL_WEIGHT['secret-access'];

    return {
      file: input.file,
      score: Math.max(0, Math.min(100, score)),
      signals: [...kinds].sort(),
      relations: [...relations].sort(),
      priorityLines: [...priorityLines].sort((left, right) => left - right),
      index,
    };
  });

  const knownFiles = new Set(analyzed.map(file => file.file));
  for (const [key, members] of relationTargets) {
    const target = key.slice('path:'.length);
    for (const file of knownFiles) {
      if (target.includes('*') ? matchesPattern(file, target) : (file === target || file.startsWith(`${target}/`))) members.add(file);
    }
  }

  const relations: SpectreRoutingRelation[] = [];
  for (const [key, members] of [...relationTargets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (members.size < 2) continue;
    const relationFiles = [...members].sort();
    relations.push({ key, files: relationFiles });
    for (const file of analyzed) if (members.has(file.file) && !file.relations.includes(key)) file.relations.push(key);
  }

  return {
    version: 1,
    files: analyzed
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ index: _index, ...file }) => file),
    relations,
  };
}

export function selectSpectreFiles(
  context: SpectreRoutingContext,
  fileCap: number,
  secondaryFileCap: number,
): SpectreSelection {
  const primary = context.files.slice(0, fileCap).map(file => file.file);
  const selected = new Set(primary);
  const elevated = context.files.filter(file => file.score >= SPECTRE_HIGH_RISK_SCORE && !selected.has(file.file));
  const relationSeeds = new Set([...primary, ...elevated.map(file => file.file)]);
  const related = new Set(context.relations
    .filter(relation => relation.files.some(file => relationSeeds.has(file)))
    .flatMap(relation => relation.files)
    .filter(file => !selected.has(file)));
  const secondaryCandidates = context.files.filter(file => !selected.has(file.file)
    && (related.has(file.file) || file.score >= SPECTRE_HIGH_RISK_SCORE));
  const secondary = secondaryCandidates.slice(0, secondaryFileCap).map(file => file.file);
  secondary.forEach(file => selected.add(file));
  const cappedFiles = context.files.filter(file => !selected.has(file.file));
  return {
    primary,
    secondary,
    selected: [...primary, ...secondary],
    capped: cappedFiles.length,
    highRiskCapped: cappedFiles.filter(file => file.score >= SPECTRE_HIGH_RISK_SCORE),
  };
}

export function renderSpectreSignalContext(
  context: SpectreRoutingContext | undefined,
  requestFiles: readonly string[],
  maximumBytes = 4 * 1024,
): string {
  if (!context || requestFiles.length === 0) return '';
  const allowed = new Set(requestFiles);
  const files = context.files
    .filter(file => allowed.has(file.file))
    .map(file => ({ path: file.file, signals: file.signals, relations: file.relations }));
  const relations = context.relations.filter(relation => relation.files.some(file => allowed.has(file)));
  const boundedRelations = relations
    .map(relation => ({ ...relation, files: relation.files.filter(file => allowed.has(file)) }))
    .filter(relation => relation.files.length > 1);
  while (files.length > 0) {
    const rendered = JSON.stringify({ version: 1, purpose: 'routing-context-only', files, relations: boundedRelations });
    if (Buffer.byteLength(rendered, 'utf8') <= maximumBytes) return rendered;
    files.pop();
  }
  return '';
}
