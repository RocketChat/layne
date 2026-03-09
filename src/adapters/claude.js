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

const SYSTEM_PROMPT =
  'You are a security code reviewer. Analyse the provided source files for malicious intent: ' +
  'reverse shells, backdoors, credential exfiltration, obfuscated payloads, and supply-chain attacks. ' +
  'Report ONLY confirmed malicious patterns with high confidence. Do not report style issues, bugs, or ' +
  'theoretical vulnerabilities. Call `report_findings` with your results.';

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
            line:     { type: 'integer' },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            message:  { type: 'string' },
            ruleId:   { type: 'string' },
          },
          required: ['file', 'line', 'severity', 'message', 'ruleId'],
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
 * Uses Claude's tool use to get back a structured list of malicious-intent
 * findings rather than parsing free-form text.
 */
export async function runClaude({ workspacePath, changedFiles, toolConfig = DEFAULT_CONFIG.claude }) {
  if (!changedFiles || changedFiles.length === 0) return [];
  if (!toolConfig.enabled) return [];

  debug('claude', `scanning ${changedFiles.length} file(s)`);

  // 1. Read files, skip binaries, cap at FILE_SIZE_LIMIT each
  const fileContents = [];
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
    fileContents.push({ file, content });
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
    const result = await scanBatch(client, batch, toolConfig.model);
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
    console.log(`[claude]   ${f.severity.toUpperCase()} ${f.file}:${f.line} [${f.ruleId}] ${f.message}`);
  }

  return findings;
}

function splitIntoBatches(fileContents, charLimit) {
  const batches = [];
  let current = [];
  let currentSize = 0;

  for (const fc of fileContents) {
    const size = fc.file.length + fc.content.length;
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

async function scanBatch(client, files, model) {
  const userMessage = files
    .map(f => `### ${f.file}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      tools: [REPORT_FINDINGS_TOOL],
      tool_choice: { type: 'any' },
    });

    const toolUse = response.content.find(
      b => b.type === 'tool_use' && b.name === 'report_findings'
    );
    if (!toolUse) return { findings: [] };

    return { findings: (toolUse.input.findings ?? []).map(f => ({
      ...f,
      ruleId: `claude/${f.ruleId}`,
      tool:   'claude',
    })) };
  } catch (err) {
    console.error('[claude] API error during scan batch:', err.message ?? err);
    return { error: true };
  }
}
