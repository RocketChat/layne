import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessedFinding } from '../../types.js';

const redisData = vi.hoisted(() => new Map<string, string>());
const redis = vi.hoisted(() => ({
  get: vi.fn(async (key: string) => redisData.get(key) ?? null),
  set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    if (args.includes('NX') && redisData.has(key)) return null;
    redisData.set(key, value);
    return 'OK';
  }),
  eval: vi.fn(async (script: string, _keys: number, key: string, ...args: Array<string | number>) => {
    if (script.includes('cjson.decode')) {
      const nextSequence = Number(args[2]);
      const current = redisData.get(key);
      if (current && Number((JSON.parse(current) as { scanSequence: number }).scanSequence) > nextSequence) return 0;
      redisData.set(key, String(args[0]));
      return 1;
    }
    if (redisData.get(key) === args[0]) redisData.delete(key);
    return 1;
  }),
}));

vi.mock('../../queue.js', () => ({ redis }));
vi.mock('../../notifiers/rocketchat.js', () => ({
  notify: vi.fn().mockResolvedValue({ delivered: true }),
}));
vi.mock('../../notifiers/slack.js', () => ({
  notify: vi.fn().mockResolvedValue({ delivered: true }),
}));

const { notify: notifyRocketchat } = await import('../../notifiers/rocketchat.js');
const { notify: notifySlack } = await import('../../notifiers/slack.js');
const { notify } = await import('../../notifiers/index.js');

const FINDING: ProcessedFinding = {
  file: 'src/app.js', line: 10, severity: 'high', message: 'SQL injection',
  ruleId: 'semgrep/sql', tool: 'semgrep', _findingId: 'LAYNE-1',
};
const BASE = {
  state: { conclusion: 'failure' as const, findings: [FINDING], coverageIssues: [], exceptionApproval: null },
  owner: 'acme', repo: 'frontend', prNumber: 42, scanSequence: 1,
};

describe('notify() orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisData.clear();
    (notifyRocketchat as ReturnType<typeof vi.fn>).mockResolvedValue({ delivered: true });
    (notifySlack as ReturnType<typeof vi.fn>).mockResolvedValue({ delivered: true });
  });

  it('does nothing when notificationConfig is empty', async () => {
    expect(await notify({ ...BASE, notificationConfig: {} })).toEqual([]);
  });

  it('delivers independently to every enabled notifier', async () => {
    const outcomes = await notify({ ...BASE, notificationConfig: {
      rocketchat: { enabled: true, webhookUrl: 'https://rc.example.com' },
      slack: { enabled: true, webhookUrl: 'https://slack.example.com' },
    } });

    expect(notifyRocketchat).toHaveBeenCalledOnce();
    expect(notifySlack).toHaveBeenCalledOnce();
    expect(outcomes.map(outcome => outcome.status)).toEqual(['delivered', 'delivered']);
  });

  it('deduplicates an unchanged state for each notifier', async () => {
    const notificationConfig = { rocketchat: { enabled: true, webhookUrl: 'https://rc.example.com' } };
    await notify({ ...BASE, notificationConfig });
    const outcomes = await notify({ ...BASE, scanSequence: 2, notificationConfig });

    expect(notifyRocketchat).toHaveBeenCalledOnce();
    expect(outcomes[0]?.status).toBe('deduplicated');
  });

  it('records a quiet state without delivering a recovery message', async () => {
    const state = { conclusion: 'success' as const, findings: [], coverageIssues: [], exceptionApproval: null };
    const outcomes = await notify({ ...BASE, state, notificationConfig: {
      rocketchat: { enabled: true, webhookUrl: 'https://rc.example.com' },
    } });

    expect(notifyRocketchat).not.toHaveBeenCalled();
    expect(outcomes[0]?.status).toBe('filtered');
  });

  it('filters coverage-only states unless the notifier opts in', async () => {
    const state = {
      conclusion: 'neutral' as const,
      findings: [],
      coverageIssues: [{ level: 'incomplete' as const, source: 'semgrep' as const, reason: 'scanner-errors-reported', count: 1 }],
      exceptionApproval: null,
    };
    const defaultConfig = { rocketchat: { enabled: true, webhookUrl: 'https://rc.example.com' } };

    expect((await notify({ ...BASE, state, notificationConfig: defaultConfig }))[0]?.status).toBe('filtered');
    expect(notifyRocketchat).not.toHaveBeenCalled();

    const optInConfig = {
      rocketchat: {
        enabled: true,
        webhookUrl: 'https://rc.example.com',
        notifyOn: ['incomplete-scan' as const],
      },
    };
    expect((await notify({ ...BASE, state, scanSequence: 2, notificationConfig: optInConfig }))[0]?.status).toBe('delivered');
    expect(notifyRocketchat).toHaveBeenCalledOnce();
  });

  it('does not deliver a filtered state when Redis locking fails', async () => {
    redis.set.mockRejectedValueOnce(new Error('Redis unavailable'));
    const outcomes = await notify({
      ...BASE,
      state: { conclusion: 'success', findings: [], coverageIssues: [], exceptionApproval: null },
      notificationConfig: { rocketchat: { enabled: true, webhookUrl: 'https://rc.example.com' } },
    });
    expect(outcomes[0]?.status).toBe('filtered');
    expect(notifyRocketchat).not.toHaveBeenCalled();
  });

  it('does not acknowledge a failed delivery and retries it on the next scan', async () => {
    (notifyRocketchat as ReturnType<typeof vi.fn>).mockResolvedValue({ delivered: false, retryable: false, reason: 'http-400' });
    const notificationConfig = { rocketchat: { enabled: true, webhookUrl: 'https://rc.example.com' } };

    expect((await notify({ ...BASE, notificationConfig }))[0]?.status).toBe('failed');
    (notifyRocketchat as ReturnType<typeof vi.fn>).mockResolvedValue({ delivered: true });
    expect((await notify({ ...BASE, scanSequence: 2, notificationConfig }))[0]?.status).toBe('delivered');
    expect(notifyRocketchat).toHaveBeenCalledTimes(2);
  });

  it('retries transient failures immediately before acknowledging delivery', async () => {
    vi.useFakeTimers();
    (notifyRocketchat as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ delivered: false, retryable: true, reason: 'http-503' })
      .mockResolvedValueOnce({ delivered: false, retryable: true, reason: 'network-error' })
      .mockResolvedValueOnce({ delivered: true });

    const resultPromise = notify({ ...BASE, notificationConfig: {
      rocketchat: { enabled: true, webhookUrl: 'https://rc.example.com' },
    } });
    await vi.advanceTimersByTimeAsync(1_500);
    const outcomes = await resultPromise;

    expect(outcomes[0]).toEqual(expect.objectContaining({ status: 'delivered', attempts: 3 }));
    expect(notifyRocketchat).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('does not let one failed notifier suppress another notifier cursor', async () => {
    (notifyRocketchat as ReturnType<typeof vi.fn>).mockResolvedValue({ delivered: false, retryable: false });
    const notificationConfig = {
      rocketchat: { enabled: true, webhookUrl: 'https://rc.example.com' },
      slack: { enabled: true, webhookUrl: 'https://slack.example.com' },
    };
    await notify({ ...BASE, notificationConfig });
    await notify({ ...BASE, scanSequence: 2, notificationConfig });

    expect(notifyRocketchat).toHaveBeenCalledTimes(2);
    expect(notifySlack).toHaveBeenCalledOnce();
  });

  it('waits for a concurrent delivery and then processes the newer state', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    (notifyRocketchat as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = () => resolve({ delivered: true }); }))
      .mockResolvedValue({ delivered: true });
    const notificationConfig = { rocketchat: { enabled: true, webhookUrl: 'https://rc.example.com' } };

    const first = notify({ ...BASE, notificationConfig });
    await vi.waitFor(() => expect(notifyRocketchat).toHaveBeenCalledOnce());
    const newerState = { ...BASE.state, findings: [{ ...FINDING, _findingId: 'LAYNE-2', file: 'new.js' }] };
    const second = notify({ ...BASE, state: newerState, scanSequence: 2, notificationConfig });
    await vi.advanceTimersByTimeAsync(100);
    releaseFirst();
    await first;
    await vi.advanceTimersByTimeAsync(100);
    await second;

    expect(notifyRocketchat).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
