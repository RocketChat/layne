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

const SKIP_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.d\.ts$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.lock$/,
  /\.md$/,
  /\.txt$/,
  /\.css$/,
  /\.scss$/,
  /\.svg$/,
  /\.(png|jpg|gif|ico|woff2?)$/,
];

const SYSTEM_PROMPT =
  'You are a security code reviewer embedded in an automated SAST pipeline. ' +
  'You are given one changed file to investigate per session. ' +
  'Your job is to detect malicious intent: reverse shells, backdoors, credential exfiltration, ' +
  'obfuscated payloads, and supply-chain attacks.\n\n' +
  'TOOLS AVAILABLE\n' +
  'You have exactly these tools:\n' +
  '- read(file, [start_line], [end_line]): Read a file or a specific line range.\n' +
  '- grep(pattern, path, [options]): Search for patterns across the repository.\n' +
  '- find(path, [options]): Find files by name or pattern.\n' +
  '- ls(path): List directory contents.\n' +
  '- report_finding(...): Submit a confirmed finding.\n' +
  'The full repository is available — you can read any file, not just the assigned file.\n\n' +
  'INVESTIGATION STEPS\n' +
  '1. Read the assigned file in full using the read tool on its actual file path.\n' +
  '2. Follow any suspicious imports or dependencies into other files using read.\n' +
  '3. Use grep to search for suspicious patterns (encoded strings, network calls, shell invocations) across the codebase.\n' +
  '4. Before calling report_finding, call read() to confirm the exact verbatim evidence snippet in the file.\n\n' +
  'WHAT TO REPORT\n' +
  'Report ONLY confirmed malicious patterns with high confidence. ' +
  'Do not report bugs, style issues, theoretical vulnerabilities, or unusual-but-benign code. ' +
  'ruleId must be exactly one of: reverse-shell, credential-exfiltration, obfuscated-payload, backdoor, supply-chain-abuse, covert-execution.\n\n' +
  'EVIDENCE RULES\n' +
  'Call report_finding exactly once per finding with an exact verbatim evidence snippet copied from the file.\n' +
  '- evidence is the ONLY field used to place the annotation — if it does not exactly match file content, the finding is silently dropped.\n' +
  '- Use the smallest contiguous snippet that uniquely identifies the malicious logic.\n' +
  '- Do not paraphrase, insert ellipses, or combine non-adjacent lines.\n' +
  '- If the snippet appears more than once in the file, extend it until unique or omit the finding.\n' +
  'Do not write, edit, or modify any files.';

// ---------------------------------------------------------------------------
// report_finding tool definition (TypeBox schema)
// ---------------------------------------------------------------------------

const ReportFindingParams = Type.Object({
  file:       Type.String({ description: 'File path relative to the repository root' }),
  startLine:  Type.Optional(Type.Integer({ description: 'Start line of the finding as shown in the read() output. Must match the line where the evidence string begins in the file. Do not use 1 unless the evidence is genuinely on line 1.' })),
  endLine:    Type.Optional(Type.Integer({ description: 'End line of the finding as shown in the read() output. Must match the line where the evidence string ends in the file.' })),
  severity:   Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]),
  message:    Type.String({ description: 'Description of the malicious pattern' }),
  ruleId:     Type.String({ description: 'Short kebab-case rule identifier, e.g. "reverse-shell"' }),
  evidence:   Type.String({ description: 'Exact verbatim contiguous snippet copied from the file that uniquely identifies the malicious code. This is the ONLY field used to determine annotation location.' }),
});

// ---------------------------------------------------------------------------
// Normalization
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
// Deduplication — drop findings whose evidence was already seen (cross-session)
// ---------------------------------------------------------------------------

function deduplicateByEvidence(findings: PiAgentRawFinding[]): PiAgentRawFinding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
    const key = f.evidence?.trim() ?? '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Concurrency pool — N workers drain a shared queue of files
// ---------------------------------------------------------------------------

async function runConcurrent(
  files: string[],
  concurrency: number,
  fn: (file: string, index: number) => Promise<PiAgentRawFinding[]>,
): Promise<PiAgentRawFinding[]> {
  const results: PiAgentRawFinding[] = [];
  let nextIndex = 0;

  // JS is single-threaded: nextIndex++ is safe across concurrent async workers
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= files.length) break;
      const fileResults = await fn(files[index]!, index);
      results.push(...fileResults);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Per-file session runner
// ---------------------------------------------------------------------------

async function runFileSession({
  file,
  index,
  total,
  workspacePath,
  changedLineRanges,
  toolConfig,
  model,
  systemPrompt,
  headSha,
}: {
  file: string;
  index: number;
  total: number;
  workspacePath: string;
  changedLineRanges: LineRangesByFile;
  toolConfig: PiAgentConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  systemPrompt: string;
  headSha?: string;
}): Promise<PiAgentRawFinding[]> {
  const label = `[${index + 1}/${total}] ${file}`;
  const ranges = changedLineRanges.get(file) ?? [];
  const rangeStr = ranges.length > 0 ? ` (changed lines: ${formatLineRanges(ranges)})` : '';
  const timeoutMs = (toolConfig.timeoutMinutes ?? 3) * 60 * 1000;
  const isCustomPrompt = toolConfig.prompt !== null && toolConfig.prompt !== undefined;

  const initialPrompt = isCustomPrompt
    ? `The following file was changed in this PR and requires a security review:\n  - ${file}${rangeStr}\n\n` +
      'Start by reading this file in full using the read tool on the actual file path (not the .layne/diff-only/ path). ' +
      'Then broaden your investigation: read the files it imports from, ' +
      'use grep to find where changed functions are called from elsewhere in the codebase, ' +
      'and read any shared utilities, models, or middleware that the changed code interacts with. ' +
      'Follow imports and function calls as deeply as needed to trace data flows from source to sink. ' +
      'Use the changed line range above to anchor your findings accurately. ' +
      'For each confirmed finding, call report_finding.'
    : `The following file was changed in this PR and requires a security review:\n  - ${file}${rangeStr}\n\n` +
      'Investigate this file for malicious intent: reverse shells, backdoors, credential exfiltration, ' +
      'obfuscated payloads, and supply-chain attacks. ' +
      'Read the file in full, then follow any suspicious imports into other files. ' +
      'Use the changed line range above to anchor your findings. ' +
      'For each confirmed finding, call report_finding. Report only high-confidence confirmed malicious patterns.';

  const runAttempt = async (attempt: number): Promise<{ findings: PiAgentRawFinding[]; hadActivity: boolean; timedOut: boolean }> => {
    const sessionFindings: PiAgentRawFinding[] = [];
    let hadActivity = false;
    let timedOut = false;

    const reportFindingTool: ToolDefinition = {
      name:        'report_finding',
      label:       'Report Finding',
      description: 'Report a confirmed security finding. Call once per finding.',
      parameters:  ReportFindingParams,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: async (_toolCallId: any, params: any, _signal: any, _onUpdate: any, _ctx: any) => {
        hadActivity = true;
        const finding = normalizeFinding(params as RawFindingInput);
        sessionFindings.push(finding);
        debug('pi-agent', `finding recorded: ${finding.severity.toUpperCase()} ${finding.file}:${finding.startLine} [${finding.ruleId}]`);
        return {
          content: [{ type: 'text' as const, text: 'Finding recorded.' }],
          details: {},
        };
      },
    };

    const rawTools = createConfinedTools(workspacePath, {
      headSha,
      followImports: toolConfig.followImports ?? true,
    });

    // Wrap each tool's execute to detect model activity (any tool call = session engaged)
    const tools = rawTools.map(tool => ({
      ...tool,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: async (...args: any[]) => {
        hadActivity = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (tool.execute as any)(...args);
      },
    }));

    const resourceLoader = new DefaultResourceLoader({
      cwd:                        workspacePath,
      agentDir:                   workspacePath,
      systemPromptOverride:       () => systemPrompt,
      appendSystemPromptOverride: () => [],
      noExtensions:               true,
      noSkills:                   true,
      noPromptTemplates:          true,
    });
    await resourceLoader.reload();

    const activeToolNames = [...tools.map(t => t.name), reportFindingTool.name];
    const { session } = await createAgentSession({
      cwd:            workspacePath,
      tools:          activeToolNames,
      customTools:    [...tools, reportFindingTool],
      sessionManager: SessionManager.inMemory(),
      model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      thinkingLevel:  (toolConfig.thinkingLevel ?? 'medium') as any,
      resourceLoader,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      session.abort().catch(() => {});
    }, timeoutMs);

    try {
      await session.prompt(initialPrompt);
    } catch (err) {
      if (!timedOut) {
        console.error(`[pi-agent] ${label} error (attempt ${attempt}):`, (err as Error).message ?? err);
      }
    } finally {
      clearTimeout(timer);
      session.dispose();
    }

    return { findings: sessionFindings, hadActivity, timedOut };
  };

  console.log(`[pi-agent] ${label} — starting`);
  const first = await runAttempt(1);

  if (first.timedOut) {
    console.warn(`[pi-agent] ${label} — timed out after ${toolConfig.timeoutMinutes ?? 3}m (${first.findings.length} partial finding(s))`);
    return first.findings;
  }

  const silentFailure = first.findings.length === 0 && !first.hadActivity;
  const badEvidenceRun = first.findings.length > 0 && first.findings.every(f => f.startLine === 1 && f.endLine === 1);

  let result = first;
  if (silentFailure || badEvidenceRun) {
    console.warn(`[pi-agent] ${label} — ${silentFailure ? 'no output' : 'all findings at line 1'} — retrying`);
    const retry = await runAttempt(2);
    if (retry.timedOut) {
      console.warn(`[pi-agent] ${label} — retry timed out (${retry.findings.length} partial finding(s))`);
    }
    result = retry;
  }

  console.log(`[pi-agent] ${label} — ${result.findings.length} finding(s)`);
  return result.findings;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs an agentic security scan using @mariozechner/pi-coding-agent.
 *
 * Spawns one agent session per changed file (up to `concurrency` in parallel)
 * so each file gets a dedicated investigation budget. Sessions share the same
 * workspace and can follow imports freely across file boundaries. Findings
 * from all sessions are merged and deduplicated by evidence string before
 * being returned.
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

  const filteredFiles = changedFiles.filter(f => !SKIP_PATTERNS.some(p => p.test(f)));
  const skippedCount = changedFiles.length - filteredFiles.length;
  if (skippedCount > 0) {
    console.log(`[pi-agent] skipping ${skippedCount} file(s) matched by skip patterns`);
  }
  if (filteredFiles.length === 0) {
    console.log('[pi-agent] no files to scan after filtering');
    return [];
  }

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

  const concurrency = toolConfig.concurrency ?? 3;
  const systemPrompt = toolConfig.prompt ?? SYSTEM_PROMPT;

  console.log(`[pi-agent] scanning ${filteredFiles.length} file(s) with provider ${provider}, model ${toolConfig.model}, concurrency ${concurrency} (thinking: ${toolConfig.thinkingLevel ?? 'medium'})`);

  const allFindings = await runConcurrent(
    filteredFiles,
    concurrency,
    (file, index) => runFileSession({
      file,
      index,
      total: filteredFiles.length,
      workspacePath,
      changedLineRanges,
      toolConfig,
      model,
      systemPrompt,
      headSha,
    }),
  );

  const deduped = deduplicateByEvidence(allFindings);
  const removedCount = allFindings.length - deduped.length;

  console.log(`[pi-agent] ${deduped.length} finding(s) after deduplication${removedCount > 0 ? ` (${removedCount} duplicate(s) removed)` : ''}:`);
  for (const f of deduped) {
    console.log(`[pi-agent]   ${f.severity.toUpperCase()} ${f.file}:${f.startLine}-${f.endLine} [${f.ruleId}] ${f.message}`);
  }

  return deduped;
}
