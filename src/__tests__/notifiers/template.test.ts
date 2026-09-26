import { describe, it, expect } from 'vitest';
import { projectNotificationState } from '../../notification-state.js';
import { buildContext, buildNotificationContext, renderTemplate } from '../../notifiers/template.js';
import type { FinalSecurityState } from '../../notifiers/types.js';
import type { ProcessedFinding, TemplateContext } from '../../types.js';

const FINDING_CRITICAL: ProcessedFinding = { file: 'a.js', line: 1, severity: 'critical', message: 'critical', ruleId: 'r/c', tool: 'semgrep' };
const FINDING_HIGH: ProcessedFinding     = { file: 'b.js', line: 2, severity: 'high',     message: 'high',     ruleId: 'r/h', tool: 'semgrep' };
const FINDING_MEDIUM: ProcessedFinding   = { file: 'c.js', line: 3, severity: 'medium',   message: 'medium',   ruleId: 'r/m', tool: 'semgrep' };
const FINDING_LOW: ProcessedFinding      = { file: 'd.js', line: 4, severity: 'low',       message: 'low',      ruleId: 'r/l', tool: 'semgrep' };

describe('buildContext()', () => {
  it('sets repo to owner/repoName', () => {
    const ctx = buildContext([], 'acme', 'payments', 42);
    expect(ctx.repo).toBe('acme/payments');
  });

  it('sets owner and repoName separately', () => {
    const ctx = buildContext([], 'acme', 'payments', 42);
    expect(ctx.owner).toBe('acme');
    expect(ctx.repoName).toBe('payments');
  });

  it('sets prNumber', () => {
    const ctx = buildContext([], 'acme', 'payments', 42);
    expect(ctx.prNumber).toBe(42);
  });

  it('sets prUrl', () => {
    const ctx = buildContext([], 'acme', 'payments', 42);
    expect(ctx.prUrl).toBe('https://github.com/acme/payments/pull/42');
  });

  it('counts findings by severity', () => {
    const ctx = buildContext([FINDING_CRITICAL, FINDING_HIGH, FINDING_HIGH, FINDING_MEDIUM, FINDING_LOW], 'o', 'r', 1);
    expect(ctx.critical).toBe(1);
    expect(ctx.high).toBe(2);
    expect(ctx.medium).toBe(1);
    expect(ctx.low).toBe(1);
  });

  it('sets total to findings.length', () => {
    const ctx = buildContext([FINDING_HIGH, FINDING_MEDIUM], 'o', 'r', 1);
    expect(ctx.total).toBe(2);
  });

  it('sets total to 0 with no findings', () => {
    const ctx = buildContext([], 'o', 'r', 1);
    expect(ctx.total).toBe(0);
    expect(ctx.critical).toBe(0);
    expect(ctx.high).toBe(0);
    expect(ctx.medium).toBe(0);
    expect(ctx.low).toBe(0);
  });

  it('builds summary with nonzero counts', () => {
    const ctx = buildContext([FINDING_HIGH, FINDING_MEDIUM], 'o', 'r', 1);
    expect(ctx.summary).toBe('Found 2 issue(s): 1 high, 1 medium.');
  });

  it('builds summary with "none" when no findings', () => {
    const ctx = buildContext([], 'o', 'r', 1);
    expect(ctx.summary).toBe('Found 0 issue(s): none.');
  });

  it('sets rules to a deduplicated comma-separated list of ruleIds', () => {
    const ctx = buildContext([FINDING_HIGH, FINDING_MEDIUM, FINDING_HIGH], 'o', 'r', 1);
    expect(ctx.rules).toBe('r/h, r/m');
  });

  it('sets rules to empty string when findings have no ruleId', () => {
    const noRule = { ...FINDING_HIGH, ruleId: '' };
    const ctx = buildContext([noRule], 'o', 'r', 1);
    expect(ctx.rules).toBe('');
  });

  it('sets rules to empty string with no findings', () => {
    const ctx = buildContext([], 'o', 'r', 1);
    expect(ctx.rules).toBe('');
  });

  it('counts info findings', () => {
    const infoFinding = { ...FINDING_HIGH, severity: 'info' as const };
    const ctx = buildContext([infoFinding], 'o', 'r', 1);
    expect(ctx.high).toBe(0);
    expect(ctx.info).toBe(1);
    expect(ctx.severitySummary).toBe('1 info');
  });

  it('builds threshold-aware notification and event-specific coverage values', () => {
    const state: FinalSecurityState = {
      conclusion: 'failure',
      findings: [FINDING_HIGH, FINDING_MEDIUM, FINDING_LOW],
      coverageIssues: [
        { level: 'blocking', source: 'spectre', reason: 'omitted-high-risk-file', count: 2 },
        { level: 'incomplete', source: 'semgrep', reason: 'partial-results', count: 1 },
      ],
      exceptionApproval: null,
    };
    const projection = projectNotificationState(state, {
      enabled: true,
      notifyOn: ['findings', 'coverage-failure', 'incomplete-scan'],
      minFindingSeverity: 'medium',
    });
    const ctx = buildNotificationContext(state, projection, 'acme', 'payments', 42);

    expect(ctx.notificationTotal).toBe(2);
    expect(ctx.blockingCoverageSummary).toBe('spectre: omitted-high-risk-file (2)');
    expect(ctx.incompleteCoverageSummary).toBe('semgrep: partial-results (1)');
    expect(ctx.coverageSummary).toBe('spectre: omitted-high-risk-file (2), semgrep: partial-results (1)');
  });
});

describe('renderTemplate()', () => {
  it('substitutes a known placeholder', () => {
    expect(renderTemplate('hello {{repo}}', { repo: 'acme/payments' } as TemplateContext)).toBe('hello acme/payments');
  });

  it('substitutes multiple placeholders', () => {
    const result = renderTemplate('{{owner}}/{{repoName}} #{{prNumber}}', {
      owner: 'acme', repoName: 'payments', prNumber: 42,
    } as unknown as TemplateContext);
    expect(result).toBe('acme/payments #42');
  });

  it('leaves unknown placeholders unchanged', () => {
    expect(renderTemplate('{{unknown}}', { repo: 'acme/payments' } as TemplateContext)).toBe('{{unknown}}');
  });

  it('substitutes the same placeholder multiple times', () => {
    expect(renderTemplate('{{repo}} and {{repo}}', { repo: 'x' } as TemplateContext)).toBe('x and x');
  });

  it('returns the template unchanged when there are no placeholders', () => {
    expect(renderTemplate('no placeholders here', {} as TemplateContext)).toBe('no placeholders here');
  });
});
