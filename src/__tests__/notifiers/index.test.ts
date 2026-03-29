import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessedFinding } from '../../types.js';

vi.mock('../../notifiers/rocketchat.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../notifiers/slack.js', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

const { notify: notifyRocketchat } = await import('../../notifiers/rocketchat.js');
const { notify: notifySlack }      = await import('../../notifiers/slack.js');
const { notify }                   = await import('../../notifiers/index.js');

const FINDING: ProcessedFinding = {
  file: 'src/app.js', line: 10, severity: 'high',
  message: 'SQL injection', ruleId: 'semgrep/sql', tool: 'semgrep',
};

const BASE = { findings: [FINDING], owner: 'acme', repo: 'frontend', prNumber: 42 };

describe('notify() orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not call any notifier when notificationConfig is empty', async () => {
    await notify({ ...BASE, notificationConfig: {} });
    expect(notifyRocketchat).not.toHaveBeenCalled();
  });

  it('does not call rocketchat when rocketchat.enabled is false', async () => {
    await notify({ ...BASE, notificationConfig: { rocketchat: { enabled: false, webhookUrl: 'https://hook.example.com' } } });
    expect(notifyRocketchat).not.toHaveBeenCalled();
  });

  it('does not call rocketchat when rocketchat block is missing', async () => {
    await notify({ ...BASE, notificationConfig: { slack: { enabled: true } } });
    expect(notifyRocketchat).not.toHaveBeenCalled();
  });

  it('calls rocketchat notifier when enabled', async () => {
    await notify({ ...BASE, notificationConfig: { rocketchat: { enabled: true, webhookUrl: 'https://hook.example.com' } } });
    expect(notifyRocketchat).toHaveBeenCalledOnce();
  });

  it('passes findings, owner, repo, prNumber to the rocketchat notifier', async () => {
    const config = { enabled: true, webhookUrl: 'https://hook.example.com' };
    await notify({ ...BASE, notificationConfig: { rocketchat: config } });
    expect(notifyRocketchat).toHaveBeenCalledWith({
      findings:   [FINDING],
      owner:      'acme',
      repo:       'frontend',
      prNumber:   42,
      toolConfig: config,
    });
  });

  it('passes the rocketchat sub-block as toolConfig (not the entire notificationConfig)', async () => {
    const rcConfig = { enabled: true, webhookUrl: 'https://hook.example.com', template: 'custom' };
    await notify({ ...BASE, notificationConfig: { rocketchat: rcConfig } });
    expect(notifyRocketchat).toHaveBeenCalledWith(expect.objectContaining({ toolConfig: rcConfig }));
  });

  it('does not throw when an unknown notifier key is present in notificationConfig', async () => {
    await expect(notify({ ...BASE, notificationConfig: { teams: { enabled: true } } }))
      .resolves.toBeUndefined();
  });

  // --- slack ---

  it('does not call slack when slack.enabled is false', async () => {
    await notify({ ...BASE, notificationConfig: { slack: { enabled: false, webhookUrl: 'https://hook.example.com' } } });
    expect(notifySlack).not.toHaveBeenCalled();
  });

  it('does not call slack when slack block is missing', async () => {
    await notify({ ...BASE, notificationConfig: { rocketchat: { enabled: true } } });
    expect(notifySlack).not.toHaveBeenCalled();
  });

  it('calls slack notifier when enabled', async () => {
    await notify({ ...BASE, notificationConfig: { slack: { enabled: true, webhookUrl: 'https://hook.example.com' } } });
    expect(notifySlack).toHaveBeenCalledOnce();
  });

  it('passes findings, owner, repo, prNumber to the slack notifier', async () => {
    const config = { enabled: true, webhookUrl: 'https://hook.example.com' };
    await notify({ ...BASE, notificationConfig: { slack: config } });
    expect(notifySlack).toHaveBeenCalledWith({
      findings:   [FINDING],
      owner:      'acme',
      repo:       'frontend',
      prNumber:   42,
      toolConfig: config,
    });
  });

  it('passes the slack sub-block as toolConfig (not the entire notificationConfig)', async () => {
    const slackConfig = { enabled: true, webhookUrl: 'https://hook.example.com', template: 'custom' };
    await notify({ ...BASE, notificationConfig: { slack: slackConfig } });
    expect(notifySlack).toHaveBeenCalledWith(expect.objectContaining({ toolConfig: slackConfig }));
  });

  it('can call both rocketchat and slack notifiers in the same scan', async () => {
    await notify({ ...BASE, notificationConfig: {
      rocketchat: { enabled: true, webhookUrl: 'https://rc.example.com' },
      slack:      { enabled: true, webhookUrl: 'https://hook.example.com' },
    } });
    expect(notifyRocketchat).toHaveBeenCalledOnce();
    expect(notifySlack).toHaveBeenCalledOnce();
  });
});
