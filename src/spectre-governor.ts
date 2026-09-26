/**
 * Single-process governor for Spectre provider calls.
 *
 * Deliberately isolated so a future multi-instance deployment can replace this
 * with a Redis-backed implementation without changing the adapter.
 */

export type SpectreGovernorRefusal = 'rate_limited' | 'concurrency_timeout' | 'circuit_open' | 'cancelled';
type CircuitState = 'closed' | 'open' | 'half_open';

export class SpectreGovernorError extends Error {
  constructor(public readonly reason: SpectreGovernorRefusal) {
    super(`Spectre governor denied request: ${reason}`);
    this.name = 'SpectreGovernorError';
  }
}

export interface SpectreGovernorOptions {
  concurrency: number;
  requestsPerMinute: number;
  burst: number;
  queueTimeoutMs: number;
  failureThreshold: number;
  failureWindowMs: number;
  cooldownMs: number;
  now?: () => number;
}

export interface SpectreLease {
  succeed(): void | Promise<void>;
  fail(): void | Promise<void>;
  release(): void | Promise<void>;
}

export interface SpectreGovernor {
  acquire(signal?: AbortSignal): Promise<SpectreLease>;
  getState(): { state: CircuitState; inFlight: number };
}

function positiveInt(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

export function spectreGovernorOptionsFromEnv(env = process.env): SpectreGovernorOptions {
  const requestsPerMinute = positiveInt(env.SPECTRE_REQUESTS_PER_MINUTE, 35, 10_000);
  return {
    concurrency:      positiveInt(env.SPECTRE_GLOBAL_CONCURRENCY, 4, 100),
    requestsPerMinute,
    burst:            positiveInt(env.SPECTRE_REQUEST_BURST, Math.min(35, requestsPerMinute), requestsPerMinute),
    queueTimeoutMs:   positiveInt(env.SPECTRE_QUEUE_TIMEOUT_MS, 2_000, 60_000),
    failureThreshold: positiveInt(env.SPECTRE_CIRCUIT_FAILURES, 3, 100),
    failureWindowMs:  positiveInt(env.SPECTRE_CIRCUIT_WINDOW_SECONDS, 60, 3_600) * 1_000,
    cooldownMs:       positiveInt(env.SPECTRE_CIRCUIT_COOLDOWN_SECONDS, 60, 3_600) * 1_000,
  };
}

export function createSpectreGovernor(options: SpectreGovernorOptions): SpectreGovernor {
  const now = options.now ?? Date.now;
  let available = options.concurrency;
  let inFlight = 0;
  let tokens = options.burst;
  let lastRefill = now();
  let state: CircuitState = 'closed';
  let openedAt = 0;
  let halfOpenBusy = false;
  let failures: number[] = [];
  const waiters: Array<() => void> = [];

  const refill = () => {
    const current = now();
    tokens = Math.min(options.burst, tokens + ((current - lastRefill) * options.requestsPerMinute) / 60_000);
    lastRefill = current;
  };

  const releasePermit = () => {
    inFlight--;
    available++;
    waiters.shift()?.();
  };

  const acquirePermit = async (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw new SpectreGovernorError('cancelled');
    if (available > 0) {
      available--;
      inFlight++;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new SpectreGovernorError('concurrency_timeout')), options.queueTimeoutMs);
      const onAbort = () => finish(new SpectreGovernorError('cancelled'));
      const waiter = () => finish();
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        if (error) reject(error);
        else {
          available--;
          inFlight++;
          resolve();
        }
      };
      waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const allowRequest = (): void => {
    const current = now();
    if (state === 'open') {
      if (current - openedAt < options.cooldownMs) throw new SpectreGovernorError('circuit_open');
      state = 'half_open';
    }
    if (state === 'half_open') {
      if (halfOpenBusy) throw new SpectreGovernorError('circuit_open');
      halfOpenBusy = true;
    }
    refill();
    if (tokens < 1) {
      if (state === 'half_open') halfOpenBusy = false;
      throw new SpectreGovernorError('rate_limited');
    }
    tokens--;
  };

  const recordFailure = () => {
    const current = now();
    failures = failures.filter(time => current - time <= options.failureWindowMs);
    failures.push(current);
    if (state === 'half_open' || failures.length >= options.failureThreshold) {
      state = 'open';
      openedAt = current;
    }
    halfOpenBusy = false;
  };

  return {
    async acquire(signal?: AbortSignal): Promise<SpectreLease> {
      await acquirePermit(signal);
      try {
        allowRequest();
      } catch (error) {
        releasePermit();
        throw error;
      }
      let released = false;
      let completed = false;
      const release = () => {
        if (released) return;
        released = true;
        if (!completed && state === 'half_open') halfOpenBusy = false;
        releasePermit();
      };
      return {
        succeed() {
          if (completed) return;
          completed = true;
          if (state === 'half_open') {
            state = 'closed';
            failures = [];
            halfOpenBusy = false;
          }
        },
        fail() {
          if (completed) return;
          completed = true;
          recordFailure();
        },
        release,
      };
    },
    getState: () => ({ state, inFlight }),
  };
}

export function createSpectreGovernorRegistry(options: SpectreGovernorOptions): (provider: string) => SpectreGovernor {
  const governors = new Map<string, SpectreGovernor>();
  return (provider: string) => {
    let governor = governors.get(provider);
    if (!governor) {
      governor = createSpectreGovernor(options);
      governors.set(provider, governor);
    }
    return governor;
  };
}

export const getSpectreGovernor = createSpectreGovernorRegistry(spectreGovernorOptionsFromEnv());
