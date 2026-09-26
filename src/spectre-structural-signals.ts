import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';
import type { SpectreSignalKind } from './spectre-signals.js';

export { SPECTRE_STRUCTURAL_RULES_VERSION } from './spectre-structural-version.js';

export type SpectreStructuralLanguage = 'javascript' | 'typescript' | 'tsx' | 'python' | 'go';

export interface SpectreStructuralInputFile {
  file: string;
  content: string | null;
  /** Omit to treat the whole source as changed. An empty array means no source lines changed. */
  addedLines?: ReadonlyArray<{ line: number; content: string }>;
}

export interface SpectreStructuralLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFactsPerFile: number;
  maxTotalFacts: number;
  maxNodesPerFile: number;
  maxParseMsPerFile: number;
  maxTotalMs: number;
}

export const DEFAULT_SPECTRE_STRUCTURAL_LIMITS: Readonly<SpectreStructuralLimits> = Object.freeze({
  maxFiles: 200,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxFactsPerFile: 100,
  maxTotalFacts: 500,
  maxNodesPerFile: 25_000,
  maxParseMsPerFile: 100,
  maxTotalMs: 1_000,
});

export interface SpectreStructuralFact {
  file: string;
  kind: SpectreSignalKind;
  startLine: number;
  endLine: number;
  intersectsAddedLine: boolean;
}

export type SpectreStructuralParserOutcome =
  | 'parsed'
  | 'parsed-with-errors'
  | 'unsupported'
  | 'no-content'
  | 'file-limit'
  | 'byte-limit'
  | 'budget-exceeded'
  | 'cancelled'
  | 'parse-failed';

export interface SpectreStructuralFileResult {
  file: string;
  language: SpectreStructuralLanguage | null;
  outcome: SpectreStructuralParserOutcome;
  facts: SpectreStructuralFact[];
  bytes: number;
  elapsedMs: number;
  nodesVisited: number;
  budgetExceeded: boolean;
  factsTruncated: boolean;
}

export interface SpectreStructuralResult {
  files: SpectreStructuralFileResult[];
  facts: SpectreStructuralFact[];
  bytes: number;
  elapsedMs: number;
  nodesVisited: number;
  budgetExceeded: boolean;
  cancelled: boolean;
}

export interface SpectreStructuralOptions {
  limits?: Partial<SpectreStructuralLimits>;
  signal?: AbortSignal;
}

export interface SpectreStructuralIsolatedOptions extends SpectreStructuralOptions {
  /** Wall-clock worker deadline. Defaults to the total engine budget plus parser startup allowance. */
  timeoutMs?: number;
  /** Primarily useful to substitute the compiled worker in embedding environments. */
  workerUrl?: URL;
}

interface ValueInfo {
  path?: string;
  secret?: boolean;
  encoded?: boolean;
  remote?: boolean;
  changed?: boolean;
}

interface AnalysisState {
  file: string;
  language: SpectreStructuralLanguage;
  addedLines: ReadonlySet<number> | null;
  limits: SpectreStructuralLimits;
  signal?: AbortSignal;
  deadline: number;
  facts: SpectreStructuralFact[];
  factKeys: Set<string>;
  nodesVisited: number;
  budgetExceeded: boolean;
  factsTruncated: boolean;
  startupDepth: number;
}

type Environment = Map<string, ValueInfo>;
const MAX_RECURSION_DEPTH = 256;

const LANGUAGE_WASM: Record<SpectreStructuralLanguage, string> = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
};

let parserInitialized: Promise<void> | undefined;
const languageCache = new Map<SpectreStructuralLanguage, Promise<Language>>();
const require = createRequire(import.meta.url);

function limitsWithDefaults(overrides?: Partial<SpectreStructuralLimits>): SpectreStructuralLimits {
  const result = { ...DEFAULT_SPECTRE_STRUCTURAL_LIMITS, ...overrides };
  for (const key of Object.keys(result) as Array<keyof SpectreStructuralLimits>) {
    if (!Number.isFinite(result[key]) || result[key] < 0) result[key] = DEFAULT_SPECTRE_STRUCTURAL_LIMITS[key];
  }
  return result;
}

function languageForFile(file: string): SpectreStructuralLanguage | null {
  const lower = file.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.jsx') || lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  return null;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function loadLanguage(language: SpectreStructuralLanguage): Promise<Language> {
  parserInitialized ??= Parser.init();
  await parserInitialized;
  let pending = languageCache.get(language);
  if (!pending) {
    pending = Language.load(require.resolve(`tree-sitter-wasms/out/${LANGUAGE_WASM[language]}`));
    languageCache.set(language, pending);
  }
  return pending;
}

function child(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName(field);
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((item): item is SyntaxNode => item !== null);
}

function endLine(node: SyntaxNode): number {
  return node.endPosition.row + (node.endPosition.column === 0 && node.endPosition.row > node.startPosition.row ? 0 : 1);
}

function checkBudget(state: AnalysisState): boolean {
  if (state.budgetExceeded) return false;
  state.nodesVisited += 1;
  if (state.nodesVisited > state.limits.maxNodesPerFile
    || state.signal?.aborted
    || (state.nodesVisited % 64 === 0 && performance.now() >= state.deadline)) {
    state.budgetExceeded = true;
    return false;
  }
  return true;
}

function intersectsAddedLines(state: AnalysisState, node: SyntaxNode): boolean {
  if (state.addedLines === null) return true;
  const start = node.startPosition.row + 1;
  const end = endLine(node);
  for (let line = start; line <= end; line += 1) {
    if (state.addedLines.has(line)) return true;
  }
  return false;
}

function addFact(state: AnalysisState, kind: SpectreSignalKind, node: SyntaxNode, changedProvenance = false): void {
  const start = node.startPosition.row + 1;
  const end = endLine(node);
  const key = `${kind}:${start}:${end}`;
  if (state.factKeys.has(key)) return;
  if (state.facts.length >= state.limits.maxFactsPerFile) {
    state.factsTruncated = true;
    return;
  }
  state.factKeys.add(key);
  const intersectsAddedLine = changedProvenance || intersectsAddedLines(state, node);
  state.facts.push({ file: state.file, kind, startLine: start, endLine: end, intersectsAddedLine });
}

function normalizeModule(raw: string): string {
  return raw.replace(/^node:/, '');
}

function quotedValue(node: SyntaxNode | null): string | null {
  if (!node) return null;
  const raw = node.text.trim();
  if (raw.length < 2 || !['\'', '"', '`'].includes(raw[0] ?? '') || raw.at(-1) !== raw[0]) return null;
  return raw.slice(1, -1);
}

function propertyName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  const value = quotedValue(node);
  return value ?? node.text.trim();
}

function globalPath(name: string, language: SpectreStructuralLanguage, env: Environment): string | undefined {
  if (env.has(name)) return env.get(name)?.path;
  if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
    if (['fetch', 'eval', 'Function', 'Buffer', 'JSON', 'atob', 'btoa', 'process', 'require', 'WebSocket', 'XMLHttpRequest', 'navigator', 'document', 'localStorage', 'sessionStorage'].includes(name)) return name;
  }
  if (language === 'python' && ['eval', 'exec', 'compile', 'dict', 'open', 'bytes'].includes(name)) return name;
  if (language === 'go' && name === 'string') return name;
  return undefined;
}

function resolvePath(node: SyntaxNode | null, env: Environment, language: SpectreStructuralLanguage, depth = 0): string | undefined {
  if (!node || depth > MAX_RECURSION_DEPTH) return undefined;
  if (['identifier', 'property_identifier', 'field_identifier', 'package_identifier'].includes(node.type)) {
    return globalPath(node.text, language, env);
  }
  if (['parenthesized_expression', 'await_expression', 'unary_expression', 'pointer_expression'].includes(node.type)) {
    const value = child(node, 'argument') ?? namedChildren(node)[0] ?? null;
    return resolvePath(value, env, language, depth + 1);
  }
  if (['member_expression', 'attribute', 'selector_expression'].includes(node.type)) {
    const object = child(node, 'object') ?? child(node, 'operand');
    const property = child(node, 'property') ?? child(node, 'attribute') ?? child(node, 'field');
    const base = resolvePath(object, env, language, depth + 1);
    const name = propertyName(property);
    return base && name ? `${base}.${name}` : undefined;
  }
  if (['subscript_expression', 'subscript'].includes(node.type)) {
    const object = child(node, 'object') ?? child(node, 'value');
    const index = child(node, 'index') ?? child(node, 'subscript');
    const base = resolvePath(object, env, language, depth + 1);
    return base ? `${base}.${quotedValue(index) ?? '*'}` : undefined;
  }
  if (['call_expression', 'call', 'new_expression'].includes(node.type)) {
    const functionPath = resolvePath(child(node, 'function') ?? child(node, 'constructor'), env, language, depth + 1);
    if (functionPath === 'require') {
      const requested = quotedValue(child(node, 'arguments')?.namedChild(0) ?? null);
      if (requested) return normalizeModule(requested);
    }
    return functionPath;
  }
  if (node.type === 'composite_literal') return resolvePath(child(node, 'type'), env, language, depth + 1);
  return undefined;
}

function isSecretPath(path: string | undefined, language: SpectreStructuralLanguage): boolean {
  if (!path) return false;
  if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
    return path === 'process.env' || path.startsWith('process.env.') || path === 'document.cookie';
  }
  if (language === 'python') return path === 'os.environ' || path.startsWith('os.environ.') || path === 'os.getenv';
  return path === 'os.Getenv' || path === 'os.Environ';
}

const SENSITIVE_CREDENTIAL_PATH = /(?:\.ssh\/id_|\.aws\/credentials|\.config\/gcloud|\.kube\/config|\.npmrc|\.pypirc|\.docker\/config\.json|\.git-credentials)/i;
const SENSITIVE_STORAGE_KEY = /(?:token|secret|password|credential|session|auth|cookie)/i;

function isSecretCall(path: string | undefined, node: SyntaxNode, language: SpectreStructuralLanguage): boolean {
  if (!path) return false;
  if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
    if (/^(?:localStorage|sessionStorage)\.getItem$/.test(path)) return SENSITIVE_STORAGE_KEY.test(node.text);
    return /^(?:fs|fs\/promises)\.(?:readFile|readFileSync)$/.test(path) && SENSITIVE_CREDENTIAL_PATH.test(node.text);
  }
  if (language === 'python') {
    return /^(?:pathlib\.Path\.)?(?:read_text|read_bytes)$/.test(path) && SENSITIVE_CREDENTIAL_PATH.test(node.text)
      || path === 'open' && SENSITIVE_CREDENTIAL_PATH.test(node.text);
  }
  return /^(?:os|io\/os)\.ReadFile$/.test(path) && SENSITIVE_CREDENTIAL_PATH.test(node.text);
}

function isNetworkPath(path: string | undefined, language: SpectreStructuralLanguage): boolean {
  if (!path) return false;
  if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
    return path === 'fetch'
      || path === 'WebSocket'
      || path === 'XMLHttpRequest'
      || path === 'navigator.sendBeacon'
      || /^(?:WebSocket|XMLHttpRequest)\.(?:send|open)$/.test(path)
      || /^(?:ws|isomorphic-ws)(?:\.WebSocket)?(?:\.(?:send|ping))?$/.test(path)
      || /^(?:axios)(?:\.(?:request|get|post|put|patch|delete|head|options))?$/.test(path)
      || /^(?:undici)\.(?:fetch|request|stream|pipeline|connect)$/.test(path)
      || /^(?:got|superagent)(?:\.(?:get|post|put|patch|delete|head|options|stream))?$/.test(path)
      || /^(?:@aws-sdk\/client-s3\.)?(?:S3Client\.)?send$/.test(path)
      || /^(?:@google-cloud\/storage\.)?.*\.(?:save|upload)$/.test(path)
      || /^(?:@azure\/storage-blob\.)?.*\.(?:upload|uploadData|uploadFile|uploadStream)$/.test(path)
      || /^(?:http|https)\.(?:get|request)$/.test(path)
      || /^net\.(?:connect|createConnection|Socket)$/.test(path)
      || /^dns\.(?:resolve|resolve\w*|lookup)$/.test(path)
      || /^dgram\.createSocket$/.test(path);
  }
  if (language === 'python') {
    return /^(?:requests|httpx)(?:\.(?:request|get|post|put|patch|delete|head|options))$/.test(path)
      || /^(?:requests\.Session|httpx\.(?:Client|AsyncClient))\.(?:request|get|post|put|patch|delete|head|options)$/.test(path)
      || /^urllib(?:\.request)?\.(?:urlopen|urlretrieve|Request)$/.test(path)
      || /^aiohttp(?:\.ClientSession)?(?:\.(?:request|get|post|put|patch|delete|head|options))$/.test(path)
      || /^websockets\.connect$/.test(path)
      || /^dns\.resolver\.(?:resolve|query)$/.test(path)
      || /^smtplib\.(?:SMTP|SMTP_SSL)$/.test(path)
      || /^smtplib\.(?:SMTP|SMTP_SSL)\.(?:sendmail|send_message)$/.test(path)
      || /^boto3\.client\.(?:put_object|upload_file|upload_fileobj)$/.test(path)
      || /^(?:google\.cloud\.storage|azure\.storage\.blob).*(?:upload_from_filename|upload_from_string|upload_blob)$/.test(path)
      || /^socket\.(?:socket|create_connection|connect)$/.test(path)
      || /^socket\.socket\.(?:connect|connect_ex|send|sendall)$/.test(path);
  }
  return /^(?:net\/http)\.(?:Get|Post|PostForm|Head|Do)$/.test(path)
    || /^net\/http(?:\.[A-Za-z_]\w*)+\.(?:Get|Post|PostForm|Head|Do)$/.test(path)
    || /^net\.(?:Dial|DialTimeout|Listen|ListenPacket)$/.test(path)
    || /^(?:cloud\.google\.com\/go\/storage).*(?:NewWriter|Write)$/.test(path)
    || /^(?:github\.com\/aws\/aws-sdk-go).*(?:PutObject)$/.test(path);
}

function isProcessPath(path: string | undefined, language: SpectreStructuralLanguage): boolean {
  if (!path) return false;
  if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
    return /^child_process\.(?:exec|execFile|execSync|execFileSync|spawn|spawnSync|fork)$/.test(path);
  }
  if (language === 'python') {
    return /^subprocess\.(?:run|call|Popen|check_call|check_output)$/.test(path)
      || /^os\.(?:system|popen|exec\w*|posix_spawn\w*)$/.test(path);
  }
  return /^os\/exec\.(?:Command|CommandContext)$/.test(path);
}

function isDynamicPath(path: string | undefined, language: SpectreStructuralLanguage): boolean {
  if (!path) return false;
  if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
    return path === 'eval' || path === 'Function' || /^vm\.(?:runInContext|runInNewContext|runInThisContext|compileFunction|Script)$/.test(path);
  }
  return language === 'python' && ['eval', 'exec', 'compile'].includes(path);
}

function isEncodingCall(path: string | undefined, node: SyntaxNode, language: SpectreStructuralLanguage): boolean {
  if (!path) return false;
  if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
    if (path === 'atob') return true;
    if (path === 'Buffer.from') return /["'`](?:base64|hex)["'`]/.test(node.text);
    if (/^(?:zlib)\.(?:gunzip|gunzipSync|inflate|inflateSync|unzip|unzipSync)$/.test(path)) return true;
    return false;
  }
  if (language === 'python') {
    return /^base64\.(?:b64decode|standard_b64decode|urlsafe_b64decode|decodebytes)$/.test(path)
      || /^binascii\.unhexlify$/.test(path)
      || /^bytes\.fromhex$/.test(path)
      || /^(?:gzip|zlib)\.decompress$/.test(path);
  }
  return /^encoding\/(?:base64|hex)\..*\.(?:DecodeString|Decode)$/.test(path);
}

function optionMatches(node: SyntaxNode, language: SpectreStructuralLanguage, state: AnalysisState, depth = 0): boolean {
  if (depth > MAX_RECURSION_DEPTH) {
    state.budgetExceeded = true;
    return false;
  }
  if (!checkBudget(state)) return false;
  if ((language === 'javascript' || language === 'typescript' || language === 'tsx') && node.type === 'pair') {
    const key = propertyName(child(node, 'key'));
    const value = child(node, 'value')?.text.trim();
    if ((key === 'detached' || key === 'windowsHide') && value === 'true') return true;
    if (key === 'stdio' && value && /^["'`]ignore["'`]$/.test(value)) return true;
  }
  if (language === 'python' && node.type === 'keyword_argument') {
    const key = propertyName(child(node, 'name'));
    const value = child(node, 'value')?.text.trim();
    if (key === 'start_new_session' && value === 'True') return true;
    if ((key === 'stdout' || key === 'stderr') && value && /^(?:subprocess\.)?DEVNULL$/.test(value)) return true;
  }
  return namedChildren(node).some(item => optionMatches(item, language, state, depth + 1));
}

function mergeValue(target: ValueInfo, source: ValueInfo): void {
  target.secret ||= source.secret;
  target.encoded ||= source.encoded;
  target.remote ||= source.remote;
  target.changed ||= source.changed;
}

function isCallableNode(node: SyntaxNode): boolean {
  return [
    'function_declaration', 'function_expression', 'arrow_function', 'generator_function_declaration', 'generator_function',
    'function_definition', 'lambda', 'method_definition', 'method_declaration', 'func_literal',
  ].includes(node.type);
}

function isTransparentCall(path: string | undefined, language: SpectreStructuralLanguage): boolean {
  if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
    return path === 'JSON.stringify'
      || path === 'Buffer.from.toString'
      || /(?:^|\.)(?:PutObject|UploadPart)Command$/.test(path ?? '');
  }
  if (language === 'python') {
    return path === 'dict' || /^base64\.(?:b64decode|standard_b64decode|urlsafe_b64decode|decodebytes)\.decode$/.test(path ?? '');
  }
  return path === 'string' || path === 'strings.NewReader' || path === 'bytes.NewReader';
}

function analyzeExpression(node: SyntaxNode | null, env: Environment, state: AnalysisState, depth = 0): ValueInfo {
  if (!node) return {};
  if (depth > MAX_RECURSION_DEPTH) {
    state.budgetExceeded = true;
    return {};
  }
  if (!checkBudget(state)) return {};
  const language = state.language;
  if (isCallableNode(node)) {
    processCallable(node, env, state, depth);
    return {};
  }
  const path = resolvePath(node, env, language);
  const bound = ['identifier', 'property_identifier', 'field_identifier', 'package_identifier'].includes(node.type)
    ? env.get(node.text)
    : undefined;

  if (isSecretPath(path, language)) {
    addFact(state, 'secret-access', node, bound?.changed);
    return { path, secret: true, changed: bound?.changed };
  }

  if (['identifier', 'property_identifier', 'field_identifier', 'package_identifier'].includes(node.type)) {
    return { ...(env.get(node.text) ?? {}), path };
  }

  if (['call_expression', 'call', 'new_expression'].includes(node.type)) {
    const functionNode = child(node, 'function') ?? child(node, 'constructor');
    const combined: ValueInfo = {};
    mergeValue(combined, analyzeExpression(functionNode, env, state, depth + 1));
    const argumentsNode = child(node, 'arguments');
    for (const argument of argumentsNode ? namedChildren(argumentsNode) : []) mergeValue(combined, analyzeExpression(argument, env, state, depth + 1));

    const secret = isSecretPath(path, language) || isSecretCall(path, node, language);
    const network = isNetworkPath(path, language);
    const processExecution = isProcessPath(path, language);
    const dynamic = isDynamicPath(path, language);
    const encoding = isEncodingCall(path, node, language);
    const changed = intersectsAddedLines(state, node) || combined.changed;
    if (secret) addFact(state, 'secret-access', node, changed);
    if (network) addFact(state, 'network-access', node, changed);
    if (processExecution) addFact(state, 'process-execution', node, changed);
    if (dynamic) addFact(state, 'dynamic-execution', node, changed);
    if ((processExecution || dynamic) && combined.remote) addFact(state, 'remote-execution-flow', node, changed);
    if (network && combined.secret) addFact(state, 'secret-network-flow', node, changed);
    if ((processExecution || dynamic) && combined.encoded) addFact(state, 'encoded-execution', node, changed);
    if (processExecution && optionMatches(node, language, state)) addFact(state, 'covert-process', node, changed);
    if (path?.endsWith('.unref') && isProcessPath(path.slice(0, -'.unref'.length), language)) addFact(state, 'covert-process', node, changed);
    if (state.startupDepth > 0 && (network || processExecution || dynamic)) addFact(state, 'startup-persistence', node, changed);
    const transparent = isTransparentCall(path, language);
    return {
      path,
      secret: secret || (combined.secret && transparent),
      encoded: encoding || (combined.encoded && (dynamic || transparent)),
      remote: network || (combined.remote && !processExecution && !dynamic),
      changed,
    };
  }

  const combined: ValueInfo = { path };
  for (const item of namedChildren(node)) mergeValue(combined, analyzeExpression(item, env, state, depth + 1));
  return combined;
}

function moduleFromRequire(node: SyntaxNode | null, env: Environment): string | null {
  if (!node || node.type !== 'call_expression') return null;
  const functionNode = child(node, 'function');
  if (functionNode?.text !== 'require' || env.has('require')) return null;
  const argument = child(node, 'arguments')?.namedChild(0) ?? null;
  const value = quotedValue(argument);
  return value ? normalizeModule(value) : null;
}

function bindPattern(pattern: SyntaxNode | null, value: ValueInfo, env: Environment): void {
  if (!pattern) return;
  if (['identifier', 'package_identifier'].includes(pattern.type)) {
    env.set(pattern.text, value);
    return;
  }
  if (pattern.type === 'object_pattern') {
    for (const item of namedChildren(pattern)) {
      if (item.type === 'pair_pattern') {
        const key = propertyName(child(item, 'key'));
        const target = child(item, 'value');
        if (key && target) bindPattern(target, { ...value, path: value.path ? `${value.path}.${key}` : undefined }, env);
      } else {
        const name = item.text;
        env.set(name, { ...value, path: value.path ? `${value.path}.${name}` : undefined });
      }
    }
    return;
  }
  if (['array_pattern', 'list_pattern', 'tuple_pattern', 'assignment_pattern', 'rest_pattern'].includes(pattern.type)) {
    for (const item of namedChildren(pattern)) bindPattern(item, {}, env);
  }
}

function bindJavascriptImport(node: SyntaxNode, env: Environment, state: AnalysisState): void {
  const source = quotedValue(child(node, 'source'));
  if (!source) return;
  const module = normalizeModule(source);
  const changed = intersectsAddedLines(state, node);
  const text = node.text;
  const defaultMatch = text.match(/^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/);
  if (defaultMatch?.[1]) env.set(defaultMatch[1], { path: module, changed });
  const namespaceMatch = text.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaceMatch?.[1]) env.set(namespaceMatch[1], { path: module, changed });
  const namedMatch = text.match(/\{([^}]*)\}/s);
  for (const part of namedMatch?.[1]?.split(',') ?? []) {
    const match = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    if (match?.[1]) env.set(match[2] ?? match[1], { path: `${module}.${match[1]}`, changed });
  }
}

function bindPythonImport(node: SyntaxNode, env: Environment, state: AnalysisState): void {
  const text = node.text.trim();
  const changed = intersectsAddedLines(state, node);
  if (node.type === 'import_statement') {
    for (const part of text.replace(/^import\s+/, '').split(',')) {
      const match = part.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?$/);
      if (match?.[1]) env.set(match[2] ?? match[1].split('.')[0]!, { path: match[1], changed });
    }
    return;
  }
  const match = text.match(/^from\s+([\w.]+)\s+import\s+(.+)$/s);
  if (!match?.[1] || !match[2]) return;
  for (const part of match[2].replace(/[()]/g, '').split(',')) {
    const imported = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
    if (imported?.[1]) env.set(imported[2] ?? imported[1], { path: `${match[1]}.${imported[1]}`, changed });
  }
}

function bindGoImport(node: SyntaxNode, env: Environment, state: AnalysisState): void {
  const path = quotedValue(child(node, 'path'));
  if (!path) return;
  const explicit = child(node, 'name')?.text;
  if (explicit === '_' || explicit === '.') return;
  const local = explicit ?? path.split('/').at(-1);
  if (local) env.set(local, { path, changed: intersectsAddedLines(state, node) });
}

function bindParameterContainer(container: SyntaxNode | null, env: Environment): void {
  if (!container) return;
  for (const parameter of namedChildren(container)) {
    if (['identifier', 'package_identifier'].includes(parameter.type)) {
      bindPattern(parameter, {}, env);
      continue;
    }
    const names = parameter.childrenForFieldName('name').filter((item): item is SyntaxNode => item !== null);
    if (names.length > 0) {
      for (const name of names) bindPattern(name, {}, env);
      continue;
    }
    const pattern = child(parameter, 'pattern') ?? child(parameter, 'left') ?? child(parameter, 'argument');
    if (pattern) {
      bindPattern(pattern, {}, env);
      continue;
    }
    const typeNode = child(parameter, 'type');
    const candidate = namedChildren(parameter).find(item => item !== typeNode);
    if (candidate) bindPattern(candidate, {}, env);
  }
}

function bindFunctionParameters(node: SyntaxNode, env: Environment): void {
  bindParameterContainer(child(node, 'receiver'), env);
  bindParameterContainer(child(node, 'parameters'), env);
}

function processCallable(node: SyntaxNode, env: Environment, state: AnalysisState, depth: number): void {
  const parameters = child(node, 'parameters');
  for (const parameter of parameters ? namedChildren(parameters) : []) {
    analyzeExpression(child(parameter, 'value'), env, state, depth + 1);
  }
  const local = new Map(env);
  const name = child(node, 'name');
  if (name && ['identifier', 'package_identifier'].includes(name.type)) local.set(name.text, {});
  bindFunctionParameters(node, local);
  const body = child(node, 'body');
  const previousStartupDepth = state.startupDepth;
  const startup = state.language === 'go' && child(node, 'name')?.text === 'init';
  state.startupDepth = startup ? previousStartupDepth + 1 : 0;
  try {
    if (body) processNode(body, local, state, depth + 1);
  } finally {
    state.startupDepth = previousStartupDepth;
  }
}

function processNode(node: SyntaxNode, env: Environment, state: AnalysisState, depth = 0): void {
  if (depth > MAX_RECURSION_DEPTH) {
    state.budgetExceeded = true;
    return;
  }
  if (!checkBudget(state)) return;
  const language = state.language;

  if ((language === 'javascript' || language === 'typescript' || language === 'tsx') && node.type === 'import_statement') {
    bindJavascriptImport(node, env, state);
    return;
  }
  if (language === 'python' && (node.type === 'import_statement' || node.type === 'import_from_statement')) {
    bindPythonImport(node, env, state);
    return;
  }
  if (language === 'go' && node.type === 'import_spec') {
    bindGoImport(node, env, state);
    return;
  }

  if (isCallableNode(node)) {
    const name = child(node, 'name');
    if (name) env.set(name.text, {});
    processCallable(node, env, state, depth);
    return;
  }

  if (node.type === 'variable_declarator') {
    const name = child(node, 'name');
    const valueNode = child(node, 'value');
    const required = moduleFromRequire(valueNode, env);
    const value = required ? { path: required } : analyzeExpression(valueNode, env, state);
    bindPattern(name, { ...value, changed: value.changed || intersectsAddedLines(state, node) }, env);
    return;
  }

  if (node.type === 'assignment' || node.type === 'assignment_expression') {
    const left = child(node, 'left');
    const right = child(node, 'right');
    const value = analyzeExpression(right, env, state);
    bindPattern(left, { ...value, changed: value.changed || intersectsAddedLines(state, node) }, env);
    return;
  }

  if (node.type === 'short_var_declaration' || node.type === 'assignment_statement') {
    const left = child(node, 'left');
    const right = child(node, 'right');
    const leftItems = left ? namedChildren(left) : [];
    const rightItems = right ? namedChildren(right) : [];
    leftItems.forEach((item, index) => {
      const value = analyzeExpression(rightItems[index] ?? null, env, state);
      bindPattern(item, { ...value, changed: value.changed || intersectsAddedLines(state, node) }, env);
    });
    return;
  }

  if (node.type === 'var_spec') {
    const names = node.childrenForFieldName('name').filter((item): item is SyntaxNode => item !== null);
    const values = namedChildren(child(node, 'value') ?? node).filter(item => item.type !== 'identifier' || !names.includes(item));
    names.forEach((item, index) => {
      const value = analyzeExpression(values[index] ?? null, env, state);
      bindPattern(item, { ...value, changed: value.changed || intersectsAddedLines(state, node) }, env);
    });
    return;
  }

  if (node.type === 'expression_statement') {
    const expression = namedChildren(node)[0] ?? null;
    if (expression?.type === 'assignment' || expression?.type === 'assignment_expression') processNode(expression, env, state, depth + 1);
    else analyzeExpression(expression, env, state);
    return;
  }

  if (['call_expression', 'call', 'new_expression'].includes(node.type)
    || isSecretPath(resolvePath(node, env, language), language)) {
    analyzeExpression(node, env, state);
    return;
  }

  if (['program', 'module', 'source_file', 'block'].includes(node.type)) {
    const local = node.type === 'block' && language !== 'python' ? new Map(env) : env;
    for (const item of namedChildren(node)) processNode(item, local, state, depth + 1);
    return;
  }

  for (const item of namedChildren(node)) processNode(item, env, state, depth + 1);
}

function emptyResult(
  file: SpectreStructuralInputFile,
  language: SpectreStructuralLanguage | null,
  outcome: SpectreStructuralParserOutcome,
  bytes: number,
  budgetExceeded = false,
): SpectreStructuralFileResult {
  return { file: file.file, language, outcome, facts: [], bytes, elapsedMs: 0, nodesVisited: 0, budgetExceeded, factsTruncated: false };
}

function sortFacts(facts: SpectreStructuralFact[]): void {
  facts.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine || compareStrings(a.kind, b.kind));
}

/** Direct bounded engine. It parses source text but never evaluates or imports it. */
export async function analyzeSpectreStructuralSignals(
  files: readonly SpectreStructuralInputFile[],
  options: SpectreStructuralOptions = {},
): Promise<SpectreStructuralResult> {
  const started = performance.now();
  const limits = limitsWithDefaults(options.limits);
  const deadline = started + limits.maxTotalMs;
  const sorted = [...files].sort((a, b) => compareStrings(a.file, b.file));
  const results: SpectreStructuralFileResult[] = [];
  let totalBytes = 0;
  let totalFacts = 0;
  let totalNodes = 0;
  let budgetExceeded = false;

  for (let index = 0; index < sorted.length; index += 1) {
    const input = sorted[index]!;
    const language = languageForFile(input.file);
    const bytes = input.content === null ? 0 : Buffer.byteLength(input.content, 'utf8');
    if (index >= limits.maxFiles) {
      results.push(emptyResult(input, language, 'file-limit', bytes, true));
      budgetExceeded = true;
      continue;
    }
    if (options.signal?.aborted) {
      results.push(emptyResult(input, language, 'cancelled', bytes, true));
      budgetExceeded = true;
      continue;
    }
    if (!language) {
      results.push(emptyResult(input, null, 'unsupported', bytes));
      continue;
    }
    if (input.content === null) {
      results.push(emptyResult(input, language, 'no-content', 0));
      continue;
    }
    if (bytes > limits.maxFileBytes || totalBytes + bytes > limits.maxTotalBytes) {
      results.push(emptyResult(input, language, 'byte-limit', bytes, true));
      budgetExceeded = true;
      continue;
    }
    if (performance.now() >= deadline) {
      results.push(emptyResult(input, language, 'budget-exceeded', bytes, true));
      budgetExceeded = true;
      continue;
    }

    const fileStarted = performance.now();
    totalBytes += bytes;
    const state: AnalysisState = {
      file: input.file,
      language,
      addedLines: input.addedLines === undefined ? null : new Set(input.addedLines.map(item => item.line)),
      limits: { ...limits, maxFactsPerFile: Math.min(limits.maxFactsPerFile, Math.max(0, limits.maxTotalFacts - totalFacts)) },
      signal: options.signal,
      deadline: Math.min(deadline, fileStarted + limits.maxParseMsPerFile),
      facts: [],
      factKeys: new Set(),
      nodesVisited: 0,
      budgetExceeded: false,
      factsTruncated: false,
      startupDepth: 0,
    };
    let outcome: SpectreStructuralParserOutcome = 'parse-failed';
    let parser: Parser | undefined;
    try {
      const parserLanguage = await loadLanguage(language);
      if (options.signal?.aborted) {
        outcome = 'cancelled';
        state.budgetExceeded = true;
      } else {
        state.deadline = Math.min(deadline, performance.now() + limits.maxParseMsPerFile);
        parser = new Parser();
        parser.setLanguage(parserLanguage);
        const tree = parser.parse(input.content, null, {
          progressCallback: () => options.signal?.aborted === true || performance.now() >= state.deadline,
        });
        if (!tree) {
          outcome = options.signal?.aborted ? 'cancelled' : 'budget-exceeded';
          state.budgetExceeded = true;
        } else {
          const hasError = tree.rootNode.hasError;
          processNode(tree.rootNode, new Map(), state);
          outcome = state.budgetExceeded
            ? (options.signal?.aborted ? 'cancelled' : 'budget-exceeded')
            : (hasError ? 'parsed-with-errors' : 'parsed');
          tree.delete();
        }
      }
    } catch {
      outcome = options.signal?.aborted ? 'cancelled' : 'parse-failed';
    } finally {
      parser?.delete();
    }
    sortFacts(state.facts);
    totalFacts += state.facts.length;
    totalNodes += state.nodesVisited;
    budgetExceeded ||= state.budgetExceeded || state.factsTruncated;
    results.push({
      file: input.file,
      language,
      outcome,
      facts: state.facts,
      bytes,
      elapsedMs: performance.now() - fileStarted,
      nodesVisited: state.nodesVisited,
      budgetExceeded: state.budgetExceeded,
      factsTruncated: state.factsTruncated,
    });
  }

  const facts = results.flatMap(result => result.facts);
  return {
    files: results,
    facts,
    bytes: totalBytes,
    elapsedMs: performance.now() - started,
    nodesVisited: totalNodes,
    budgetExceeded,
    cancelled: options.signal?.aborted === true,
  };
}

/**
 * Production isolation wrapper. The worker URL intentionally points at emitted JavaScript;
 * source-mode tests should call or inject the direct engine above.
 */
export function analyzeSpectreStructuralSignalsIsolated(
  files: readonly SpectreStructuralInputFile[],
  options: SpectreStructuralIsolatedOptions = {},
): Promise<SpectreStructuralResult> {
  const limits = limitsWithDefaults(options.limits);
  const timeoutMs = options.timeoutMs ?? limits.maxTotalMs + 2_000;
  if (options.signal?.aborted) return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
  const started = performance.now();
  const sorted = [...files].sort((a, b) => compareStrings(a.file, b.file));
  const workerFiles: SpectreStructuralInputFile[] = [];
  const prefabricated = new Map<string, SpectreStructuralFileResult[]>();
  let totalBytes = 0;
  let preBudgetExceeded = false;
  const store = (result: SpectreStructuralFileResult): void => {
    prefabricated.set(result.file, [...(prefabricated.get(result.file) ?? []), result]);
  };
  for (let index = 0; index < sorted.length; index += 1) {
    const input = sorted[index]!;
    const language = languageForFile(input.file);
    const bytes = input.content === null ? 0 : Buffer.byteLength(input.content, 'utf8');
    if (index >= limits.maxFiles) {
      store(emptyResult(input, language, 'file-limit', bytes, true));
      preBudgetExceeded = true;
    } else if (!language) {
      store(emptyResult(input, null, 'unsupported', bytes));
    } else if (input.content === null) {
      store(emptyResult(input, language, 'no-content', 0));
    } else if (bytes > limits.maxFileBytes || totalBytes + bytes > limits.maxTotalBytes) {
      store(emptyResult(input, language, 'byte-limit', bytes, true));
      preBudgetExceeded = true;
    } else {
      totalBytes += bytes;
      workerFiles.push(input);
    }
  }

  if (workerFiles.length === 0) {
    const results = sorted.map(input => prefabricated.get(input.file)!.shift()!);
    return Promise.resolve({
      files: results, facts: [], bytes: 0, elapsedMs: performance.now() - started, nodesVisited: 0,
      budgetExceeded: preBudgetExceeded, cancelled: false,
    });
  }
  const worker = new Worker(options.workerUrl ?? new URL('./spectre-structural-signals-worker.js', import.meta.url), {
    workerData: { files: workerFiles, limits },
    resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      callback();
    };
    const onAbort = (): void => finish(() => reject(new DOMException('The operation was aborted', 'AbortError')));
    const timer = setTimeout(() => finish(() => reject(new Error('structural-worker-timeout'))), timeoutMs);
    worker.once('message', message => finish(() => {
      const workerResult = message as SpectreStructuralResult;
      const parsed = new Map<string, SpectreStructuralFileResult[]>();
      for (const result of workerResult.files) parsed.set(result.file, [...(parsed.get(result.file) ?? []), result]);
      const results = sorted.map(input => prefabricated.get(input.file)?.shift() ?? parsed.get(input.file)?.shift()).filter(
        (result): result is SpectreStructuralFileResult => result !== undefined,
      );
      const facts = results.flatMap(result => result.facts);
      resolve({
        files: results,
        facts,
        bytes: workerResult.bytes,
        elapsedMs: performance.now() - started,
        nodesVisited: workerResult.nodesVisited,
        budgetExceeded: preBudgetExceeded || workerResult.budgetExceeded,
        cancelled: workerResult.cancelled,
      });
    }));
    worker.once('error', () => finish(() => reject(new Error('structural-worker-failed'))));
    worker.once('exit', code => {
      if (code !== 0) finish(() => reject(new Error('structural-worker-failed')));
    });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
