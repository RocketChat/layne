import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { debug } from '../debug.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { AdapterResult, ClaudeConfig, ClaudeRawFinding, AnchorKind, LineRangesByFile, LineRange } from '../types.js';
import { throwIfAborted } from './helpers.js';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.pyc', '.class', '.jar',
]);

const FILE_SIZE_LIMIT  = 50_000;   // bytes; truncate above this
const BATCH_CHAR_LIMIT = 100_000;  // ~25K tokens of file text per API call
const MAX_SKILL_TURNS  = 10;       // max pause_turn continuations per batch

const SYSTEM_PROMPT =
  'You are a security code reviewer. Analyse the provided source files for malicious intent: ' +
  'reverse shells, backdoors, credential exfiltration, obfuscated payloads, and supply-chain attacks. ' +
  'Scan the whole file, not just the changed line ranges. The changed ranges are context to help you anchor findings accurately. ' +
  'Report ONLY confirmed malicious patterns with high confidence. ' +
  'Do not report style issues, bugs, theoretical vulnerabilities, or code that is merely odd or messy. ' +
  'Do not report: ordinary vulnerable code with no evidence of malicious intent; eval, exec, spawn, or similar APIs in clearly benign static contexts; packages that are merely unknown or low-download with no hostile behavior in the provided files. ' +
  'The source files include line numbers in the format "042 | code". Do not include this prefix in evidence snippets. ' +
  'For every finding, copy a short exact verbatim contiguous snippet from the code — ' +
  'the smallest distinctive snippet that uniquely identifies the malicious logic in that file. ' +
  'Do not paraphrase, summarize, insert ellipses, or combine non-adjacent lines. ' +
  'If the snippet appears more than once in the file, choose a longer unique snippet or omit the finding. ' +
  'If you cannot provide unique exact verbatim evidence from the file, omit the finding. ' +
  'Line numbers, anchorKind, and anchorLine are optional hints only — they are revalidated locally against the evidence you provide. ' +
  'When the finding describes an enclosing function, method, or class, prefer anchorKind=declaration and set anchorLine to the declaration line. ' +
  'ruleId must be exactly one of: reverse-shell, credential-exfiltration, obfuscated-payload, backdoor, supply-chain-abuse, covert-execution. ' +
  'Before emitting a finding, verify all three: the behavior is clearly malicious or clearly enabling malicious execution; ' +
  'you can quote a unique exact contiguous snippet from the file; ' +
  'you would be comfortable surfacing it to a security engineer as a real alert. If any answer is no, omit the finding. ' +
  'Call `report_findings` with your results.';

const REPORT_FINDINGS_TOOL = {
  name: 'report_findings',
  description: 'Report malicious code findings',
  input_schema: {
    type: 'object' as const,
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file:     { type: 'string' },
            startLine:{
              type: 'integer',
              description: 'Optional hint only. The final start line will be resolved locally from the evidence snippet.',
            },
            endLine:  {
              type: 'integer',
              description: 'Optional hint only. The final end line will be resolved locally from the evidence snippet.',
            },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            message:  { type: 'string' },
            ruleId:   { type: 'string' },
            evidence: {
              type: 'string',
              description: 'Exact verbatim contiguous snippet copied from the file that uniquely identifies the malicious code.',
            },
            anchorKind: {
              type: 'string',
              enum: ['line', 'declaration', 'span'],
              description: 'Optional hint only. The final annotation span will be resolved locally from the evidence snippet.',
            },
            anchorLine: {
              type: 'integer',
              description: 'Optional hint only. The final annotation line will be resolved locally from the evidence snippet.',
            },
          },
          required: ['file', 'severity', 'message', 'ruleId', 'evidence'],
        },
      },
    },
    required: ['findings'],
  },
};

interface FileContent {
  file: string;
  content: string;
  promptContent: string;
}

interface ScanBatchResult {
  findings: ClaudeRawFinding[];
  outcome: 'complete' | 'failed' | 'invalid';
}

const INCOMPLETE_REASONS = {
  unreadableFiles: 'file-read-failed',
  clientInitialization: 'client-initialization-failed',
  failedBatch: 'api-batch-failed',
  invalidResponse: 'invalid-provider-response',
} as const;

/**
 * Runs Claude against the files changed in the PR and returns findings
 * in the common format with the adapter's completion status.
 */
export async function runClaude({
  workspacePath,
  changedFiles,
  changedLineRanges = new Map(),
  promptFiles = [],
  toolConfig = DEFAULT_CONFIG.claude,
  signal,
}: {
  workspacePath: string;
  changedFiles?: string[] | null;
  changedLineRanges?: LineRangesByFile | Record<string, LineRange[]>;
  promptFiles?: Array<{ file: string; content: string }>;
  toolConfig?: ClaudeConfig;
  signal?: AbortSignal;
}): Promise<AdapterResult<ClaudeRawFinding>> {
  throwIfAborted(signal);
  if (!toolConfig.enabled) {
    console.log('[claude] skipping — not enabled for this repo (set "claude": {"enabled": true} in config/layne.json)');
    return { findings: [], status: { outcome: 'disabled' } };
  }
  if (!changedFiles || changedFiles.length === 0) {
    return { findings: [], status: { outcome: 'complete' } };
  }

  const mode = toolConfig.skill ? 'skill' : 'prompt';
  if (toolConfig.skill && toolConfig.prompt) {
    console.warn('[claude] warning — both "prompt" and "skill" are configured; "prompt" is ignored (skill mode takes precedence)');
  }
  console.log(`[claude] scanning ${changedFiles.length} file(s) with model ${toolConfig.model} (mode: ${mode})`);

  // 1. Build file contents.
  const fileContents: FileContent[] = [];
  let unreadableFiles = 0;

  // Helper to get ranges from either a Map or plain object
  function getRanges(file: string): LineRange[] {
    if (changedLineRanges instanceof Map) {
      return changedLineRanges.get(file) ?? [];
    }
    return (changedLineRanges as Record<string, LineRange[]>)[file] ?? [];
  }

  if (promptFiles.length > 0) {
    const promptFileSet = new Set(promptFiles.map(({ file }) => file));
    unreadableFiles += changedFiles.filter(file =>
      !promptFileSet.has(file)
      && !BINARY_EXTENSIONS.has(extname(file).toLowerCase())
      && getRanges(file).length > 0
    ).length;
    for (const { file, content } of promptFiles) {
      throwIfAborted(signal);
      fileContents.push({ file, content, promptContent: formatSnippetForPrompt(file, content) });
    }
  } else {
    for (const file of changedFiles) {
      throwIfAborted(signal);
      if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) {
        debug('claude', `skipping binary file: ${file}`);
        continue;
      }
      let content: string;
      try {
        content = await readFile(join(workspacePath, file), 'utf8');
      } catch {
        throwIfAborted(signal);
        debug('claude', `could not read file: ${file}`);
        unreadableFiles++;
        continue;
      }
      throwIfAborted(signal);
      if (content.length > FILE_SIZE_LIMIT) {
        content = content.slice(0, FILE_SIZE_LIMIT) + '\n[truncated]';
      }
      fileContents.push({
        file,
        content,
        promptContent: formatFileForPrompt(file, content, getRanges(file)),
      });
    }
  }

  if (fileContents.length === 0) {
    return {
      findings: [],
      status: unreadableFiles > 0
        ? { outcome: 'incomplete', reason: INCOMPLETE_REASONS.unreadableFiles }
        : { outcome: 'complete' },
    };
  }

  // 2. Split into batches by BATCH_CHAR_LIMIT
  const batches = splitIntoBatches(fileContents, BATCH_CHAR_LIMIT);
  debug('claude', `split into ${batches.length} batch(es)`);

  // 3. Call Claude for each batch
  let client: Anthropic;
  try {
    client = new Anthropic();
  } catch (err) {
    throwIfAborted(signal);
    console.error('[claude] client initialization failed:', (err as Error).message ?? err);
    return {
      findings: [],
      status: { outcome: 'incomplete', reason: INCOMPLETE_REASONS.clientInitialization },
    };
  }
  const findings: ClaudeRawFinding[] = [];
  let failedBatchCount = 0;
  let invalidResponseCount = 0;
  for (const batch of batches) {
    throwIfAborted(signal);
    const result = toolConfig.skill
      ? await scanBatchWithSkill(client, batch, toolConfig.model, toolConfig.skill, signal)
      : await scanBatchWithPrompt(client, batch, toolConfig.model, toolConfig.prompt ?? SYSTEM_PROMPT, signal);
    throwIfAborted(signal);

    findings.push(...result.findings);
    if (result.outcome === 'failed') {
      failedBatchCount++;
    } else if (result.outcome === 'invalid') {
      invalidResponseCount++;
    }
  }

  if (failedBatchCount > 0) {
    console.error(`[claude] ${failedBatchCount}/${batches.length} batch(es) failed — findings may be incomplete`);
  }
  if (invalidResponseCount > 0) {
    console.error(`[claude] ${invalidResponseCount}/${batches.length} batch(es) returned an invalid response — findings may be incomplete`);
  }
  const incomplete = unreadableFiles > 0 || failedBatchCount > 0 || invalidResponseCount > 0;
  console.log(`[claude] ${findings.length} finding(s)${incomplete ? ' (incomplete)' : ''}:`);
  for (const f of findings) {
    console.log(`[claude]   ${f.severity.toUpperCase()} ${f.file}:${f.startLine ?? f.line}-${f.endLine ?? f.line} [${f.ruleId}] ${f.message}`);
  }

  const reason = failedBatchCount > 0
    ? INCOMPLETE_REASONS.failedBatch
    : invalidResponseCount > 0
      ? INCOMPLETE_REASONS.invalidResponse
      : unreadableFiles > 0
        ? INCOMPLETE_REASONS.unreadableFiles
        : undefined;
  return {
    findings,
    status: reason ? { outcome: 'incomplete', reason } : { outcome: 'complete' },
  };
}

// ---------------------------------------------------------------------------
// Prompt mode
// ---------------------------------------------------------------------------

async function scanBatchWithPrompt(
  client: Anthropic,
  files: FileContent[],
  model: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<ScanBatchResult> {
  const userMessage = buildUserMessage(files);

  try {
    throwIfAborted(signal);
    const params = {
      model,
      max_tokens: 1024,
      system: prompt,
      messages: [{ role: 'user' as const, content: userMessage }],
      tools: [REPORT_FINDINGS_TOOL],
      tool_choice: { type: 'any' as const },
    };
    const response = signal
      ? await client.messages.create(params, { signal })
      : await client.messages.create(params);
    throwIfAborted(signal);

    if (response.stop_reason === 'max_tokens') {
      console.error('[claude] API error during scan batch (prompt mode): response truncated — max_tokens reached, findings may be incomplete');
      return { error: true };
    }

    return extractFindings(response.content);
  } catch (err) {
    throwIfAborted(signal);
    console.error('[claude] API error during scan batch (prompt mode):', (err as Error).message ?? err);
    return { findings: [], outcome: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Skill mode
// ---------------------------------------------------------------------------

async function scanBatchWithSkill(
  client: Anthropic,
  files: FileContent[],
  model: string,
  skillConfig: NonNullable<ClaudeConfig['skill']>,
  signal?: AbortSignal,
): Promise<ScanBatchResult> {
  const userMessage = buildUserMessage(files);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [{ role: 'user', content: userMessage }];

  const containerSpec = {
    skills: [{
      type:     'custom',
      skill_id: skillConfig.id,
      version:  skillConfig.version ?? 'latest',
    }],
  };

  const tools = [
    { type: 'code_execution_20250825', name: 'code_execution' },
    REPORT_FINDINGS_TOOL,
  ];

  try {
    throwIfAborted(signal);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const betaMessages = client.beta.messages as any;
    let response = await betaMessages.create({
      model,
      max_tokens: 4096,
      betas:    ['code-execution-2025-08-25', 'skills-2025-10-02'],
      container: containerSpec,
      messages,
      tools,
    }, ...(signal ? [{ signal }] : []));
    throwIfAborted(signal);

    // Continue if the skill needs more turns (long-running code execution)
    for (let i = 0; i < MAX_SKILL_TURNS && response.stop_reason === 'pause_turn'; i++) {
      throwIfAborted(signal);
      debug('claude', `pause_turn continuation ${i + 1}/${MAX_SKILL_TURNS}`);
      messages.push({ role: 'assistant', content: response.content });
      response = await betaMessages.create({
        model,
        max_tokens: 4096,
        betas:    ['code-execution-2025-08-25', 'skills-2025-10-02'],
        container: { id: response.container.id, ...containerSpec },
        messages,
        tools,
      }, ...(signal ? [{ signal }] : []));
      throwIfAborted(signal);
    }

    return extractFindings(response.content);
  } catch (err) {
    throwIfAborted(signal);
    console.error('[claude] API error during scan batch (skill mode):', (err as Error).message ?? err);
    return { findings: [], outcome: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildUserMessage(files: FileContent[]): string {
  return files
    .map(f => f.promptContent)
    .join('\n\n');
}

interface RawFindingFromApi {
  file: string;
  startLine?: unknown;
  endLine?: unknown;
  line?: unknown;
  severity: string;
  message: string;
  ruleId: string;
  evidence?: string;
  anchorKind?: string;
  anchorLine?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFindings(content: any[]): ScanBatchResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolUses = content.filter((b: any) =>
    b.type === 'tool_use' && b.name === 'report_findings'
  );
  if (toolUses.length === 0) return { findings: [], outcome: 'invalid' };

  const findings: ClaudeRawFinding[] = [];
  let invalid = toolUses.length > 1;
  for (const toolUse of toolUses) {
    if (!toolUse.input || !Array.isArray(toolUse.input.findings)) {
      invalid = true;
      continue;
    }
    for (const candidate of toolUse.input.findings as RawFindingFromApi[]) {
      if (!isRawFindingFromApi(candidate)) {
        invalid = true;
        continue;
      }
      try {
        findings.push(normalizeFinding(candidate));
      } catch {
        invalid = true;
      }
    }
  }
  return { findings, outcome: invalid ? 'invalid' : 'complete' };
}

function isRawFindingFromApi(value: unknown): value is RawFindingFromApi {
  if (!value || typeof value !== 'object') return false;
  const finding = value as Partial<RawFindingFromApi>;
  return typeof finding.file === 'string'
    && ['critical', 'high', 'medium', 'low', 'info'].includes(finding.severity ?? '')
    && typeof finding.message === 'string'
    && typeof finding.ruleId === 'string';
}

function splitIntoBatches(fileContents: FileContent[], charLimit: number): FileContent[][] {
  const batches: FileContent[][] = [];
  let current: FileContent[] = [];
  let currentSize = 0;

  for (const fc of fileContents) {
    const size = fc.promptContent.length;
    if (current.length > 0 && currentSize + size > charLimit) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(fc);
    currentSize += size;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

function normalizeFinding(finding: RawFindingFromApi): ClaudeRawFinding {
  const startLine = normalizePositiveInt(finding.startLine ?? finding.line) ?? 1;
  const endLine = normalizePositiveInt(finding.endLine ?? finding.startLine ?? finding.line) ?? startLine;

  return {
    ...finding,
    severity: finding.severity as ClaudeRawFinding['severity'],
    line: startLine,
    startLine,
    endLine: endLine >= startLine ? endLine : startLine,
    anchorKind: normalizeAnchorKind(finding.anchorKind),
    anchorLine: normalizePositiveInt(finding.anchorLine) ?? undefined,
    evidence: typeof finding.evidence === 'string' ? finding.evidence.trim() : '',
    ruleId: `claude/${finding.ruleId}`,
    tool: 'claude',
  };
}

function formatSnippetForPrompt(file: string, snippetContent: string): string {
  return [
    `### ${file}`,
    '```text',
    snippetContent,
    '```',
  ].join('\n');
}

function formatFileForPrompt(file: string, content: string, ranges: LineRange[]): string {
  const changedLines = formatChangedRanges(ranges);
  return [
    `### ${file}`,
    `Changed lines in this PR: ${changedLines}`,
    '```text',
    numberLines(content),
    '```',
  ].join('\n');
}

function numberLines(content: string): string {
  const lines = content.split('\n');
  const width = String(lines.length).length;
  return lines
    .map((line, index) => `${String(index + 1).padStart(width, '0')} | ${line}`)
    .join('\n');
}

function formatChangedRanges(ranges: LineRange[]): string {
  if (!ranges.length) return 'none provided';
  return ranges.map(range => `${range.start}-${range.end}`).join(', ');
}

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeAnchorKind(value: unknown): AnchorKind | undefined {
  return value === 'line' || value === 'declaration' || value === 'span'
    ? value as AnchorKind
    : undefined;
}
