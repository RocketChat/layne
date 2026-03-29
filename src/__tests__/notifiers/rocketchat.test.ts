import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessedFinding } from '../../types.js';

const { notify } = await import('../../notifiers/rocketchat.js');

const FINDING_HIGH: ProcessedFinding = {
  file: 'src/app.js', line: 10, severity: 'high',
  message: 'SQL injection', ruleId: 'semgrep/sql-injection', tool: 'semgrep',
};
const FINDING_MEDIUM: ProcessedFinding = {
  file: 'src/utils.js', line: 5, severity: 'medium',
  message: 'XSS', ruleId: 'semgrep/xss', tool: 'semgrep',
};

const BASE = { owner: 'acme', repo: 'frontend', prNumber: 42 };

describe('rocketchat notify()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    vi.unstubAllEnvs();
  });

  // --- disabled / misconfigured ---

  it('does not call fetch when webhookUrl is absent', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call fetch when webhookUrl is an unset env var', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: '$MY_MISSING_VAR' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs a warning when the env var is not set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: '$MY_MISSING_VAR' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('$MY_MISSING_VAR'));
    warn.mockRestore();
  });

  // --- URL resolution ---

  it('resolves an env var URL when the env var is set', async () => {
    vi.stubEnv('MY_HOOK', 'https://chat.example.com/hook/abc');
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: '$MY_HOOK' } });
    expect(fetchMock).toHaveBeenCalledWith('https://chat.example.com/hook/abc', expect.any(Object));
  });

  it('uses a literal URL directly (no $ prefix)', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://chat.example.com/hook/literal' } });
    expect(fetchMock).toHaveBeenCalledWith('https://chat.example.com/hook/literal', expect.any(Object));
  });

  // --- HTTP request shape ---

  it('sends a POST request', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'POST' }));
  });

  it('sends Content-Type: application/json', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const [, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('sends a JSON body with alias "Security Notifications"', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const [, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(opts.body) as { alias: string; text: string };
    expect(body.alias).toBe('Layne');
    expect(body).toHaveProperty('text');
  });

  // --- default template ---

  it('default message contains the finding count and PR URL', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(body.text).toBe('🦴 Good boy Layne dug up 1 finding(s) in https://github.com/acme/frontend/pull/42');
  });

  it('default message reflects the correct total count', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH, FINDING_MEDIUM], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(body.text).toContain('2 finding(s)');
  });

  // --- custom template ---

  it('substitutes {{prUrl}} in a custom template', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com', template: '{{prUrl}}' } });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(body.text).toBe('https://github.com/acme/frontend/pull/42');
  });

  it('substitutes {{repo}} in a custom template', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com', template: 'Alert: {{repo}}' } });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(body.text).toBe('Alert: acme/frontend');
  });

  it('substitutes {{prNumber}} in a custom template', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com', template: 'PR #{{prNumber}}' } });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(body.text).toBe('PR #42');
  });

  it('substitutes {{total}}, {{high}}, {{medium}}, {{low}}, {{critical}} in a custom template', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH, FINDING_MEDIUM], toolConfig: {
      enabled: true, webhookUrl: 'https://hook.example.com',
      template: 'total={{total}} crit={{critical}} high={{high}} med={{medium}} low={{low}}',
    } });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(body.text).toBe('total=2 crit=0 high=1 med=1 low=0');
  });

  it('substitutes {{owner}} and {{repoName}} in a custom template', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com', template: '{{owner}}/{{repoName}}' } });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(body.text).toBe('acme/frontend');
  });

  it('leaves unrecognised placeholders as-is in a custom template', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com', template: '{{repo}} {{unknownVar}}' } });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(body.text).toBe('acme/frontend {{unknownVar}}');
  });

  // --- avatar_url ---

  it('includes icon_url when DOMAIN is set', async () => {
    vi.stubEnv('DOMAIN', 'layne.example.com');
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { icon_url?: string };
    expect(body.icon_url).toBe('https://layne.example.com/assets/layne-logo.png');
  });

  it('omits icon_url when DOMAIN is not set', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('icon_url');
  });

  // --- error handling ---

  it('does not throw when fetch throws a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } }))
      .resolves.toBeUndefined();
  });

  it('does not throw when fetch returns a non-2xx status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } }))
      .resolves.toBeUndefined();
  });

  it('logs an error message when fetch returns a non-2xx status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[rocketchat]'));
    error.mockRestore();
  });

  it('logs an error message when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[rocketchat]'));
    error.mockRestore();
  });
});
