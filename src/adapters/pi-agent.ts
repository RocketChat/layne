import { Type } from '@sinclair/typebox';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { createConfinedTools } from './pi-agent-tools.js';
import { getModel, getEnvApiKey } from '@mariozechner/pi-ai';
import { debug } from '../debug.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { PiAgentRawFinding, PiAgentConfig, LineRangesByFile, LineRange } from '../types.js';

const SYSTEM_PROMPT =
  'You are a security code reviewer with access to tools that let you read and explore a code repository. ' +
  'Your job is to detect malicious intent: reverse shells, backdoors, credential exfiltration, ' +
  'obfuscated payloads, and supply-chain attacks. ' +
  'Use the read, grep, find, and ls tools to explore the changed files and any related code they import or call. ' +
  'Scan the whole file, not just the changed line ranges. The changed ranges are context to help you anchor findings accurately. ' +
  'Report ONLY confirmed malicious patterns with high confidence. ' +
  'Do not report style issues, bugs, theoretical vulnerabilities, or code that is merely odd or messy. ' +
  'Do not report: ordinary vulnerable code with no evidence of malicious intent; eval, exec, spawn, or similar APIs in clearly benign static contexts; packages that are merely unknown or low-download with no hostile behavior in the provided files. ' +
  'For each finding, call report_finding exactly once with an exact verbatim evidence snippet copied from the file. ' +
  'evidence must be a short exact verbatim contiguous snippet — the smallest distinctive snippet that uniquely identifies the malicious logic in that file. ' +
  'Do not paraphrase, summarize, insert ellipses, or combine non-adjacent lines. ' +
  'If the snippet appears more than once in the file, choose a longer unique snippet or omit the finding. ' +
  'If you cannot provide unique exact verbatim evidence, omit the finding. ' +
  'Line numbers you report will be ignored — only the evidence string is used to determine the annotation location. ' +
  'Focus on providing accurate, unique evidence snippets. ' +
  'ruleId must be exactly one of: reverse-shell, credential-exfiltration, obfuscated-payload, backdoor, supply-chain-abuse, covert-execution. ' +
  'Before emitting a finding, verify all three: the behavior is clearly malicious or clearly enabling malicious execution; ' +
  'you can quote a unique exact contiguous snippet from the file; ' +
  'you would be comfortable surfacing it to a security engineer as a real alert. If any answer is no, omit the finding. ' +
  'Do not write, edit, or modify any files.';

// ---------------------------------------------------------------------------
// report_finding tool definition (TypeBox schema)
// ---------------------------------------------------------------------------

const ReportFindingParams = Type.Object({
  file:       Type.String({ description: 'File path relative to the repository root' }),
  startLine:  Type.Optional(Type.Integer({ description: 'Start line of the finding (ignored — only evidence is used for positioning)' })),
  endLine:    Type.Optional(Type.Integer({ description: 'End line of the finding (ignored — only evidence is used for positioning)' })),
  severity:   Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]),
  message:    Type.String({ description: 'Description of the malicious pattern' }),
  ruleId:     Type.String({ description: 'Short kebab-case rule identifier, e.g. "reverse-shell"' }),
  evidence:   Type.String({ description: 'Exact verbatim contiguous snippet copied from the file that uniquely identifies the malicious code. This is the ONLY field used to determine annotation location.' }),
});

// ---------------------------------------------------------------------------
// Normalization (mirrors claude.ts)
// ---------------------------------------------------------------------------

interface RawFindingInput {
  file: string;
  startLine?: unknown;
  endLine?: unknown;
  severity: string;
  message: string;
  ruleId: string;
  evidence?: string;
}

function formatLineRanges(ranges: LineRange[]): string {
  return ranges.map(r => `${r.start}-${r.end}`).join(', ');
}

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeFinding(raw: RawFindingInput): PiAgentRawFinding {
  const startLine = normalizePositiveInt(raw.startLine) ?? 1;
  const endLine   = normalizePositiveInt(raw.endLine ?? raw.startLine) ?? startLine;

  return {
    file:       raw.file,
    severity:   raw.severity as PiAgentRawFinding['severity'],
    message:    raw.message,
    ruleId:     `pi_agent/${raw.ruleId}`,
    tool:       'pi_agent',
    line:       startLine,
    startLine,
    endLine:    endLine >= startLine ? endLine : startLine,
    evidence:   typeof raw.evidence === 'string' ? raw.evidence.trim() : '',
    // Pi Agent uses strict evidence-only positioning - these are not used
    anchorKind: undefined,
    anchorLine: undefined,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs an agentic security scan using @mariozechner/pi-coding-agent.
 *
 * Unlike the claude adapter (single-turn batch), this adapter spins up a
 * full agent session with read-only file tools so the model can traverse
 * imports and follow suspicious patterns across file boundaries.
 *
 * Non-determinism note: because the agent drives its own investigation, the
 * same code may produce findings with different ruleIds or line numbers across
 * runs. Finding IDs (LAYNE-xxx) may therefore change between scans, which
 * means exception approvals for pi_agent findings may not survive re-scans.
 */
export async function runPiAgent({
  workspacePath,
  changedFiles,
  changedLineRanges = new Map(),
  toolConfig = DEFAULT_CONFIG.piAgent,
  headSha,
}: {
  workspacePath: string;
  changedFiles?: string[] | null;
  changedLineRanges?: LineRangesByFile;
  toolConfig?: PiAgentConfig;
  headSha?: string;
}): Promise<PiAgentRawFinding[]> {
  if (!changedFiles || changedFiles.length === 0) return [];
  if (!toolConfig.enabled) {
    console.log('[pi-agent] skipping — not enabled for this repo (set "piAgent": {"enabled": true} in config/layne.json)');
    return [];
  }
  if (!toolConfig.provider) {
    console.log('[pi-agent] skipping — no provider configured (set "piAgent": {"provider": "anthropic"} in config/layne.json)');
    return [];
  }

  const provider = toolConfig.provider;

  if (!getEnvApiKey(provider)) {
    console.log(`[pi-agent] skipping — no credentials found for provider "${provider}"`);
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = getModel(provider as any, toolConfig.model as any);
  if (!model) {
    console.error(`[pi-agent] model "${toolConfig.model}" not found for provider "${provider}" — skipping`);
    return [];
  }

  console.log(`[pi-agent] scanning ${changedFiles.length} file(s) with provider ${provider}, model ${toolConfig.model} (thinking: ${toolConfig.thinkingLevel ?? 'medium'})`);

  const findings: PiAgentRawFinding[] = [];

  // Build the report_finding tool — execute() accumulates into the closure array.
  const reportFindingTool: ToolDefinition = {
    name:        'report_finding',
    label:       'Report Finding',
    description: 'Report a confirmed security finding. Call once per finding.',
    parameters:  ReportFindingParams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_toolCallId: any, params: any, _signal: any, _onUpdate: any, _ctx: any) => {
      const finding = normalizeFinding(params as RawFindingInput);
      findings.push(finding);
      debug('pi-agent', `finding recorded: ${finding.severity.toUpperCase()} ${finding.file}:${finding.startLine} [${finding.ruleId}]`);
      return {
        content: [{ type: 'text' as const, text: 'Finding recorded.' }],
        details: {},
      };
    },
  };

  const systemPrompt = toolConfig.prompt ?? SYSTEM_PROMPT;

  const resourceLoader = new DefaultResourceLoader({
    systemPromptOverride:       () => systemPrompt,
    appendSystemPromptOverride: () => [],
    noExtensions:               true,
    noSkills:                   true,
    noPromptTemplates:          true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd:           workspacePath,
    tools:         createConfinedTools(workspacePath, {
      headSha,
      followImports: toolConfig.followImports ?? true,
    }),
    customTools:   [reportFindingTool],
    sessionManager: SessionManager.inMemory(),
    model,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    thinkingLevel: (toolConfig.thinkingLevel ?? 'medium') as any,
    resourceLoader,
  });

  const fileList = changedFiles.map(f => {
    const ranges = changedLineRanges.get(f) ?? [];
    const rangeStr = ranges.length > 0
      ? ` (changed lines: ${formatLineRanges(ranges)})`
      : '';
    return `  - ${f}${rangeStr}`;
  }).join('\n');
  const isCustomPrompt = toolConfig.prompt !== null && toolConfig.prompt !== undefined;
  const initialPrompt = isCustomPrompt
    ? `The following files were changed in this PR and require a security review:\n${fileList}\n\n` +
      'Investigate these files thoroughly using the read, grep, find, and ls tools. ' +
      'Follow imports and function calls as deeply as needed. ' +
      'Use the changed line ranges above to anchor your findings accurately. ' +
      'For each confirmed finding, call report_finding.'
    : `The following files were changed in this PR and require a security review:\n${fileList}\n\n` +
      'Investigate these files for malicious intent: reverse shells, backdoors, credential exfiltration, ' +
      'obfuscated payloads, and supply-chain attacks. ' +
      'Use the read, grep, find, and ls tools to explore the code. Follow imports and dependencies where suspicious. ' +
      'Scan each whole file but use the changed line ranges above to prioritize where to anchor your findings. ' +
      'For each confirmed finding, call report_finding. Report only high-confidence confirmed malicious patterns.';

  const timeoutMs = (toolConfig.timeoutMinutes ?? 3) * 60 * 1000;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    session.abort().catch(() => {});
  }, timeoutMs);

  try {
    await session.prompt(initialPrompt);
  } catch (err) {
    if (!timedOut) {
      console.error('[pi-agent] error during scan:', (err as Error).message ?? err);
    }
  } finally {
    clearTimeout(timer);
    session.dispose();
  }

  if (timedOut) {
    console.warn(`[pi-agent] scan timed out after ${toolConfig.timeoutMinutes ?? 3}m — returning ${findings.length} partial finding(s)`);
  }

  console.log(`[pi-agent] ${findings.length} finding(s)${timedOut ? ' (partial — timed out)' : ''}:`);
  for (const f of findings) {
    console.log(`[pi-agent]   ${f.severity.toUpperCase()} ${f.file}:${f.startLine}-${f.endLine} [${f.ruleId}] ${f.message}`);
  }

  return findings;
}
