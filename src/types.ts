// src/types.ts

export type Severity        = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Tool            = 'semgrep' | 'trufflehog' | 'claude';
export type AnnotationLevel = 'failure' | 'warning' | 'notice';
export type ScanMode        = 'changed_files' | 'diff_only';
export type TriggerOn       = 'pull_request' | 'workflow_run' | 'workflow_job';
export type AnchorKind      = 'line' | 'declaration' | 'span';
export type EvidenceStatus  = 'unique' | 'ambiguous' | 'not-found' | 'missing';

// ---- Raw adapter output (discriminated union by tool) ----

export interface BaseFinding {
  file: string;
  line: number;
  severity: Severity;
  message: string;
  ruleId: string;
  tool: Tool;
}

export interface SemgrepFinding extends BaseFinding {
  tool: 'semgrep';
  startLine?: number;
  endLine?: number;
}

export interface TrufflehogFinding extends BaseFinding {
  tool: 'trufflehog';
}

export interface ClaudeRawFinding extends BaseFinding {
  tool: 'claude';
  startLine?: number;
  endLine?: number;
  evidence?: string;
  anchorKind?: AnchorKind;
  anchorLine?: number;
}

export type RawFinding = SemgrepFinding | TrufflehogFinding | ClaudeRawFinding;

// ---- Post-pipeline finding (after location validation + exception stamping) ----

export interface ProcessedFinding extends BaseFinding {
  tool: Tool;
  startLine?: number;
  endLine?: number;
  suppressionLine?: number;
  locationValidated?: boolean;
  annotationEligible?: boolean;
  annotationStartLine?: number;
  annotationEndLine?: number;
  annotationReason?: string;
  locationReason?: string;
  evidence?: string;
  evidenceStatus?: EvidenceStatus;
  evidenceStartLine?: number;
  evidenceEndLine?: number;
  anchorKind?: AnchorKind;
  anchorLine?: number;
  _findingId?: string;
}

// ---- Infrastructure types ----

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: AnnotationLevel;
  title: string;
  message: string;
}

export interface JobData {
  installationId: number;
  owner: string;
  repo: string;
  repoFullName: string;
  cloneUrl: string;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  prNumber: number;
  labels: string[];
  checkRunId: number;
}

export interface PRCacheData {
  prNumber: number;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  labels: string[];
  installationId: number;
  cloneUrl: string;
  repoFullName: string;
}

export interface ExceptionData {
  approver: string;
  reason: string;
  timestamp: string;
  approvedHeadSha: string;
}

// ---- Scan config types ----

export interface SemgrepConfig {
  enabled: boolean;
  extraArgs: string[];
}

export interface TrufflehogConfig {
  enabled: boolean;
  extraArgs: string[];
}

export interface SkillConfig {
  id: string;
  version?: string;
}

export interface ClaudeConfig {
  enabled: boolean;
  model: string;
  prompt?: string | null;
  skill?: SkillConfig | null;
}

export interface LabelConfig {
  onFailure?: string[];
  onSuccess?: string[];
}

export interface TriggerConfig {
  on: TriggerOn;
  workflow?: string;
  job?: string;
  conclusions?: string[];
}

export interface CommentConfig {
  enabled: boolean;
  template?: string | null;
  warningTemplate?: string | null;
}

export interface ExceptionApproversConfig {
  users: string[];
  teams: string[];
}

export interface NotifierConfig {
  enabled: boolean;
  webhookUrl?: string;
  template?: string;
}

export interface ScanConfig {
  mode: ScanMode;
  contextLines: number;
  timeoutMinutes: number;
  semgrep: SemgrepConfig;
  trufflehog: TrufflehogConfig;
  claude: ClaudeConfig;
  labels: LabelConfig;
  trigger: TriggerConfig;
  comment: CommentConfig;
  exceptionApprovers: ExceptionApproversConfig;
  notifications: Record<string, NotifierConfig>;
}

// ---- Runtime types ----

export type LineRange = { start: number; end: number };

/**
 * Changed line ranges as returned by fetcher.getChangedLineRanges.
 * Normalized to Map for consistency throughout the pipeline.
 */
export type LineRangesByFile = Map<string, LineRange[]>;

/** head line -> base line (null = new line added in this PR) */
export type LineMap = Map<number, number | null>;

export interface ScanContext {
  mode: ScanMode;
  contextLines: number;
  repoWorkspacePath: string;
  scanWorkspacePath: string;
  scanFiles: string[];
  promptFiles: Array<{ file: string; content: string }>;
  changedLineRanges: LineRangesByFile;
}

export interface TemplateContext {
  repo: string;
  owner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  summary: string;
  rules: string;
  [key: string]: string | number;
}

export interface ParsedCommand {
  ids: string[];
  reason: string | null;
  error?: string;
}

export interface ValidationResult {
  eligible: boolean;
  reason: string;
  startLine?: number;
  endLine?: number;
}

export interface ReportResult {
  annotations: Annotation[];
  conclusion: 'success' | 'failure' | 'neutral';
  summary: string;
}

export interface ExceptionSummary {
  conclusion: 'success' | 'failure';
  summary: string;
  approvedCount?: number;
}

export interface WorkspaceInfo {
  workspacePath: string;
  repoPath: string;
  cleanup: () => Promise<void>;
}
