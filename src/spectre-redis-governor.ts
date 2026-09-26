import { createHash, randomUUID } from 'node:crypto';

import {
  SpectreGovernorError,
  type SpectreGovernor,
  type SpectreGovernorOptions,
  type SpectreLease,
} from './spectre-governor.js';
import {
  spectreCircuitState,
  spectreGovernorBackendErrorsTotal,
  spectreGovernorLeaseRecoveriesTotal,
} from './metrics.js';
import { isSpectreProvider, type SpectreProvider } from './spectre-provider.js';

export interface SpectreRedisClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface RedisSpectreGovernorOptions extends SpectreGovernorOptions {
  client: SpectreRedisClient;
  leaseTtlMs?: number;
  pollIntervalMs?: number;
  rateLimitWindow?: 'fixed' | 'sliding';
  createLeaseId?: () => string;
}

const ACQUIRE_SCRIPT = `
-- spectre:acquire-v1
local clock = redis.call('TIME')
local now = (clock[1] * 1000) + math.floor(clock[2] / 1000)
local lease_id = ARGV[1]
local concurrency = tonumber(ARGV[2])
local budget = tonumber(ARGV[3])
local window_ms = tonumber(ARGV[4])
local window_mode = ARGV[5]
local lease_ttl_ms = tonumber(ARGV[6])
local cooldown_ms = tonumber(ARGV[7])

local recovered = redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local state = redis.call('HGET', KEYS[3], 'state') or 'closed'
local probe = redis.call('HGET', KEYS[3], 'probe')
if state == 'half_open' and probe and not redis.call('ZSCORE', KEYS[1], probe) then
  redis.call('HDEL', KEYS[3], 'probe')
  probe = false
end

local probing = false
if state == 'open' then
  local opened_at = tonumber(redis.call('HGET', KEYS[3], 'opened_at') or now)
  if now - opened_at < cooldown_ms then
    return { 'circuit_open', state, recovered, now }
  end
  probing = true
elseif state == 'half_open' then
  if probe then
    return { 'circuit_open', state, recovered, now }
  end
  probing = true
end

if redis.call('ZCARD', KEYS[1]) >= concurrency then
  return { 'concurrency', state, recovered, now }
end

local count = 0
local window_id = math.floor(now / window_ms)
if window_mode == 'sliding' then
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - window_ms)
  count = redis.call('ZCARD', KEYS[2])
else
  local stored_window = tonumber(redis.call('HGET', KEYS[2], 'window') or -1)
  if stored_window == window_id then
    count = tonumber(redis.call('HGET', KEYS[2], 'count') or 0)
  end
end
if count >= budget then
  return { 'rate_limited', state, recovered, now }
end

redis.call('ZADD', KEYS[1], now + lease_ttl_ms, lease_id)
redis.call('PEXPIRE', KEYS[1], lease_ttl_ms * 2)
if window_mode == 'sliding' then
  redis.call('ZADD', KEYS[2], now, lease_id)
  redis.call('PEXPIRE', KEYS[2], window_ms * 2)
else
  redis.call('HSET', KEYS[2], 'window', window_id, 'count', count + 1)
  redis.call('PEXPIRE', KEYS[2], window_ms * 2)
end
if probing then
  state = 'half_open'
  redis.call('HSET', KEYS[3], 'state', state, 'probe', lease_id)
  redis.call('PEXPIRE', KEYS[3], math.max(cooldown_ms * 2, lease_ttl_ms * 2))
end
return { 'acquired', state, recovered, now }
`;

const RENEW_SCRIPT = `
-- spectre:renew-v1
local clock = redis.call('TIME')
local now = (clock[1] * 1000) + math.floor(clock[2] / 1000)
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  return 0
end
redis.call('ZADD', KEYS[1], 'XX', now + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
return 1
`;

const RELEASE_SCRIPT = `
-- spectre:release-v1
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
if removed == 1 and redis.call('HGET', KEYS[2], 'probe') == ARGV[1] then
  redis.call('HDEL', KEYS[2], 'probe')
end
return removed
`;

const SUCCEED_SCRIPT = `
-- spectre:succeed-v1
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  return 'ignored'
end
if redis.call('HGET', KEYS[2], 'state') == 'half_open' and redis.call('HGET', KEYS[2], 'probe') == ARGV[1] then
  redis.call('DEL', KEYS[2])
  redis.call('DEL', KEYS[3])
  return 'closed'
end
return redis.call('HGET', KEYS[2], 'state') or 'closed'
`;

const FAIL_SCRIPT = `
-- spectre:fail-v1
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  return 'ignored'
end
local clock = redis.call('TIME')
local now = (clock[1] * 1000) + math.floor(clock[2] / 1000)
local failure_window_ms = tonumber(ARGV[2])
local failure_threshold = tonumber(ARGV[3])
local cooldown_ms = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - failure_window_ms)
redis.call('ZADD', KEYS[3], now, ARGV[1])
redis.call('PEXPIRE', KEYS[3], failure_window_ms * 2)
local state = redis.call('HGET', KEYS[2], 'state') or 'closed'
local is_probe = state == 'half_open' and redis.call('HGET', KEYS[2], 'probe') == ARGV[1]
if is_probe or (state == 'closed' and redis.call('ZCARD', KEYS[3]) >= failure_threshold) then
  redis.call('HSET', KEYS[2], 'state', 'open', 'opened_at', now)
  redis.call('HDEL', KEYS[2], 'probe')
  redis.call('PEXPIRE', KEYS[2], cooldown_ms * 2)
  return 'open'
end
return state
`;

type RedisDecision = 'acquired' | 'concurrency' | 'rate_limited' | 'circuit_open';
type CircuitState = ReturnType<SpectreGovernor['getState']>['state'];
type ProviderLabel = SpectreProvider | 'unknown';
type BackendOperation = 'acquire' | 'late_acquire_cleanup' | 'cancelled_acquire_release' | 'renew' | 'succeed' | 'fail' | 'release';

class RedisSpectreGovernorBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisSpectreGovernorBackendError';
  }
}

function providerLabel(provider: string): ProviderLabel {
  return isSpectreProvider(provider) ? provider : 'unknown';
}

function providerKeys(provider: string, windowMode: 'fixed' | 'sliding'): [string, string, string, string] {
  const providerId = createHash('sha256').update(provider.trim().toLowerCase()).digest('hex').slice(0, 32);
  const scope = `{spectre:${providerId}}`;
  return [
    `layne:${scope}:leases`,
    `layne:${scope}:requests:${windowMode}`,
    `layne:${scope}:circuit`,
    `layne:${scope}:failures`,
  ];
}

function parseAcquireResult(result: unknown): {
  decision: RedisDecision;
  state: CircuitState;
  recovered: number;
} {
  if (!Array.isArray(result) || result.length < 3) throw new Error('Invalid response from Redis Spectre governor');
  const decision = String(result[0]);
  const state = String(result[1]);
  if (!['acquired', 'concurrency', 'rate_limited', 'circuit_open'].includes(decision)) {
    throw new Error(`Invalid Redis Spectre governor decision: ${decision}`);
  }
  if (!['closed', 'open', 'half_open'].includes(state)) {
    throw new Error(`Invalid Redis Spectre circuit state: ${state}`);
  }
  return {
    decision: decision as RedisDecision,
    state: state as CircuitState,
    recovered: Number(result[2]) || 0,
  };
}

function refusal(reason: 'rate_limited' | 'concurrency_timeout' | 'circuit_open' | 'cancelled'): SpectreGovernorError {
  return new SpectreGovernorError(reason);
}

export function createRedisSpectreGovernor(
  provider: string,
  options: RedisSpectreGovernorOptions,
): SpectreGovernor {
  const leaseTtlMs = Math.max(1, options.leaseTtlMs ?? 10 * 60_000);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50);
  const rateLimitWindow = options.rateLimitWindow ?? 'sliding';
  const keys = providerKeys(provider, rateLimitWindow);
  const rateWindowMs = Math.max(1, Math.ceil((60_000 * options.burst) / options.requestsPerMinute));
  const createLeaseId = options.createLeaseId ?? randomUUID;
  const metricProvider = providerLabel(provider);
  const metricLabels = { provider: metricProvider, backend: 'redis' };
  let state: CircuitState = 'closed';
  let inFlight = 0;

  const publishCircuitState = (): void => {
    const value = state === 'closed' ? 0 : state === 'open' ? 1 : 2;
    (spectreCircuitState as { set(labels: Record<string, string>, value: number): void })
      .set(metricLabels, value);
  };

  const backendError = (operation: BackendOperation, error: unknown): void => {
    spectreGovernorBackendErrorsTotal.inc({ provider: metricProvider, backend: 'redis', operation });
    console.error(`Spectre Redis governor ${operation} failed`, error);
  };

  const releaseRemote = async (leaseId: string): Promise<void> => {
    await options.client.eval(RELEASE_SCRIPT, 2, keys[0], keys[2], leaseId);
  };

  const acquireAttempt = (leaseId: string): Promise<unknown> => options.client.eval(
    ACQUIRE_SCRIPT,
    3,
    keys[0],
    keys[1],
    keys[2],
    leaseId,
    options.concurrency,
    options.burst,
    rateWindowMs,
    rateLimitWindow,
    leaseTtlMs,
    options.cooldownMs,
  );

  const waitForAttempt = async (
    attempt: Promise<unknown>,
    leaseId: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const remaining = Math.max(0, deadline - Date.now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const backendTimeout = new RedisSpectreGovernorBackendError('Redis Spectre governor acquire timed out');
    const interrupted = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(backendTimeout), remaining);
      if (signal) {
        onAbort = () => reject(refusal('cancelled'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([attempt, interrupted]);
    } catch (error) {
      if (error === backendTimeout || error instanceof SpectreGovernorError) {
        void attempt.then(result => {
          if (parseAcquireResult(result).decision === 'acquired') return releaseRemote(leaseId);
          return undefined;
        }).catch(lateError => backendError('late_acquire_cleanup', lateError));
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };

  const waitToRetry = (deadline: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(refusal('cancelled'));
      return;
    }
    const delay = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    const timeout = setTimeout(finish, delay);
    const onAbort = () => finish(refusal('cancelled'));
    function finish(error?: SpectreGovernorError): void {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  return {
    async acquire(signal?: AbortSignal): Promise<SpectreLease> {
      if (signal?.aborted) throw refusal('cancelled');
      const deadline = Date.now() + options.queueTimeoutMs;
      const leaseId = createLeaseId();

      while (true) {
        if (signal?.aborted) throw refusal('cancelled');
        if (Date.now() >= deadline) throw refusal('concurrency_timeout');

        const attempt = acquireAttempt(leaseId);
        let result: ReturnType<typeof parseAcquireResult>;
        try {
          result = parseAcquireResult(await waitForAttempt(attempt, leaseId, deadline, signal));
        } catch (error) {
          if (!(error instanceof SpectreGovernorError)) {
            spectreGovernorBackendErrorsTotal.inc({ provider: metricProvider, backend: 'redis', operation: 'acquire' });
          }
          throw error;
        }
        state = result.state;
        publishCircuitState();
        if (result.recovered > 0) {
          spectreGovernorLeaseRecoveriesTotal.inc({ provider: metricProvider, backend: 'redis' }, result.recovered);
        }

        if (result.decision === 'rate_limited') throw refusal('rate_limited');
        if (result.decision === 'circuit_open') throw refusal('circuit_open');
        if (result.decision === 'concurrency') {
          await waitToRetry(deadline, signal);
          continue;
        }

        if (signal?.aborted) {
          await releaseRemote(leaseId).catch(error => backendError('cancelled_acquire_release', error));
          throw refusal('cancelled');
        }

        inFlight++;
        let released = false;
        let renewing = false;
        let renewalFailure: Error | undefined;
        let renewalInFlight: Promise<void> | undefined;
        const stopRenewal = (): void => {
          clearInterval(renewal);
        };
        const recordRenewalFailure = (error: unknown): void => {
          if (renewalFailure) return;
          renewalFailure = error instanceof Error
            ? error
            : new RedisSpectreGovernorBackendError(String(error));
          backendError('renew', renewalFailure);
          stopRenewal();
        };
        const renewal = setInterval(() => {
          if (released || renewing) return;
          renewing = true;
          renewalInFlight = options.client.eval(RENEW_SCRIPT, 1, keys[0], leaseId, leaseTtlMs)
            .then(value => {
              if (Number(value) !== 1) {
                recordRenewalFailure(new RedisSpectreGovernorBackendError('Redis Spectre governor lease ownership lost during renewal'));
              }
            })
            .catch(recordRenewalFailure)
            .finally(() => { renewing = false; });
          void renewalInFlight;
        }, Math.max(1, Math.floor(leaseTtlMs / 3)));
        renewal.unref?.();

        let completion: Promise<void> | undefined;
        const complete = (outcome: 'succeed' | 'fail'): Promise<void> => {
          if (completion) return completion;
          if (released) return Promise.reject(new RedisSpectreGovernorBackendError('Redis Spectre governor lease already released'));
          stopRenewal();
          const script = outcome === 'succeed' ? SUCCEED_SCRIPT : FAIL_SCRIPT;
          const args = outcome === 'succeed'
            ? [keys[0], keys[2], keys[3], leaseId]
            : [keys[0], keys[2], keys[3], leaseId, options.failureWindowMs, options.failureThreshold, options.cooldownMs];
          completion = (async () => {
            await renewalInFlight;
            let value: unknown;
            try {
              value = await options.client.eval(script, 3, ...args);
              const nextState = String(value);
              if (nextState === 'ignored') {
                throw new RedisSpectreGovernorBackendError(`Redis Spectre governor lease ownership lost during ${outcome}`);
              }
              if (nextState !== 'closed' && nextState !== 'open' && nextState !== 'half_open') {
                throw new RedisSpectreGovernorBackendError(`Invalid Redis Spectre governor ${outcome} response: ${nextState}`);
              }
              state = nextState;
              publishCircuitState();
            } catch (error) {
              backendError(outcome, error);
              throw error;
            }
            if (renewalFailure) throw renewalFailure;
          })();
          return completion;
        };

        let release: Promise<void> | undefined;

        return {
          succeed: () => complete('succeed'),
          fail: () => complete('fail'),
          release(): Promise<void> {
            if (release) return release;
            released = true;
            stopRenewal();
            release = (async () => {
              try {
                await renewalInFlight;
                const removed = await options.client.eval(RELEASE_SCRIPT, 2, keys[0], keys[2], leaseId);
                if (Number(removed) !== 1) {
                  throw new RedisSpectreGovernorBackendError('Redis Spectre governor lease ownership lost during release');
                }
              } catch (error) {
                backendError('release', error);
                throw error;
              } finally {
                inFlight--;
              }
              if (renewalFailure) throw renewalFailure;
            })();
            return release;
          },
        };
      }
    },
    getState: () => ({ state, inFlight }),
  };
}

export function createRedisSpectreGovernorRegistry(
  options: RedisSpectreGovernorOptions,
): (provider: string) => SpectreGovernor {
  const governors = new Map<string, SpectreGovernor>();
  return provider => {
    let governor = governors.get(provider);
    if (!governor) {
      governor = createRedisSpectreGovernor(provider, options);
      governors.set(provider, governor);
    }
    return governor;
  };
}
