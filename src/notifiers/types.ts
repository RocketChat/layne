import type { NotificationEvent, ProcessedFinding, NotifierConfig, Tool } from '../types.js';

export interface ExceptionApprovalInfo {
  approved: boolean;
  approver?: string;
  reason?: string;
  findingIds?: string[];
}

export interface NotificationCoverageIssue {
  level: 'blocking' | 'incomplete';
  source: Tool | 'git' | 'diff';
  reason: string;
  count: number;
  files?: string[];
}

export interface FinalSecurityState {
  conclusion: 'success' | 'failure' | 'neutral';
  findings: ProcessedFinding[];
  coverageIssues: NotificationCoverageIssue[];
  exceptionApproval: ExceptionApprovalInfo | null;
  internalError?: { errorId: string };
}

export interface NotificationProjection {
  events: NotificationEvent[];
  primaryEvent: NotificationEvent | null;
  relevantFindings: ProcessedFinding[];
  fingerprint: string;
}

export interface NotifierAttemptResult {
  delivered: boolean;
  retryable?: boolean;
  reason?: string;
}

export interface NotificationDeliveryOutcome {
  notifier: string;
  status: 'delivered' | 'deduplicated' | 'filtered' | 'failed' | 'busy' | 'stale';
  attempts?: number;
  reason?: string;
}

/** Params passed to the top-level notify() orchestrator */
export interface NotifyOrchestratorParams {
  state: FinalSecurityState;
  owner: string;
  repo: string;
  prNumber: number;
  notificationConfig: Record<string, NotifierConfig>;
  scanSequence?: number;
  headSha?: string;
  signal?: AbortSignal;
}

/** Params passed to each individual notifier implementation */
export interface NotifyParams {
  state: FinalSecurityState;
  projection: NotificationProjection;
  owner: string;
  repo: string;
  prNumber: number;
  toolConfig: NotifierConfig;
  headSha?: string;
  signal?: AbortSignal;
}

/** Contract for individual notifier implementations */
export interface Notifier {
  notify(params: NotifyParams): Promise<NotifierAttemptResult>;
}
