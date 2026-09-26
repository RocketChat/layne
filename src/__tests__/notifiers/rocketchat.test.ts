import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectNotificationState } from '../../notification-state.js';
import type { NotifierConfig, ProcessedFinding } from '../../types.js';
import type { FinalSecurityState } from '../../notifiers/types.js';

const { notify } = await import('../../notifiers/rocketchat.js');

const FINDING: ProcessedFinding = {
  file: 'src/app.js', line: 10, severity: 'high', message: 'SQL injection',
  ruleId: 'semgrep/sql-injection', tool: 'semgrep', _findingId: 'LAYNE-1',
};
const BASE = { owner: 'acme', repo: 'frontend', prNumber: 42 };

function params(state: FinalSecurityState, toolConfig: NotifierConfig) {
  return { ...BASE, state, projection: projectNotificationState(state, toolConfig), toolConfig };
}

describe('rocketchat notify()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    vi.unstubAllEnvs();
  });

  it('reports unavailable webhook configuration', async () => {
    const state = { conclusion: 'failure' as const, findings: [FINDING], coverageIssues: [], exceptionApproval: null };
    await expect(notify(params(state, { enabled: true }))).resolves.toEqual(expect.objectContaining({ delivered: false }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a blocking-finding message and returns success', async () => {
    const state = { conclusion: 'failure' as const, findings: [FINDING], coverageIssues: [], exceptionApproval: null };
    const result = await notify(params(state, { enabled: true, webhookUrl: 'https://hook.example.com' }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { alias: string; text: string };

    expect(result).toEqual({ delivered: true });
    expect(body.alias).toBe('Layne');
    expect(body.text).toBe('🦴 Good boy Layne dug up 1 finding(s) in https://github.com/acme/frontend/pull/42');
  });

  it('renders every applicable default event as a standalone line', async () => {
    const state: FinalSecurityState = {
      conclusion: 'failure',
      findings: [FINDING],
      coverageIssues: [
        { level: 'blocking', source: 'spectre', reason: 'omitted-high-risk-file', count: 2 },
        { level: 'incomplete', source: 'semgrep', reason: 'partial-results', count: 1 },
      ],
      exceptionApproval: { approved: true, approver: 'alice', findingIds: ['LAYNE-2'] },
      internalError: { errorId: 'err-123' },
    };
    await notify(params(state, {
      enabled: true,
      webhookUrl: 'https://hook.example.com',
      notifyOn: ['findings', 'coverage-failure', 'incomplete-scan', 'internal-error', 'exception-approval'],
    }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };

    expect(body.text).toBe([
      '🚨 Layne encountered internal error err-123 while scanning https://github.com/acme/frontend/pull/42',
      'ℹ️ Exception approved by @alice for https://github.com/acme/frontend/pull/42',
      '❗ Required scan coverage failed for https://github.com/acme/frontend/pull/42: spectre: omitted-high-risk-file (2)',
      '🦴 Good boy Layne dug up 1 finding(s) in https://github.com/acme/frontend/pull/42',
      '❗ Scan coverage was incomplete for https://github.com/acme/frontend/pull/42: semgrep: partial-results (1)',
    ].join('\n'));
  });

  it('uses the event-specific custom template', async () => {
    const state = { conclusion: 'neutral' as const, findings: [], coverageIssues: [{ level: 'incomplete' as const, source: 'semgrep' as const, reason: 'tool-unavailable', count: 1 }], exceptionApproval: null };
    const config: NotifierConfig = {
      enabled: true,
      webhookUrl: 'https://hook.example.com',
      notifyOn: ['incomplete-scan'],
      templates: { 'incomplete-scan': '{{event}} {{conclusion}}' },
    };
    await notify(params(state, config));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(body.text).toBe('incomplete-scan neutral');
  });

  it('classifies transient HTTP failures as retryable', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const state = { conclusion: 'failure' as const, findings: [FINDING], coverageIssues: [], exceptionApproval: null };
    await expect(notify(params(state, { enabled: true, webhookUrl: 'https://hook.example.com' })))
      .resolves.toEqual({ delivered: false, retryable: true, reason: 'http-503' });
  });

  it('classifies ordinary client failures as non-retryable', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
    const state = { conclusion: 'failure' as const, findings: [FINDING], coverageIssues: [], exceptionApproval: null };
    await expect(notify(params(state, { enabled: true, webhookUrl: 'https://hook.example.com' })))
      .resolves.toEqual({ delivered: false, retryable: false, reason: 'http-400' });
  });
});
