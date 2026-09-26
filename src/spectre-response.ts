import type { Severity, SpectreRawFinding } from './types.js';

export const SPECTRE_RULE_IDS = [
  'reverse-shell',
  'credential-exfiltration',
  'obfuscated-payload',
  'backdoor',
  'supply-chain-abuse',
  'covert-execution',
] as const;

export const SPECTRE_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const MAX_SPECTRE_FINDINGS_PER_FILE = 3;
export const MAX_SPECTRE_FINDINGS_PER_RESPONSE = 30;
export const MAX_SPECTRE_FILES_PER_RESPONSE = MAX_SPECTRE_FINDINGS_PER_RESPONSE / MAX_SPECTRE_FINDINGS_PER_FILE;
export const MAX_SPECTRE_MESSAGE_LENGTH = 300;
export const MAX_SPECTRE_EVIDENCE_LENGTH = 1_000;

export function maxSpectreFindings(expectedFiles: number | string | readonly string[]): number {
  const count = typeof expectedFiles === 'number'
    ? Number.isSafeInteger(expectedFiles) && expectedFiles > 0 ? expectedFiles : 1
    : typeof expectedFiles === 'string'
      ? 1
      : Math.max(1, new Set(expectedFiles).size);
  return Math.min(MAX_SPECTRE_FINDINGS_PER_RESPONSE, count * MAX_SPECTRE_FINDINGS_PER_FILE);
}

export function createSpectreResponseSchema(expectedFiles: number | readonly string[] = 1) {
  const fileSchema = typeof expectedFiles === 'number'
    ? { type: 'string' as const }
    : { type: 'string' as const, enum: [...new Set(expectedFiles)] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        maxItems: maxSpectreFindings(expectedFiles),
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['file', 'severity', 'ruleId', 'message', 'evidence'],
          properties: {
            file: fileSchema,
            startLine: { type: ['integer', 'null'] },
            endLine: { type: ['integer', 'null'] },
            severity: { type: 'string', enum: SPECTRE_SEVERITIES },
            ruleId: { type: 'string', enum: SPECTRE_RULE_IDS },
            message: { type: 'string' },
            evidence: { type: 'string' },
          },
        },
      },
    },
  } as const;
}

export const SPECTRE_RESPONSE_SCHEMA = createSpectreResponseSchema();

const ALLOWED_RULE_IDS = new Set<string>(SPECTRE_RULE_IDS);
const ALLOWED_SEVERITIES = new Set<Severity>(SPECTRE_SEVERITIES);

interface RawFindingFromLLM {
  file?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  severity?: unknown;
  ruleId?: unknown;
  message?: unknown;
  evidence?: unknown;
}

export interface SpectreResponseParseResult {
  findings: SpectreRawFinding[];
  validEnvelope: boolean;
  invalidFindings: number;
  omittedFindings: number;
  candidateFindings: number;
  violations: SpectreResponseViolation[];
}

export type SpectreResponseViolationCode =
  | 'invalid-json'
  | 'invalid-envelope'
  | 'invalid-finding'
  | 'invalid-file'
  | 'invalid-severity'
  | 'invalid-message'
  | 'message-too-long'
  | 'invalid-rule-id'
  | 'invalid-evidence'
  | 'evidence-too-long'
  | 'invalid-start-line'
  | 'invalid-end-line'
  | 'invalid-line-range'
  | 'per-file-limit'
  | 'response-limit';

export interface SpectreResponseViolation {
  code: SpectreResponseViolationCode;
  findingIndex?: number;
  actual?: number;
  maximum?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function invalidFinding(code: SpectreResponseViolationCode, actual?: number, maximum?: number): {
  finding: null;
  violation: Omit<SpectreResponseViolation, 'findingIndex'>;
} {
  return { finding: null, violation: { code, ...(actual === undefined ? {} : { actual }), ...(maximum === undefined ? {} : { maximum }) } };
}

function normalizeFinding(raw: unknown, expectedFiles: ReadonlySet<string>): {
  finding: SpectreRawFinding | null;
  violation?: Omit<SpectreResponseViolation, 'findingIndex'>;
} {
  if (!isRecord(raw)) return invalidFinding('invalid-finding');
  const finding = raw as RawFindingFromLLM;
  if (typeof finding.file !== 'string' || !expectedFiles.has(finding.file)) return invalidFinding('invalid-file');
  if (typeof finding.severity !== 'string' || !ALLOWED_SEVERITIES.has(finding.severity as Severity)) return invalidFinding('invalid-severity');
  if (typeof finding.message !== 'string' || !finding.message.trim()) return invalidFinding('invalid-message');
  if (finding.message.length > MAX_SPECTRE_MESSAGE_LENGTH) {
    return invalidFinding('message-too-long', finding.message.length, MAX_SPECTRE_MESSAGE_LENGTH);
  }
  if (typeof finding.ruleId !== 'string' || !ALLOWED_RULE_IDS.has(finding.ruleId)) return invalidFinding('invalid-rule-id');
  if (typeof finding.evidence !== 'string' || !finding.evidence.trim()) return invalidFinding('invalid-evidence');
  if (finding.evidence.length > MAX_SPECTRE_EVIDENCE_LENGTH) {
    return invalidFinding('evidence-too-long', finding.evidence.length, MAX_SPECTRE_EVIDENCE_LENGTH);
  }

  const startLineHint = normalizePositiveInt(finding.startLine);
  const endLineHint = normalizePositiveInt(finding.endLine);
  if (finding.startLine !== undefined && finding.startLine !== null && !startLineHint) return invalidFinding('invalid-start-line');
  if (finding.endLine !== undefined && finding.endLine !== null && !endLineHint) return invalidFinding('invalid-end-line');
  const startLine = startLineHint ?? 1;
  const endLine = endLineHint ?? startLine;
  if (endLine < startLine) return invalidFinding('invalid-line-range');

  return {
    finding: {
      file: finding.file,
      line: startLine,
      startLine,
      endLine,
      ...(startLineHint === null ? {} : { reportedStartLine: startLineHint }),
      ...(endLineHint === null ? {} : { reportedEndLine: endLineHint }),
      severity: finding.severity as Severity,
      message: finding.message.trim(),
      ruleId: finding.ruleId,
      evidence: finding.evidence,
      tool: 'spectre',
    },
  };
}

export function parseSpectreResponse(responseText: string, expectedFiles: string | readonly string[]): SpectreResponseParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText.trim());
  } catch {
    return {
      findings: [], validEnvelope: false, invalidFindings: 0, omittedFindings: 0,
      candidateFindings: 0, violations: [{ code: 'invalid-json' }],
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed['findings'])) {
    return {
      findings: [], validEnvelope: false, invalidFindings: 0, omittedFindings: 0,
      candidateFindings: 0, violations: [{ code: 'invalid-envelope' }],
    };
  }

  const rawFindings = parsed['findings'];
  const findingLimit = maxSpectreFindings(expectedFiles);
  const admitted = rawFindings.slice(0, findingLimit);
  const findings: SpectreRawFinding[] = [];
  let invalidFindings = 0;
  const allowedFiles = new Set(typeof expectedFiles === 'string' ? [expectedFiles] : expectedFiles);
  const findingsByFile = new Map<string, number>();
  const violations: SpectreResponseViolation[] = [];

  for (const [findingIndex, raw] of admitted.entries()) {
    const normalized = normalizeFinding(raw, allowedFiles);
    const finding = normalized.finding;
    if (!finding) {
      invalidFindings++;
      violations.push({ findingIndex, code: normalized.violation?.code ?? 'invalid-finding', ...normalized.violation });
      continue;
    }
    const count = findingsByFile.get(finding.file) ?? 0;
    if (count >= MAX_SPECTRE_FINDINGS_PER_FILE) {
      invalidFindings++;
      violations.push({ findingIndex, code: 'per-file-limit', actual: count + 1, maximum: MAX_SPECTRE_FINDINGS_PER_FILE });
      continue;
    }
    findingsByFile.set(finding.file, count + 1);
    findings.push(finding);
  }

  const deduplicated = findings.filter((finding, index, all) =>
    all.findIndex(other =>
      other.file === finding.file &&
      other.ruleId === finding.ruleId &&
      other.severity === finding.severity &&
      other.evidence === finding.evidence
    ) === index,
  );

  const omittedFindings = Math.max(0, rawFindings.length - findingLimit);
  if (omittedFindings > 0) {
    violations.push({ code: 'response-limit', actual: rawFindings.length, maximum: findingLimit });
  }
  return {
    findings: deduplicated,
    validEnvelope: true,
    invalidFindings,
    omittedFindings,
    candidateFindings: rawFindings.length,
    violations,
  };
}
