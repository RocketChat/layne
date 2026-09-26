import { describe, expect, it } from 'vitest';
import { buildFinalSecurityState, projectNotificationState } from '../notification-state.js';
import type { NotifierConfig, ProcessedFinding } from '../types.js';

function finding(id: string, severity: ProcessedFinding['severity'] = 'high'): ProcessedFinding {
  return { file: `${id}.js`, line: 1, severity, message: id, ruleId: 'rule', tool: 'semgrep', _findingId: id };
}

describe('notification state', () => {
  it('does not notify for warnings by default', () => {
    const state = buildFinalSecurityState({ conclusion: 'success', findings: [finding('one', 'medium')] });
    expect(projectNotificationState(state, { enabled: true }).events).toEqual([]);
  });

  it('allows warning notifications through minFindingSeverity', () => {
    const state = buildFinalSecurityState({ conclusion: 'success', findings: [finding('one', 'medium')] });
    expect(projectNotificationState(state, { enabled: true, minFindingSeverity: 'medium' }).events).toEqual(['findings']);
  });

  it('changes fingerprint when a same-count finding is replaced', () => {
    const one = buildFinalSecurityState({ conclusion: 'failure', findings: [finding('one')] });
    const two = buildFinalSecurityState({ conclusion: 'failure', findings: [finding('two')] });
    expect(projectNotificationState(one, { enabled: true }).fingerprint)
      .not.toBe(projectNotificationState(two, { enabled: true }).fingerprint);
  });

  it('is insensitive to finding order', () => {
    const one = buildFinalSecurityState({ conclusion: 'failure', findings: [finding('one'), finding('two')] });
    const two = buildFinalSecurityState({ conclusion: 'failure', findings: [finding('two'), finding('one')] });
    expect(projectNotificationState(one, { enabled: true }).fingerprint)
      .toBe(projectNotificationState(two, { enabled: true }).fingerprint);
  });

  it('does not treat excepted findings as finding alerts', () => {
    const state = buildFinalSecurityState({
      conclusion: 'success',
      findings: [finding('one')],
      exceptionApproval: { approved: true, approver: 'alice', findingIds: ['one'] },
    });
    expect(projectNotificationState(state, { enabled: true }).events).toEqual(['exception-approval']);
  });

  it('does not notify for coverage issues by default', () => {
    const state = buildFinalSecurityState({
      conclusion: 'failure',
      findings: [],
      coverageIssues: [
        { level: 'blocking', source: 'spectre', reason: 'high-risk-file-cap-exceeded', count: 1 },
        { level: 'incomplete', source: 'semgrep', reason: 'tool-unavailable', count: 1 },
      ],
    });
    expect(projectNotificationState(state, { enabled: true }).events).toEqual([]);
  });

  it('classifies blocking and incomplete coverage when explicitly enabled', () => {
    const state = buildFinalSecurityState({
      conclusion: 'failure',
      findings: [],
      coverageIssues: [
        { level: 'blocking', source: 'spectre', reason: 'high-risk-file-cap-exceeded', count: 1 },
        { level: 'incomplete', source: 'semgrep', reason: 'tool-unavailable', count: 1 },
      ],
    });
    expect(projectNotificationState(state, {
      enabled: true,
      notifyOn: ['coverage-failure', 'incomplete-scan'],
    }).events)
      .toEqual(['coverage-failure', 'incomplete-scan']);
  });

  it('does not change a finding fingerprint for disabled coverage events', () => {
    const config: NotifierConfig = { enabled: true, notifyOn: ['findings'] };
    const base = buildFinalSecurityState({ conclusion: 'failure', findings: [finding('one')] });
    const withCoverage = buildFinalSecurityState({
      conclusion: 'failure',
      findings: [finding('one')],
      coverageIssues: [{ level: 'incomplete', source: 'semgrep', reason: 'tool-unavailable', count: 1 }],
    });
    expect(projectNotificationState(base, config).fingerprint)
      .toBe(projectNotificationState(withCoverage, config).fingerprint);
  });

  it('is insensitive to coverage issue and file order', () => {
    const issues = [
      { level: 'incomplete' as const, source: 'semgrep' as const, reason: 'partial-results', count: 2, files: ['b.js', 'a.js'] },
      { level: 'incomplete' as const, source: 'semgrep' as const, reason: 'partial-results', count: 2, files: ['d.js', 'c.js'] },
    ];
    const one = buildFinalSecurityState({ conclusion: 'neutral', findings: [], coverageIssues: issues });
    const two = buildFinalSecurityState({
      conclusion: 'neutral',
      findings: [],
      coverageIssues: [...issues].reverse().map(issue => ({ ...issue, files: [...issue.files].reverse() })),
    });

    const config: NotifierConfig = { enabled: true, notifyOn: ['incomplete-scan'] };
    expect(projectNotificationState(one, config).fingerprint)
      .toBe(projectNotificationState(two, config).fingerprint);
  });
});
