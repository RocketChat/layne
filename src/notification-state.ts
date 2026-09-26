import { createHash } from 'crypto';
import type { NotificationEvent, NotifierConfig, ProcessedFinding, Severity, Tool } from './types.js';
import type {
  ExceptionApprovalInfo,
  FinalSecurityState,
  NotificationCoverageIssue,
  NotificationProjection,
} from './notifiers/types.js';

export const DEFAULT_NOTIFY_ON: readonly NotificationEvent[] = [
  'findings',
  'internal-error',
  'exception-approval',
];

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const EVENT_PRIORITY: readonly NotificationEvent[] = [
  'internal-error',
  'exception-approval',
  'coverage-failure',
  'findings',
  'incomplete-scan',
];

export function buildFinalSecurityState({
  conclusion,
  findings,
  coverageIssues = [],
  exceptionApproval = null,
  internalError,
}: {
  conclusion: FinalSecurityState['conclusion'];
  findings: ProcessedFinding[];
  coverageIssues?: NotificationCoverageIssue[];
  exceptionApproval?: ExceptionApprovalInfo | null;
  internalError?: FinalSecurityState['internalError'];
}): FinalSecurityState {
  return {
    conclusion,
    findings,
    coverageIssues,
    exceptionApproval,
    ...(internalError && { internalError }),
  };
}

export function buildInternalErrorState(message: string): FinalSecurityState {
  const errorId = createHash('sha256')
    .update(`layne-internal-error:v1:${message}`)
    .digest('hex')
    .slice(0, 12);

  return buildFinalSecurityState({
    conclusion: 'failure',
    findings: [],
    internalError: { errorId },
  });
}

export function projectNotificationState(
  state: FinalSecurityState,
  config: NotifierConfig,
): NotificationProjection {
  const notifyOn = new Set(config.notifyOn ?? DEFAULT_NOTIFY_ON);
  const minSeverity = config.minFindingSeverity ?? 'high';
  const exceptedIds = new Set(state.exceptionApproval?.findingIds ?? []);
  const relevantFindings = state.findings
    .filter(finding => !exceptedIds.has(finding._findingId ?? ''))
    .filter(finding => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[minSeverity])
    .sort(compareFindings);
  const coverageFailures = state.coverageIssues.filter(issue => issue.level === 'blocking').sort(compareCoverage);
  const incompleteCoverage = state.coverageIssues.filter(issue => issue.level === 'incomplete').sort(compareCoverage);
  const events: NotificationEvent[] = [];

  if (notifyOn.has('findings') && relevantFindings.length > 0) events.push('findings');
  if (notifyOn.has('coverage-failure') && coverageFailures.length > 0) events.push('coverage-failure');
  if (notifyOn.has('incomplete-scan') && incompleteCoverage.length > 0) events.push('incomplete-scan');
  if (notifyOn.has('internal-error') && state.internalError) events.push('internal-error');
  if (notifyOn.has('exception-approval') && state.exceptionApproval?.approved) events.push('exception-approval');

  events.sort((a, b) => EVENT_PRIORITY.indexOf(a) - EVENT_PRIORITY.indexOf(b));
  const selectedCoverage = [
    ...(events.includes('coverage-failure') ? coverageFailures : []),
    ...(events.includes('incomplete-scan') ? incompleteCoverage : []),
  ];
  const canonical = events.length === 0
    ? { version: 1, state: 'quiet' }
    : {
        version: 1,
        conclusion: state.conclusion,
        events,
        findings: (events.includes('findings') ? relevantFindings : []).map(finding => ({
          id: finding._findingId ?? '',
          severity: finding.severity,
          tool: finding.tool,
          ruleId: finding.ruleId,
          file: finding.file,
          line: finding.startLine ?? finding.line,
        })),
        coverage: selectedCoverage.map(issue => ({
          level: issue.level,
          source: issue.source,
          reason: issue.reason,
          count: issue.count,
          files: [...(issue.files ?? [])].sort(),
        })),
        exception: events.includes('exception-approval') && state.exceptionApproval?.approved
          ? {
              approver: state.exceptionApproval.approver ?? '',
              findingIds: [...(state.exceptionApproval.findingIds ?? [])].sort(),
              reason: state.exceptionApproval.reason ?? '',
            }
          : null,
        internalErrorId: events.includes('internal-error') ? state.internalError?.errorId ?? '' : '',
      };

  return {
    events,
    primaryEvent: events[0] ?? null,
    relevantFindings,
    fingerprint: createHash('sha256')
      .update(`layne-notification-state:v1:${JSON.stringify(canonical)}`)
      .digest('hex'),
  };
}

function compareFindings(a: ProcessedFinding, b: ProcessedFinding): number {
  return (a._findingId ?? '').localeCompare(b._findingId ?? '')
    || a.severity.localeCompare(b.severity)
    || a.tool.localeCompare(b.tool)
    || a.ruleId.localeCompare(b.ruleId)
    || a.file.localeCompare(b.file)
    || (a.startLine ?? a.line) - (b.startLine ?? b.line);
}

function compareCoverage(a: NotificationCoverageIssue, b: NotificationCoverageIssue): number {
  return a.level.localeCompare(b.level)
    || a.source.localeCompare(b.source)
    || a.reason.localeCompare(b.reason)
    || a.count - b.count
    || [...(a.files ?? [])].sort().join('\0').localeCompare([...(b.files ?? [])].sort().join('\0'));
}

export function coverageIssue(
  level: NotificationCoverageIssue['level'],
  source: Tool | 'git' | 'diff',
  reason: string,
  count = 1,
  files?: string[],
): NotificationCoverageIssue {
  return { level, source, reason, count, ...(files?.length ? { files } : {}) };
}
