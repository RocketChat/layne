import { describe, it, expect, vi, beforeEach } from 'vitest';

const { notify } = await import('../../notifiers/rocketchat.js');

const FINDING_HIGH = {
  file: 'src/app.js', line: 10, severity: 'high',
  message: 'SQL injection', ruleId: 'semgrep/sql-injection', tool: 'semgrep',
};
const FINDING_MEDIUM = {
  file: 'src/utils.js', line: 5, severity: 'medium',
  message: 'XSS', ruleId: 'semgrep/xss', tool: 'semgrep',
};
const FINDING_SECRET = {
  file: '.env', line: 3, severity: 'high',
  message: 'AWS key', ruleId: 'trufflehog/aws-key', tool: 'trufflehog',
};

const BASE = { owner: 'acme', repo: 'frontend', prNumber: 42 };

describe('rocketchat notify()', () => {
  let fetchMock;

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
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('sends a JSON body with alias "Security Notifications"', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.alias).toBe('Security Notifications');
    expect(body).toHaveProperty('text');
  });

  // --- default template ---

  it('default message includes the repo name', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('acme/frontend');
  });

  it('default message includes the PR number', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('42');
  });

  it('default message includes each tool that has findings', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH, FINDING_SECRET], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('semgrep');
    expect(body.text).toContain('trufflehog');
  });

  it('default message omits a tool section when that tool has no findings', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).not.toContain('trufflehog');
  });

  it('default message includes severity counts', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH, FINDING_MEDIUM], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('1 high');
    expect(body.text).toContain('1 medium');
  });

  it('default message omits zero-count severities from the counts line', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // "0 medium" or "0 low" should not appear
    expect(body.text).not.toMatch(/0 medium/);
    expect(body.text).not.toMatch(/0 low/);
  });

  // --- custom template ---

  it('substitutes {{repo}} in a custom template', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com', template: 'Alert: {{repo}}' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('Alert: acme/frontend');
  });

  it('substitutes {{prNumber}} in a custom template', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com', template: 'PR #{{prNumber}}' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('PR #42');
  });

  it('substitutes {{total}}, {{high}}, {{medium}}, {{low}}, {{critical}} in a custom template', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH, FINDING_MEDIUM], toolConfig: {
      enabled: true, webhookUrl: 'https://hook.example.com',
      template: 'total={{total}} crit={{critical}} high={{high}} med={{medium}} low={{low}}',
    } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('total=2 crit=0 high=1 med=1 low=0');
  });

  it('substitutes {{owner}} and {{repoName}} in a custom template', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com', template: '{{owner}}/{{repoName}}' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('acme/frontend');
  });

  it('leaves unrecognised placeholders as-is in a custom template', async () => {
    await notify({ ...BASE, findings: [FINDING_HIGH], toolConfig: { enabled: true, webhookUrl: 'https://hook.example.com', template: '{{repo}} {{unknownVar}}' } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('acme/frontend {{unknownVar}}');
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
