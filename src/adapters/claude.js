import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { debug } from '../debug.js';
import { DEFAULT_CONFIG } from '../config.js';

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
  'Report ONLY confirmed malicious patterns with high confidence. Do not report style issues, bugs, or ' +
  'theoretical vulnerabilities. Do NOT report low confidence vulnerabilities or vulnerabilities that aren\'t obvious or you can\'t confirm/validate they\'re real. ' +
  'The source files include line numbers. For every finding, copy a short exact evidence snippet verbatim from the code, ' +
  'choosing the smallest distinctive contiguous snippet that uniquely identifies the malicious logic in that file. ' +
  'If you cannot provide exact verbatim evidence from the file, omit the finding. ' +
  'Do not guess locations: line numbers and anchors are only hints and will be revalidated locally against the evidence you provide. ' +
  'When the finding describes an enclosing function, method, or class, prefer anchorKind=declaration and set anchorLine to the declaration line while keeping evidence as the exact proof snippet. ' +
  'Call `report_findings` with your results.';

const REPORT_FINDINGS_TOOL = {
  name: 'report_findings',
  description: 'Report malicious code findings',
  input_schema: {
    type: 'object',
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

/**
 * Runs Claude against the files changed in the PR and returns findings
 * in the common format: { file, line, severity, message, ruleId, tool }.
 *
 * Two modes, selected by layne.json config:
 *   - prompt mode (default): single API call with a system prompt
 *   - skill mode: Skills API + code_execution tool (requires beta headers);
 *     set `claude.skill: { id: "skill_01...", version: "latest" }` in layne.json
 */
export async function runClaude({
  workspacePath,
  changedFiles,
  changedLineRanges = {},
  promptFiles = [],
  toolConfig = DEFAULT_CONFIG.claude,
}) {
  if (!changedFiles || changedFiles.length === 0) return [];
  if (!toolConfig.enabled) {
    console.log('[claude] skipping — not enabled for this repo (set "claude": {"enabled": true} in config/layne.json)');
    return [];
  }

  const mode = toolConfig.skill ? 'skill' : 'prompt';
  if (toolConfig.skill && toolConfig.prompt) {
    console.warn('[claude] warning — both "prompt" and "skill" are configured; "prompt" is ignored (skill mode takes precedence)');
  }
  console.log(`[claude] scanning ${changedFiles.length} file(s) with model ${toolConfig.model} (mode: ${mode})`);

  // 1. Build file contents.
  //    diff_only mode: promptFiles are pre-built line-numbered snippets from scan-context.
  //    changed_files mode: read full file contents from disk.
  const fileContents = [];

  if (promptFiles.length > 0) {
    for (const { file, content } of promptFiles) {
      fileContents.push({ file, content, promptContent: formatSnippetForPrompt(file, content) });
    }
  } else {
    for (const file of changedFiles) {
      if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) {
        debug('claude', `skipping binary file: ${file}`);
        continue;
      }
      let content;
      try {
        content = await readFile(join(workspacePath, file), 'utf8');
      } catch {
        debug('claude', `could not read file: ${file}`);
        continue;
      }
      if (content.length > FILE_SIZE_LIMIT) {
        content = content.slice(0, FILE_SIZE_LIMIT) + '\n[truncated]';
      }
      fileContents.push({
        file,
        content,
        promptContent: formatFileForPrompt(file, content, changedLineRanges[file] ?? []),
      });
    }
  }

  if (fileContents.length === 0) return [];

  // 2. Split into batches by BATCH_CHAR_LIMIT
  const batches = splitIntoBatches(fileContents, BATCH_CHAR_LIMIT);
  debug('claude', `split into ${batches.length} batch(es)`);

  // 3. Call Claude for each batch
  const client = new Anthropic();
  const findings = [];
  let errorCount = 0;
  for (const batch of batches) {
    const result = toolConfig.skill
      ? await scanBatchWithSkill(client, batch, toolConfig.model, toolConfig.skill)
      : await scanBatchWithPrompt(client, batch, toolConfig.model, toolConfig.prompt ?? SYSTEM_PROMPT);

    if (result.error) {
      errorCount++;
    } else {
      findings.push(...result.findings);
    }
  }

  if (errorCount > 0) {
    console.error(`[claude] ${errorCount}/${batches.length} batch(es) failed — findings may be incomplete`);
  }
  console.log(`[claude] ${findings.length} finding(s)${errorCount > 0 ? ' (incomplete — API errors occurred)' : ''}:`);
  for (const f of findings) {
    console.log(`[claude]   ${f.severity.toUpperCase()} ${f.file}:${f.startLine ?? f.line}-${f.endLine ?? f.line} [${f.ruleId}] ${f.message}`);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Prompt mode — current behaviour, single API call with system prompt
// ---------------------------------------------------------------------------

async function scanBatchWithPrompt(client, files, model, prompt) {
  const userMessage = buildUserMessage(files);

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: prompt,
      messages: [{ role: 'user', content: userMessage }],
      tools: [REPORT_FINDINGS_TOOL],
      tool_choice: { type: 'any' },
    });

    return extractFindings(response.content);
  } catch (err) {
    console.error('[claude] API error during scan batch (prompt mode):', err.message ?? err);
    return { error: true };
  }
}

// ---------------------------------------------------------------------------
// Skill mode — Skills API + code_execution, handles pause_turn continuations
// ---------------------------------------------------------------------------

async function scanBatchWithSkill(client, files, model, skillConfig) {
  const userMessage = buildUserMessage(files);
  const messages = [{ role: 'user', content: userMessage }];

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
    let response = await client.beta.messages.create({
      model,
      max_tokens: 4096,
      betas:    ['code-execution-2025-08-25', 'skills-2025-10-02'],
      container: containerSpec,
      messages,
      tools,
    });

    // Continue if the skill needs more turns (long-running code execution)
    for (let i = 0; i < MAX_SKILL_TURNS && response.stop_reason === 'pause_turn'; i++) {
      debug('claude', `pause_turn continuation ${i + 1}/${MAX_SKILL_TURNS}`);
      messages.push({ role: 'assistant', content: response.content });
      response = await client.beta.messages.create({
        model,
        max_tokens: 4096,
        betas:    ['code-execution-2025-08-25', 'skills-2025-10-02'],
        container: { id: response.container.id, ...containerSpec },
        messages,
        tools,
      });
    }

    return extractFindings(response.content);
  } catch (err) {
    console.error('[claude] API error during scan batch (skill mode):', err.message ?? err);
    return { error: true };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildUserMessage(files) {
  return files
    .map(f => f.promptContent)
    .join('\n\n');
}

function extractFindings(content) {
  const toolUse = content.find(
    b => b.type === 'tool_use' && b.name === 'report_findings'
  );
  if (!toolUse) return { findings: [] };

  return {
    findings: (toolUse.input.findings ?? []).map(normalizeFinding),
  };
}

function splitIntoBatches(fileContents, charLimit) {
  const batches = [];
  let current = [];
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

function normalizeFinding(finding) {
  const startLine = normalizePositiveInt(finding.startLine ?? finding.line) ?? 1;
  const endLine = normalizePositiveInt(finding.endLine ?? finding.startLine ?? finding.line) ?? startLine;

  return {
    ...finding,
    line: startLine,
    startLine,
    endLine: endLine >= startLine ? endLine : startLine,
    anchorKind: normalizeAnchorKind(finding.anchorKind),
    anchorLine: normalizePositiveInt(finding.anchorLine),
    evidence: typeof finding.evidence === 'string' ? finding.evidence.trim() : '',
    ruleId: `claude/${finding.ruleId}`,
    tool: 'claude',
  };
}

function formatSnippetForPrompt(file, snippetContent) {
  return [
    `### ${file}`,
    '```text',
    snippetContent,
    '```',
  ].join('\n');
}

function formatFileForPrompt(file, content, ranges) {
  const changedLines = formatChangedRanges(ranges);
  return [
    `### ${file}`,
    `Changed lines in this PR: ${changedLines}`,
    '```text',
    numberLines(content),
    '```',
  ].join('\n');
}

function numberLines(content) {
  const lines = content.split('\n');
  const width = String(lines.length).length;
  return lines
    .map((line, index) => `${String(index + 1).padStart(width, '0')} | ${line}`)
    .join('\n');
}

function formatChangedRanges(ranges) {
  if (!ranges.length) return 'none provided';
  return ranges.map(range => `${range.start}-${range.end}`).join(', ');
}

function normalizePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeAnchorKind(value) {
  return value === 'line' || value === 'declaration' || value === 'span'
    ? value
    : null;
}
