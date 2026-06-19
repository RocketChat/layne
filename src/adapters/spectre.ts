import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { getModel, completeSimple, type TextContent } from '@mariozechner/pi-ai';
import { debug } from '../debug.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { SpectreConfig, SpectreRawFinding, Severity, LineRangesByFile, LineRange } from '../types.js';

// ---------------------------------------------------------------------------
// Built-in skip lists (never configurable — these are never security-relevant)
// ---------------------------------------------------------------------------

const BUILT_IN_SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.pyc', '.class', '.jar',
  '.css', '.scss', '.sass', '.less',
]);

const BUILT_IN_SKIP_PATTERNS: RegExp[] = [
  /\.d\.ts$/,
  /\.min\.js$/,
  /\.min\.css$/,
];

// ---------------------------------------------------------------------------
// Tier 1: high-value targets — counted first against the cap, never dropped
// for being beyond fileCap unless fileCap itself is exhausted by tier 1 alone.
// ---------------------------------------------------------------------------

const TIER1_PATTERNS: RegExp[] = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /\.lock$/,
  /^\.github\/workflows\//,
  /^Dockerfile/,
  /^docker-compose/,
  /^\.env/,
];

// ---------------------------------------------------------------------------
// Tier 2: content-based keyword patterns
// Files whose full content matches any of these are promoted above the cap
// ahead of ordinary tier-3 files.
// ---------------------------------------------------------------------------

const TIER2_PATTERNS: RegExp[] = [
  // Dynamic code execution
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,

  // Base64 / encoding decode
  /\batob\s*\(/,
  /String\.fromCharCode\s*\(/,

  // Shell execution
  /require\s*\(\s*['"`]child_process['"`]\s*\)/,
  /\/bin\/(?:sh|bash|zsh|dash)\b/,
  /\/dev\/tcp\//,
  /\bexecSync\s*\(/,
  /\bspawnSync\s*\(/,

  // Raw TCP / exfiltration sinks
  /\bnet\.Socket\b/,
  /169\.254\.169\.254/,
  /metadata\.google\.internal/,

  // Supply-chain lifecycle hooks
  /"(?:postinstall|preinstall|prepare)"\s*:/,

  // Remote fetch in shell/CI steps
  /\b(?:curl|wget)\s+\S*https?:\/\//,

  // Dynamic import/require with a non-literal argument
  /\bimport\s*\(\s*[^'"`\s]/,
];

// ---------------------------------------------------------------------------
// Severity ranking for minSeverity filtering
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high:     3,
  medium:   2,
  low:      1,
  info:     0,
};

// ---------------------------------------------------------------------------
// Allowed ruleIds — anything else is rejected
// ---------------------------------------------------------------------------

const ALLOWED_RULE_IDS = new Set([
  'reverse-shell',
  'credential-exfiltration',
  'obfuscated-payload',
  'backdoor',
  'supply-chain-abuse',
  'covert-execution',
]);

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

// The analysis instructions are customisable per-repo via toolConfig.prompt.
// The JSON response format is always appended unchanged so parsers never break.

const DEFAULT_ANALYSIS_INSTRUCTIONS =
  'You are a security code reviewer specialising in detecting malicious intent in pull request changes. ' +
  'Analyse the provided file for: reverse shells, backdoors, credential exfiltration, ' +
  'obfuscated payloads, and supply-chain attacks. ' +
  'Report ONLY confirmed malicious patterns with high confidence. ' +
  'Do not report: bugs, style issues, theoretical vulnerabilities, ordinary insecure code, ' +
  'eval/exec/spawn in clearly benign static contexts, or unknown packages with no hostile behavior in the provided diff.';

const JSON_RESPONSE_SUFFIX =
  'For each finding, copy the smallest exact verbatim contiguous snippet from the file that uniquely identifies the malicious logic. ' +
  'Do not paraphrase, insert ellipses, or combine non-adjacent lines. ' +
  'Respond ONLY with a JSON object — no markdown, no explanation outside the JSON:\n' +
  '{"findings": [{"file": "path/to/file", "startLine": 1, "endLine": 2, ' +
  '"severity": "high|medium|low", ' +
  '"ruleId": "reverse-shell|credential-exfiltration|obfuscated-payload|backdoor|supply-chain-abuse|covert-execution", ' +
  '"message": "brief description of the malicious pattern", ' +
  '"evidence": "exact verbatim snippet from the file"}]}\n' +
  'If there are no findings, respond with {"findings": []}.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTier1(file: string): boolean {
  return TIER1_PATTERNS.some(p => p.test(file));
}

function shouldSkipFile(file: string, config: SpectreConfig): boolean {
  const ext = extname(file).toLowerCase();
  if (BUILT_IN_SKIP_EXTENSIONS.has(ext)) return true;
  if (BUILT_IN_SKIP_PATTERNS.some(p => p.test(file))) return true;
  if (config.skipExtensions?.some(e => file.endsWith(e))) return true;
  if (config.skipPaths?.some(p => matchesPattern(file, p))) return true;
  return false;
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

function truncateToLines(content: string, maxLines: number): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join('\n') + '\n[truncated — diff exceeded line cap]';
}

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

interface RawFindingFromLLM {
  file?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  severity?: unknown;
  ruleId?: unknown;
  message?: unknown;
  evidence?: unknown;
}

function normalizeFinding(raw: RawFindingFromLLM, expectedFile: string): SpectreRawFinding | null {
  if (typeof raw.severity !== 'string') return null;
  if (typeof raw.message !== 'string' || !raw.message.trim()) return null;
  if (typeof raw.ruleId !== 'string' || !ALLOWED_RULE_IDS.has(raw.ruleId)) return null;
  if (typeof raw.evidence !== 'string' || !raw.evidence.trim()) return null;

  const startLine = normalizePositiveInt(raw.startLine) ?? 1;
  const endLine   = normalizePositiveInt(raw.endLine) ?? startLine;

  return {
    file:      expectedFile,
    line:      startLine,
    startLine,
    endLine:   endLine >= startLine ? endLine : startLine,
    severity:  raw.severity as SpectreRawFinding['severity'],
    message:   raw.message.trim(),
    ruleId:    raw.ruleId,
    evidence:  raw.evidence.trim(),
    tool:      'spectre',
  };
}

async function runConcurrent<T>(
  items: string[],
  concurrency: number,
  fn: (item: string) => Promise<T[]>,
): Promise<T[]> {
  const results: T[] = [];
  const queue = [...items];

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) break;
        const found = await fn(item);
        results.push(...found);
      }
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// Per-file scan
// ---------------------------------------------------------------------------

async function scanFile({
  file,
  diffContent,
  workspacePath,
  changedLineRanges,
   
  model,
  maxDiffLines,
  systemPrompt,
}: {
  file: string;
  diffContent: string | null;
  workspacePath: string;
  changedLineRanges: LineRangesByFile | Record<string, LineRange[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  maxDiffLines: number;
  systemPrompt: string;
}): Promise<SpectreRawFinding[]> {
  let content = diffContent;

  if (!content) {
    try {
      content = await readFile(join(workspacePath, file), 'utf8');
    } catch {
      debug('spectre', `could not read file: ${file}`);
      return [];
    }
  }

  content = truncateToLines(content, maxDiffLines);

  const ranges: LineRange[] = changedLineRanges instanceof Map
    ? (changedLineRanges.get(file) ?? [])
    : ((changedLineRanges as Record<string, LineRange[]>)[file] ?? []);

  const rangeStr = ranges.length > 0
    ? `Changed lines in this PR: ${ranges.map(r => `${r.start}-${r.end}`).join(', ')}\n`
    : '';

  const userMessage = `File: ${file}\n${rangeStr}\n${content}`;

  let responseText = '';
  try {
    const result = await completeSimple(model, {
      systemPrompt,
      messages: [{
        role:      'user' as const,
        timestamp: Date.now(),
        content:   userMessage,
      }],
    }, { temperature: 0 });

    responseText = result.content
      .filter((c): c is TextContent => c.type === 'text')
      .map(c => c.text)
      .join('');
  } catch (err) {
    debug('spectre', `LLM error for ${file}: ${(err as Error).message}`);
    return [];
  }

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    debug('spectre', `no JSON found in response for ${file}`);
    return [];
  }

  let parsed: { findings?: RawFindingFromLLM[] };
  try {
    parsed = JSON.parse(jsonMatch[0]) as { findings?: RawFindingFromLLM[] };
  } catch {
    debug('spectre', `JSON parse error for ${file}`);
    return [];
  }

  const findings: SpectreRawFinding[] = [];
  for (const raw of parsed.findings ?? []) {
    const finding = normalizeFinding(raw, file);
    if (finding) findings.push(finding);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Keyword promotion helpers
// ---------------------------------------------------------------------------

function buildBoostPatterns(custom: string[]): RegExp[] {
  const patterns = [...TIER2_PATTERNS];
  for (const raw of custom) {
    try {
      patterns.push(new RegExp(raw));
    } catch {
      console.warn(`[spectre] ignoring invalid boostPattern: ${raw}`);
    }
  }
  return patterns;
}

async function partitionByKeywords(
  files: string[],
  workspacePath: string,
  patterns: RegExp[],
): Promise<{ tier2: string[]; tier3: string[] }> {
  const tier2: string[] = [];
  const tier3: string[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(join(workspacePath, file), 'utf8');
    } catch {
      tier3.push(file);
      continue;
    }
    if (patterns.some(p => p.test(content))) {
      tier2.push(file);
    } else {
      tier3.push(file);
    }
  }

  return { tier2, tier3 };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSpectre({
  workspacePath,
  changedFiles,
  changedLineRanges = new Map(),
  promptFiles = [],
  toolConfig = DEFAULT_CONFIG.spectre,
}: {
  workspacePath: string;
  changedFiles?: string[] | null;
  changedLineRanges?: LineRangesByFile | Record<string, LineRange[]>;
  promptFiles?: Array<{ file: string; content: string }>;
  toolConfig?: SpectreConfig;
}): Promise<SpectreRawFinding[]> {
  if (!changedFiles || changedFiles.length === 0) return [];

  if (!toolConfig.enabled) {
    console.log('[spectre] skipping — not enabled for this repo (set "spectre": {"enabled": true, "provider": "..."} in layne.json)');
    return [];
  }

  if (!toolConfig.provider) {
    console.log('[spectre] skipping — no provider configured');
    return [];
  }

  const fileCap          = toolConfig.fileCap          ?? 20;
  const secondaryFileCap = toolConfig.secondaryFileCap ?? 20;
  const maxDiffLines     = toolConfig.maxDiffLines      ?? 400;
  const minSeverity      = toolConfig.minSeverity       ?? 'high';
  const concurrency      = toolConfig.concurrency       ?? 5;
  const minRank          = SEVERITY_RANK[minSeverity] ?? SEVERITY_RANK.high;

  // Step 1: filter
  const eligible     = changedFiles.filter(f => !shouldSkipFile(f, toolConfig));
  const skippedCount = changedFiles.length - eligible.length;

  // Step 2: build diff map (needed before keyword scanning)
  const diffByFile = new Map(promptFiles.map(p => [p.file, p.content]));

  // Step 3: three-tier primary cap
  //   Tier 1 — path-matched high-value files (manifests, CI, Dockerfiles, .env)
  //   Tier 2 — content-matched files: full-file keyword scan promotes these above the cap
  //   Tier 3 — everything else: fills remaining slots after tiers 1 and 2
  const tier1    = eligible.filter(isTier1);
  const nonTier1 = eligible.filter(f => !isTier1(f));

  const boostPatterns    = buildBoostPatterns(toolConfig.boostPatterns ?? []);
  const { tier2, tier3 } = await partitionByKeywords(nonTier1, workspacePath, boostPatterns);

  const selectedT1  = tier1.slice(0, fileCap);
  const remT1       = fileCap - selectedT1.length;
  const selectedT2  = remT1 > 0 ? tier2.slice(0, remT1) : [];
  const remT2       = remT1 - selectedT2.length;
  const selectedT3  = remT2 > 0 ? tier3.slice(0, remT2) : [];
  const primary     = [...selectedT1, ...selectedT2, ...selectedT3];

  // Step 4: secondary batch — keyword-matched files that overflowed the primary cap.
  // tier2 files that didn't get a primary slot already contain suspicious patterns; no extra
  // file reads are needed because partitionByKeywords already classified all nonTier1 files.
  const tier2Overflow = tier2.slice(selectedT2.length);
  const secondary     = secondaryFileCap > 0 ? tier2Overflow.slice(0, secondaryFileCap) : [];

  const selected      = [...primary, ...secondary];

  const promotedCount   = selectedT2.length;
  const secondaryCount  = secondary.length;
  const cappedCount     = eligible.length - selected.length;

  console.log(
    `[spectre] scanning ${primary.length} file(s)` +
    (secondaryCount > 0 ? ` + ${secondaryCount} keyword-triggered` : '') +
    ` with ${toolConfig.provider}/${toolConfig.model}` +
    (skippedCount   > 0 ? `, ${skippedCount} skipped by filter`           : '') +
    (promotedCount  > 0 ? `, ${promotedCount} keyword-promoted`           : '') +
    (cappedCount    > 0 ? `, ${cappedCount} dropped by cap of ${fileCap}` : ''),
  );
  if (selectedT1.length > 0) debug('spectre', `tier1 (path-matched): ${selectedT1.join(', ')}`);
  if (selectedT2.length > 0) debug('spectre', `tier2 (keyword-matched): ${selectedT2.join(', ')}`);
  if (secondary.length  > 0) debug('spectre', `secondary (keyword-triggered overflow): ${secondary.join(', ')}`);

  // Step 4: initialise model
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let model: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model = getModel(toolConfig.provider as any, toolConfig.model as any);
  } catch (err) {
    console.error(`[spectre] failed to initialise model: ${(err as Error).message}`);
    return [];
  }

  // Step 5: build system prompt (custom instructions + fixed JSON format suffix)
  const analysisInstructions = toolConfig.prompt?.trim() || DEFAULT_ANALYSIS_INSTRUCTIONS;
  const systemPrompt = `${analysisInstructions}\n\n${JSON_RESPONSE_SUFFIX}`;

  // Step 6: scan concurrently
  const allFindings = await runConcurrent(selected, concurrency, async (file) => {
    const diff    = diffByFile.get(file) ?? null;
    const results = await scanFile({ file, diffContent: diff, workspacePath, changedLineRanges, model, maxDiffLines, systemPrompt });
    return results.filter(f => (SEVERITY_RANK[f.severity] ?? 0) >= minRank);
  });

  console.log(`[spectre] ${allFindings.length} finding(s):`);
  for (const f of allFindings) {
    console.log(`[spectre]   ${f.severity.toUpperCase()} ${f.file}:${f.startLine}-${f.endLine} [${f.ruleId}] ${f.message}`);
  }

  return allFindings;
}
