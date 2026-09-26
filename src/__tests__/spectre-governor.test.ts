import { describe, expect, it } from 'vitest';
import { createSpectreGovernor, createSpectreGovernorRegistry, SpectreGovernorError, spectreGovernorOptionsFromEnv } from '../spectre-governor.js';

const options = (overrides: Partial<Parameters<typeof createSpectreGovernor>[0]> = {}) => ({
  concurrency: 1,
  requestsPerMinute: 60,
  burst: 2,
  queueTimeoutMs: 20,
  failureThreshold: 3,
  failureWindowMs: 60_000,
  cooldownMs: 1_000,
  ...overrides,
});

describe('Spectre governor', () => {
  it('enforces the global concurrency limit and releases permits', async () => {
    const governor = createSpectreGovernor(options());
    const first = await governor.acquire();
    const second = governor.acquire();

    expect(governor.getState().inFlight).toBe(1);
    first.succeed();
    first.release();
    const secondLease = await second;
    expect(governor.getState().inFlight).toBe(1);
    secondLease.succeed();
    secondLease.release();
    expect(governor.getState().inFlight).toBe(0);
  });

  it('remains compatible when lifecycle methods are awaited', async () => {
    const governor = createSpectreGovernor(options());
    const lease = await governor.acquire();

    await lease.succeed();
    await lease.release();

    expect(governor.getState().inFlight).toBe(0);
  });

  it('refuses requests after the burst is exhausted without leaking a permit', async () => {
    const governor = createSpectreGovernor(options({ burst: 1, requestsPerMinute: 1 }));
    const lease = await governor.acquire();
    lease.succeed();
    lease.release();

    await expect(governor.acquire()).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(governor.getState().inFlight).toBe(0);
  });

  it('honours cancellation while waiting for concurrency', async () => {
    const governor = createSpectreGovernor(options());
    const lease = await governor.acquire();
    const controller = new AbortController();
    const queued = governor.acquire(controller.signal);
    controller.abort();

    await expect(queued).rejects.toMatchObject({ reason: 'cancelled' });
    lease.release();
    expect(governor.getState().inFlight).toBe(0);
  });

  it('opens after transient failures, then closes after a successful half-open probe', async () => {
    let time = 0;
    const governor = createSpectreGovernor(options({
      failureThreshold: 2,
      cooldownMs: 100,
      burst: 4,
      now: () => time,
    }));
    for (let i = 0; i < 2; i++) {
      const lease = await governor.acquire();
      lease.fail();
      lease.release();
    }

    expect(governor.getState().state).toBe('open');
    await expect(governor.acquire()).rejects.toBeInstanceOf(SpectreGovernorError);

    time = 101;
    const probe = await governor.acquire();
    expect(governor.getState().state).toBe('half_open');
    probe.succeed();
    probe.release();
    expect(governor.getState().state).toBe('closed');
  });

  it('reopens when the half-open probe fails', async () => {
    let time = 0;
    const governor = createSpectreGovernor(options({ failureThreshold: 1, cooldownMs: 100, burst: 3, now: () => time }));
    const failing = await governor.acquire();
    failing.fail();
    failing.release();

    time = 101;
    const probe = await governor.acquire();
    probe.fail();
    probe.release();
    expect(governor.getState().state).toBe('open');
  });

  it('does not leave a half-open circuit busy when a probe is abandoned', async () => {
    let time = 0;
    const governor = createSpectreGovernor(options({ failureThreshold: 1, cooldownMs: 100, burst: 3, now: () => time }));
    const failing = await governor.acquire();
    failing.fail();
    failing.release();

    time = 101;
    const abandoned = await governor.acquire();
    abandoned.release();
    const replacement = await governor.acquire();
    replacement.succeed();
    replacement.release();

    expect(governor.getState().state).toBe('closed');
  });

  it('uses safe defaults for invalid environment values', () => {
    const config = spectreGovernorOptionsFromEnv({
      SPECTRE_GLOBAL_CONCURRENCY: '0',
      SPECTRE_REQUESTS_PER_MINUTE: 'nope',
      SPECTRE_REQUEST_BURST: '99999',
    } as NodeJS.ProcessEnv);
    expect(config.concurrency).toBe(4);
    expect(config.requestsPerMinute).toBe(35);
    expect(config.burst).toBe(35);
  });

  it('does not default burst above a configured requests-per-minute limit', () => {
    const config = spectreGovernorOptionsFromEnv({
      SPECTRE_REQUESTS_PER_MINUTE: '1',
    } as NodeJS.ProcessEnv);
    expect(config.burst).toBe(1);
  });

  it('isolates circuit state between providers', async () => {
    const getGovernor = createSpectreGovernorRegistry(options({ failureThreshold: 1 }));
    const anthropic = getGovernor('anthropic');
    const openai = getGovernor('openai');
    const lease = await anthropic.acquire();
    lease.fail();
    lease.release();

    expect(anthropic.getState().state).toBe('open');
    expect(openai.getState().state).toBe('closed');
    expect(getGovernor('anthropic')).toBe(anthropic);
  });
});
