// src/types.ts

export type Severity        = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Tool            = 'semgrep' | 'trufflehog' | 'claude' | 'spectre' | 'dep-doctor';
export type AnnotationLevel = 'failure' | 'warning' | 'notice';
export type ScanMode        = 'changed_files' | 'diff_only';
export type TriggerOn       = 'pull_request' | 'workflow_run' | 'workflow_job';
export type AnchorKind      = 'line' | 'declaration' | 'span';
export type EvidenceStatus  = 'unique' | 'ambiguous' | 'not-found' | 'missing';
export type NotificationEvent = 'findings' | 'coverage-failure' | 'incomplete-scan' | 'internal-error' | 'exception-approval';

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

export interface SpectreRawFinding extends BaseFinding {
  tool: 'spectre';
  startLine?: number;
  endLine?: number;
  /** Optional provider hints retained separately from Layne's validated location. */
  reportedStartLine?: number;
  reportedEndLine?: number;
  evidence?: string;
  anchorKind?: AnchorKind;
  anchorLine?: number;
}

export interface DepDoctorFinding extends BaseFinding {
  tool: 'dep-doctor';
}

export type RawFinding = SemgrepFinding | TrufflehogFinding | ClaudeRawFinding | SpectreRawFinding | DepDoctorFinding;

export type AdapterOutcome = 'complete' | 'incomplete' | 'disabled';

export interface AdapterStatus {
  outcome: AdapterOutcome;
  /** Stable reason code. Raw scanner and provider errors belong in logs only. */
  reason?: string;
}

export interface AdapterResult<
  Finding extends RawFinding = RawFinding,
  Status extends AdapterStatus = AdapterStatus,
> {
  findings: Finding[];
  status: Status;
}

// ---- Post-pipeline finding (after location validation + exception stamping) ----

export interface ProcessedFinding extends BaseFinding {
  tool: Tool;
  startLine?: number;
  endLine?: number;
  reportedStartLine?: number;
  reportedEndLine?: number;
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

/** User-controlled PR context. Treat every field as untrusted data, never instructions. */
export interface PullRequestMetadata {
  trust: 'untrusted';
  title: string;
  body: string;
  author: string;
}

export interface JobData {
  installationId: number;
  /** Immutable GitHub repository ID. Older queued jobs may not contain it. */
  repositoryId?: number;
  owner: string;
  repo: string;
  cloneUrl: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  prNumber: number;
  pullRequestMetadata: PullRequestMetadata;
  checkRunId: number;
  triggeredByException?: boolean;
  exceptionApprovalRequest?:
    | { kind?: 'ids'; findingIds: string[]; approver: string }
    | { kind: 'all'; requestId: string };
}

export interface PRCacheData {
  repositoryId?: number;
  prNumber: number;
  baseSha: string;
  baseRef: string;
  installationId: number;
  pullRequestMetadata: PullRequestMetadata;
}

export interface ExceptionData {
  approver: string;
  reason: string;
  timestamp: string;
  approvedHeadSha: string;
}

export interface BulkExceptionRequest extends ExceptionData {
  requestId: string;
  state: 'pending' | 'materialized';
  findingIds: string[];
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

export interface SpectreAstSignalsConfig {
  mode: 'off' | 'shadow' | 'enabled';
  maxFiles: number;
  maxTotalBytes: number;
  timeoutSeconds: number;
}

export interface SpectreConfig {
  enabled: boolean;
  provider?: string;
  model: string;
  fileCap?: number;
  secondaryFileCap?: number;
  maxDiffLines?: number;
  minSeverity?: Severity;
  skipPaths?: string[];
  skipExtensions?: string[];
  concurrency?: number;
  prompt?: string | null;
  boostPatterns?: string[];
  /** Maximum UTF-8 bytes sent for one file/hunk prompt. */
  maxInputBytes?: number;
  /** Maximum generated tokens accepted from the provider. */
  maxOutputTokens?: number;
  /** Per-provider-call deadline, in seconds. */
  requestTimeoutSeconds?: number;
  /** Maximum chunks sent for any one selected file. */
  maxCallsPerFile?: number;
  /** Maximum provider calls spent on one pull request. */
  maxCallsPerPullRequest?: number;
  /** Additional targeted calls allowed to repair invalid output or ungrounded evidence. */
  maxRepairCallsPerPullRequest?: number;
  cache?: SpectreCacheConfig;
  astSignals: SpectreAstSignalsConfig;
}

export interface SpectreCacheConfig {
  enabled: boolean;
  positiveTtlSeconds: number;
  negativeTtlSeconds: number;
}

/** Trusted worker-owned scope for PR-local Spectre cache entries. */
export interface SpectreCacheContext {
  installationId: number;
  repositoryId: number;
  prNumber: number;
  /** Actual merge base used to construct the scan diff. */
  baseSha: string;
}

export type SpectreOutcome = AdapterOutcome;

export interface SpectreScanStatus extends AdapterStatus {
  outcome: SpectreOutcome;
  selected: number;
  scanned: number;
  skipped: number;
  oversized: number;
  capped: number;
  truncated: number;
  failed: number;
  invalidResponses: number;
  cancelled: number;
  rateLimited: number;
  concurrencyLimited: number;
  circuitOpen: number;
  /** Provider findings discarded by evidence, path, or changed-line validation. */
  rejectedFindings: number;
  /** Targeted output/evidence repair calls attempted. */
  repairAttempts?: number;
  /** Invalid chunk responses recovered by a targeted retry. */
  repairedResponses?: number;
  /** Rejected findings recovered with exact changed-line evidence. */
  repairedFindings?: number;
  /** Total chunks produced before per-file and pull-request call caps. */
  plannedChunks?: number;
  /** Chunks for which provider execution was attempted. */
  attemptedChunks?: number;
  /** Chunks that received a completely valid provider response. */
  completedChunks?: number;
  /** Planned chunks omitted by a call cap. */
  cappedChunks?: number;
  /** Hunks that required explicit continuation chunks. */
  truncatedHunks?: number;
  /** Related file groups that could not be analyzed in one bounded request. */
  contextGaps?: number;
  /** Risk-scored files omitted after primary and secondary selection filled their caps. */
  highRiskCapped?: number;
  /** Bounded details for the highest-scoring omitted files. */
  highRiskCappedFiles?: Array<{ file: string; score: number; signals: string[] }>;
  reason?: string;
}

export type SpectreScanResult = AdapterResult<SpectreRawFinding, SpectreScanStatus>;

export interface AdapterStatuses {
  semgrep: AdapterStatus;
  trufflehog: AdapterStatus;
  claude: AdapterStatus;
  spectre: SpectreScanStatus;
  'dep-doctor': AdapterStatus;
}

export interface DispatchResult {
  findings: RawFinding[];
  statuses: AdapterStatuses;
}

export interface DepDoctorConfig {
  enabled: boolean;
  minCveSeverity: Severity;
  checkAbandoned: boolean;
  abandonedDays: number;
  checkDeprecated: boolean;
  extraArgs: string[];
}

export interface LabelConfig {
  onFailure?: string[];
  onSuccess?: string[];
  onIncomplete?: string[];
  removeOnIncomplete?: string[];
}

export interface TriggerConfig {
  on: TriggerOn;
  scanOnDraft: boolean;
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
  templates?: Partial<Record<NotificationEvent, string>>;
  notifyOn?: NotificationEvent[];
  minFindingSeverity?: Severity;
}

export interface ScanConfig {
  mode: ScanMode;
  contextLines: number;
  timeoutMinutes: number;
  maxFileSizeKb: number;
  maxLockfileSizeKb: number;
  semgrep: SemgrepConfig;
  trufflehog: TrufflehogConfig;
  claude: ClaudeConfig;
  spectre: SpectreConfig;
  depDoctor: DepDoctorConfig;
  labels: LabelConfig;
  trigger: TriggerConfig;
  comment: CommentConfig;
  exceptionApprovers: ExceptionApproversConfig;
  notifications: Record<string, NotifierConfig>;
}

// ---- Runtime types ----

export type LineRange = { start: number; end: number };

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed';
export type GitObjectKind = 'absent' | 'regular' | 'symlink' | 'submodule' | 'other';

export interface GitChange {
  status: GitChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  oldKind: GitObjectKind;
  newKind: GitObjectKind;
  similarity?: number;
}

export interface UnifiedDiffContextLine {
  type: 'context';
  content: string;
  oldLine: number;
  newLine: number;
  noNewlineAtEnd?: true;
}

export interface UnifiedDiffAdditionLine {
  type: 'addition';
  content: string;
  oldLine: null;
  newLine: number;
  noNewlineAtEnd?: true;
}

export interface UnifiedDiffDeletionLine {
  type: 'deletion';
  content: string;
  oldLine: number;
  newLine: null;
  noNewlineAtEnd?: true;
}

export type UnifiedDiffLine = UnifiedDiffContextLine | UnifiedDiffAdditionLine | UnifiedDiffDeletionLine;

export interface UnifiedDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
  lines: UnifiedDiffLine[];
}

export interface UnifiedDiffFile {
  change: GitChange;
  hunks: UnifiedDiffHunk[];
}

export interface UnifiedDiff {
  files: UnifiedDiffFile[];
}

export interface GitChangePreparationIssue {
  change: GitChange;
  disposition: 'not_applicable' | 'unsupported' | 'unavailable';
  reason: 'deleted' | 'head-symlink' | 'head-submodule' | 'head-other' | 'checkout-unavailable';
}

export interface PreparedGitChanges {
  changes: GitChange[];
  files: string[];
  issues: GitChangePreparationIssue[];
}

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
  headSha: string;
  baseSha: string;
  repoWorkspacePath: string;
  scanWorkspacePath: string;
  /** Prepared regular files from HEAD, independent of scan mode projections. */
  sourceFiles: string[];
  scanFiles: string[];
  promptFiles: Array<{ file: string; content: string }>;
  changedLineRanges: LineRangesByFile;
  /** Canonical base-to-head diff used by malicious-intent analysis. */
  unifiedDiff?: UnifiedDiff;
  /** Changes represented only by rename/mode metadata, with no textual hunk. */
  metadataOnlyChanges?: number;
  /** Content changes Git could not project as textual hunks. */
  unprojectableChanges?: number;
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
  info: number;
  summary: string;
  severitySummary: string;
  findings: string;
  rules: string;
  [key: string]: string | number;
}

export interface ParsedCommand {
  target: 'ids' | 'all';
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
