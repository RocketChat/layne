import { beforeEach, describe, expect, it, vi } from 'vitest';

const metricMocks = vi.hoisted(() => ({
  backendErrors: vi.fn(),
  circuitState: vi.fn(),
  leaseRecoveries: vi.fn(),
}));

vi.mock('../metrics.js', () => ({
  spectreCircuitState: { set: metricMocks.circuitState },
  spectreGovernorBackendErrorsTotal: { inc: metricMocks.backendErrors },
  spectreGovernorLeaseRecoveriesTotal: { inc: metricMocks.leaseRecoveries },
}));

import { createRedisSpectreGovernor, type SpectreRedisClient } from '../spectre-redis-governor.js';

interface Circuit {
  state: 'closed' | 'open' | 'half_open';
  openedAt: number;
  probe?: string;
}

class MemoryRedis implements SpectreRedisClient {
  readonly calls: Array<{ script: string; keys: string[]; argv: Array<string | number> }> = [];
  private readonly leases = new Map<string, Map<string, number>>();
  private readonly requests = new Map<string, number[]>();
  private readonly fixedRequests = new Map<string, { window: number; count: number }>();
  private readonly circuits = new Map<string, Circuit>();
  private readonly failures = new Map<string, number[]>();

  expireLeases(): void {
    for (const leases of this.leases.values()) {
      for (const leaseId of leases.keys()) leases.set(leaseId, 0);
    }
  }

  async eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const keys = args.slice(0, numberOfKeys).map(String);
    const argv = args.slice(numberOfKeys);
    this.calls.push({ script, keys, argv });
    const now = Date.now();

    if (script.includes('spectre:acquire-v1')) {
      const [leaseKey, requestKey, circuitKey] = keys as [string, string, string];
      const [leaseId, concurrencyValue, budgetValue, windowValue, mode, ttlValue, cooldownValue] = argv;
      const concurrency = Number(concurrencyValue);
      const budget = Number(budgetValue);
      const windowMs = Number(windowValue);
      const ttlMs = Number(ttlValue);
      const cooldownMs = Number(cooldownValue);
      const leases = this.leases.get(leaseKey) ?? new Map<string, number>();
      let recovered = 0;
      for (const [id, expiresAt] of leases) {
        if (expiresAt <= now) {
          leases.delete(id);
          recovered++;
        }
      }
      this.leases.set(leaseKey, leases);
      const circuit = this.circuits.get(circuitKey) ?? { state: 'closed', openedAt: 0 };
      if (circuit.state === 'half_open' && circuit.probe && !leases.has(circuit.probe)) delete circuit.probe;
      let probing = false;
      if (circuit.state === 'open') {
        if (now - circuit.openedAt < cooldownMs) return ['circuit_open', 'open', recovered, now];
        probing = true;
      } else if (circuit.state === 'half_open') {
        if (circuit.probe) return ['circuit_open', 'half_open', recovered, now];
        probing = true;
      }
      if (leases.size >= concurrency) return ['concurrency', circuit.state, recovered, now];

      let requestCount: number;
      let requests: number[] | undefined;
      if (mode === 'fixed') {
        const window = Math.floor(now / windowMs);
        const current = this.fixedRequests.get(requestKey);
        requestCount = current?.window === window ? current.count : 0;
      } else {
        requests = (this.requests.get(requestKey) ?? []).filter(time => time > now - windowMs);
        this.requests.set(requestKey, requests);
        requestCount = requests.length;
      }
      if (requestCount >= budget) return ['rate_limited', circuit.state, recovered, now];

      leases.set(String(leaseId), now + ttlMs);
      if (mode === 'fixed') {
        this.fixedRequests.set(requestKey, { window: Math.floor(now / windowMs), count: requestCount + 1 });
      } else {
        requests!.push(now);
      }
      if (probing) {
        circuit.state = 'half_open';
        circuit.probe = String(leaseId);
        this.circuits.set(circuitKey, circuit);
      }
      expect(mode === 'fixed' || mode === 'sliding').toBe(true);
      return ['acquired', circuit.state, recovered, now];
    }

    if (script.includes('spectre:renew-v1')) {
      const leases = this.leases.get(keys[0]!);
      const leaseId = String(argv[0]);
      if (!leases?.has(leaseId)) return 0;
      leases.set(leaseId, now + Number(argv[1]));
      return 1;
    }

    if (script.includes('spectre:release-v1')) {
      const leaseId = String(argv[0]);
      const removed = this.leases.get(keys[0]!)?.delete(leaseId) ?? false;
      const circuit = this.circuits.get(keys[1]!);
      if (removed && circuit?.probe === leaseId) delete circuit.probe;
      return removed ? 1 : 0;
    }

    if (script.includes('spectre:succeed-v1')) {
      const leaseId = String(argv[0]);
      if (!this.leases.get(keys[0]!)?.has(leaseId)) return 'ignored';
      const circuit = this.circuits.get(keys[1]!);
      if (circuit?.state === 'half_open' && circuit.probe === leaseId) {
        this.circuits.delete(keys[1]!);
        this.failures.delete(keys[2]!);
        return 'closed';
      }
      return circuit?.state ?? 'closed';
    }

    if (script.includes('spectre:fail-v1')) {
      const leaseId = String(argv[0]);
      if (!this.leases.get(keys[0]!)?.has(leaseId)) return 'ignored';
      const failureWindowMs = Number(argv[1]);
      const threshold = Number(argv[2]);
      const failures = (this.failures.get(keys[2]!) ?? []).filter(time => time > now - failureWindowMs);
      failures.push(now);
      this.failures.set(keys[2]!, failures);
      const circuit = this.circuits.get(keys[1]!) ?? { state: 'closed', openedAt: 0 };
      if ((circuit.state === 'half_open' && circuit.probe === leaseId) || failures.length >= threshold) {
        circuit.state = 'open';
        circuit.openedAt = now;
        delete circuit.probe;
        this.circuits.set(keys[1]!, circuit);
        return 'open';
      }
      return circuit.state;
    }

    throw new Error('Unknown script');
  }
}

const options = (client: SpectreRedisClient, overrides: Partial<Parameters<typeof createRedisSpectreGovernor>[1]> = {}) => ({
  client,
  concurrency: 1,
  requestsPerMinute: 60,
  burst: 10,
  queueTimeoutMs: 40,
  failureThreshold: 2,
  failureWindowMs: 60_000,
  cooldownMs: 1_000,
  leaseTtlMs: 1_000,
  pollIntervalMs: 2,
  ...overrides,
});

describe('Redis Spectre governor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shares provider concurrency across governor instances and releases by lease ID', async () => {
    const redis = new MemoryRedis();
    let nextId = 0;
    const firstGovernor = createRedisSpectreGovernor('anthropic', options(redis, { createLeaseId: () => `lease-${++nextId}` }));
    const secondGovernor = createRedisSpectreGovernor('anthropic', options(redis, { createLeaseId: () => `lease-${++nextId}` }));
    const first = await firstGovernor.acquire();
    const waiting = secondGovernor.acquire();

    await first.release();
    const second = await waiting;
    await second.release();

    const releases = redis.calls.filter(call => call.script.includes('spectre:release-v1'));
    expect(releases.map(call => call.argv[0])).toEqual(['lease-1', 'lease-2']);
  });

  it('recovers expired leases without allowing a stale owner to release a replacement', async () => {
    const redis = new MemoryRedis();
    let nextId = 0;
    const governor = createRedisSpectreGovernor('anthropic', options(redis, {
      createLeaseId: () => `lease-${++nextId}`,
      queueTimeoutMs: 10,
    }));
    const stale = await governor.acquire();
    redis.expireLeases();
    const replacement = await governor.acquire();

    await expect(stale.release()).rejects.toThrow('lease ownership lost during release');
    await expect(governor.acquire()).rejects.toMatchObject({ reason: 'concurrency_timeout' });
    await replacement.release();
    expect(metricMocks.leaseRecoveries).toHaveBeenCalledWith(
      { provider: 'anthropic', backend: 'redis' },
      1,
    );
  });

  it('enforces a deployment-wide sliding request budget', async () => {
    const redis = new MemoryRedis();
    const firstGovernor = createRedisSpectreGovernor('openai', options(redis, { burst: 1 }));
    const secondGovernor = createRedisSpectreGovernor('openai', options(redis, { burst: 1 }));
    const lease = await firstGovernor.acquire();
    await lease.release();

    await expect(secondGovernor.acquire()).rejects.toMatchObject({ reason: 'rate_limited' });
  });

  it('supports fixed request windows in a separate Redis key', async () => {
    const redis = new MemoryRedis();
    const governor = createRedisSpectreGovernor('openai', options(redis, {
      burst: 1,
      requestsPerMinute: 1,
      rateLimitWindow: 'fixed',
    }));
    const lease = await governor.acquire();
    await lease.release();

    await expect(governor.acquire()).rejects.toMatchObject({ reason: 'rate_limited' });
    const acquire = redis.calls.find(call => call.script.includes('spectre:acquire-v1'))!;
    expect(acquire.keys[1]).toMatch(/:requests:fixed$/);
    expect(acquire.argv[4]).toBe('fixed');
  });

  it('bounds concurrency waiting and honours cancellation', async () => {
    const redis = new MemoryRedis();
    const governor = createRedisSpectreGovernor('google', options(redis, { queueTimeoutMs: 15 }));
    const lease = await governor.acquire();

    await expect(governor.acquire()).rejects.toMatchObject({ reason: 'concurrency_timeout' });
    const controller = new AbortController();
    const cancelled = governor.acquire(controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ reason: 'cancelled' });
    await lease.release();
  });

  it('shares circuit state and closes it through one half-open probe', async () => {
    const redis = new MemoryRedis();
    const firstGovernor = createRedisSpectreGovernor('mistral', options(redis, { failureThreshold: 1, cooldownMs: 10 }));
    const secondGovernor = createRedisSpectreGovernor('mistral', options(redis, { failureThreshold: 1, cooldownMs: 10 }));
    const failing = await firstGovernor.acquire();
    await failing.fail();
    await failing.release();

    await expect(secondGovernor.acquire()).rejects.toMatchObject({ reason: 'circuit_open' });
    await new Promise(resolve => setTimeout(resolve, 12));
    const probe = await secondGovernor.acquire();
    expect(secondGovernor.getState().state).toBe('half_open');
    await probe.succeed();
    await probe.release();
    expect(secondGovernor.getState().state).toBe('closed');
    expect(metricMocks.circuitState).toHaveBeenCalledWith(
      { provider: 'mistral', backend: 'redis' },
      0,
    );
  });

  it('never places provider, credential, or model text in Redis keys', async () => {
    const redis = new MemoryRedis();
    const sensitive = 'anthropic:sk-secret:model-name';
    const governor = createRedisSpectreGovernor(sensitive, options(redis));
    const lease = await governor.acquire();
    await lease.release();

    expect(redis.calls.flatMap(call => call.keys).join(' ')).not.toContain(sensitive);
    expect(redis.calls[0]!.keys.every(key => /^layne:\{spectre:[a-f0-9]{32}\}:/.test(key))).toBe(true);
  });

  it('bounds provider labels on Redis backend errors', async () => {
    const client: SpectreRedisClient = { eval: async () => { throw new Error('Redis unavailable'); } };
    const governor = createRedisSpectreGovernor('secret-provider-value', options(client));

    await expect(governor.acquire()).rejects.toThrow('Redis unavailable');
    expect(metricMocks.backendErrors).toHaveBeenCalledWith({
      provider: 'unknown',
      backend: 'redis',
      operation: 'acquire',
    });
  });

  it('bounds an unresponsive Redis acquire command', async () => {
    const client: SpectreRedisClient = { eval: async () => new Promise(() => {}) };
    const governor = createRedisSpectreGovernor('bedrock', options(client, { queueTimeoutMs: 10 }));

    await expect(governor.acquire()).rejects.toThrow('Redis Spectre governor acquire timed out');
    expect(metricMocks.backendErrors).toHaveBeenCalledWith({
      provider: 'unknown',
      backend: 'redis',
      operation: 'acquire',
    });
  });

  it.each(['succeed', 'fail'] as const)('awaits and surfaces %s transition errors', async (outcome) => {
    const redis = new MemoryRedis();
    const client: SpectreRedisClient = {
      eval: async (script, numberOfKeys, ...args) => {
        if (script.includes(`spectre:${outcome}-v1`)) throw new Error(`${outcome} unavailable`);
        return redis.eval(script, numberOfKeys, ...args);
      },
    };
    const lease = await createRedisSpectreGovernor('anthropic', options(client)).acquire();

    await expect(lease[outcome]()).rejects.toThrow(`${outcome} unavailable`);
    await lease.release();
    expect(metricMocks.backendErrors).toHaveBeenCalledWith({
      provider: 'anthropic', backend: 'redis', operation: outcome,
    });
  });

  it('awaits and surfaces release errors', async () => {
    const redis = new MemoryRedis();
    const client: SpectreRedisClient = {
      eval: async (script, numberOfKeys, ...args) => {
        if (script.includes('spectre:release-v1')) throw new Error('release unavailable');
        return redis.eval(script, numberOfKeys, ...args);
      },
    };
    const governor = createRedisSpectreGovernor('openai', options(client));
    const lease = await governor.acquire();

    await expect(lease.release()).rejects.toThrow('release unavailable');
    expect(governor.getState().inFlight).toBe(0);
    expect(metricMocks.backendErrors).toHaveBeenCalledWith({
      provider: 'openai', backend: 'redis', operation: 'release',
    });
  });

  it.each(['error', 'lost'] as const)('surfaces renewal %s to the owning lease without an unhandled rejection', async (failure) => {
    const redis = new MemoryRedis();
    const client: SpectreRedisClient = {
      eval: async (script, numberOfKeys, ...args) => {
        if (script.includes('spectre:renew-v1')) {
          if (failure === 'error') throw new Error('renew unavailable');
          return 0;
        }
        return redis.eval(script, numberOfKeys, ...args);
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const lease = await createRedisSpectreGovernor('google', options(client, { leaseTtlMs: 9 })).acquire();
      await vi.waitFor(() => expect(metricMocks.backendErrors).toHaveBeenCalledWith({
        provider: 'google', backend: 'redis', operation: 'renew',
      }));

      await expect(lease.succeed()).rejects.toThrow(failure === 'error' ? 'renew unavailable' : 'lease ownership lost during renewal');
      await expect(lease.release()).rejects.toThrow(failure === 'error' ? 'renew unavailable' : 'lease ownership lost during renewal');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
