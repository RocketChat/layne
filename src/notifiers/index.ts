import { randomUUID } from 'crypto';
import { redis } from '../queue.js';
import { projectNotificationState } from '../notification-state.js';
import { notify as notifyRocketchat } from './rocketchat.js';
import { notify as notifySlack } from './slack.js';
import type {
  NotificationDeliveryOutcome,
  NotifierAttemptResult,
  NotifyOrchestratorParams,
  NotifyParams,
} from './types.js';

const STATE_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 60;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1_000];
const LOCK_RETRY_DELAY_MS = 100;
const ATTEMPT_TIMEOUT_MS = 10_000;

const NOTIFIERS: Record<string, (params: NotifyParams) => Promise<NotifierAttemptResult>> = {
  rocketchat: notifyRocketchat,
  slack: notifySlack,
};

interface NotificationCursor {
  fingerprint: string;
  scanSequence: number;
}

export async function notify(params: NotifyOrchestratorParams): Promise<NotificationDeliveryOutcome[]> {
  const entries = Object.entries(NOTIFIERS)
    .filter(([key]) => params.notificationConfig[key]?.enabled);

  return Promise.all(entries.map(([key, notifierFn]) => deliver(key, notifierFn, params)));
}

async function deliver(
  notifier: string,
  notifierFn: (params: NotifyParams) => Promise<NotifierAttemptResult>,
  params: NotifyOrchestratorParams,
): Promise<NotificationDeliveryOutcome> {
  const toolConfig = params.notificationConfig[notifier]!;
  const projection = projectNotificationState(params.state, toolConfig);
  const scanSequence = params.scanSequence ?? Date.now();
  const stateKey = `layne:notification:v1:${notifier}:${params.owner}/${params.repo}#${params.prNumber}`;
  const lockKey = `${stateKey}:lock`;
  const token = randomUUID();
  let lockResult: 'acquired' | 'busy';
  try {
    lockResult = await acquireLock(lockKey, token, params.signal);
  } catch (err) {
    params.signal?.throwIfAborted();
    if (projection.events.length === 0) return { notifier, status: 'filtered' };
    console.warn(`[notifiers] Redis lock unavailable for ${notifier}: ${(err as Error).message} - delivering without deduplication`);
    return attemptDelivery(notifier, notifierFn, params, projection);
  }

  if (lockResult === 'busy') return { notifier, status: 'busy' };

  try {
    let cursor: NotificationCursor | null = null;
    try {
      const stored = await redis.get(stateKey);
      if (stored) cursor = JSON.parse(stored) as NotificationCursor;
    } catch (err) {
      console.warn(`[notifiers] Redis state unavailable for ${notifier}: ${(err as Error).message} - delivering without deduplication`);
    }

    if (cursor && cursor.scanSequence > scanSequence) return { notifier, status: 'stale' };

    if (cursor?.fingerprint === projection.fingerprint) {
      await storeCursor(stateKey, projection.fingerprint, Math.max(cursor.scanSequence, scanSequence));
      return { notifier, status: 'deduplicated' };
    }

    if (projection.events.length === 0) {
      await storeCursor(stateKey, projection.fingerprint, scanSequence);
      return { notifier, status: 'filtered' };
    }

    const outcome = await attemptDelivery(notifier, notifierFn, params, projection);
    if (outcome.status === 'delivered') {
      await storeCursor(stateKey, projection.fingerprint, scanSequence);
    }
    return outcome;
  } finally {
    await releaseLock(lockKey, token);
  }
}

async function attemptDelivery(
  notifier: string,
  notifierFn: (params: NotifyParams) => Promise<NotifierAttemptResult>,
  params: NotifyOrchestratorParams,
  projection: ReturnType<typeof projectNotificationState>,
): Promise<NotificationDeliveryOutcome> {
  let lastResult: NotifierAttemptResult = { delivered: false, reason: 'unknown' };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    params.signal?.throwIfAborted();
    const attemptController = new AbortController();
    const forwardAbort = () => attemptController.abort(params.signal?.reason);
    params.signal?.addEventListener('abort', forwardAbort, { once: true });
    const attemptTimer = setTimeout(
      () => attemptController.abort(new Error(`Notification attempt timed out after ${ATTEMPT_TIMEOUT_MS} ms`)),
      ATTEMPT_TIMEOUT_MS,
    );
    try {
      lastResult = await notifierFn({
        state: params.state,
        projection,
        owner: params.owner,
        repo: params.repo,
        prNumber: params.prNumber,
        toolConfig: params.notificationConfig[notifier]!,
        ...(params.headSha && { headSha: params.headSha }),
        signal: attemptController.signal,
      });
    } catch (err) {
      params.signal?.throwIfAborted();
      lastResult = { delivered: false, retryable: true, reason: (err as Error).message };
    } finally {
      clearTimeout(attemptTimer);
      params.signal?.removeEventListener('abort', forwardAbort);
    }

    if (lastResult.delivered) return { notifier, status: 'delivered', attempts: attempt };
    if (!lastResult.retryable || attempt === MAX_ATTEMPTS) {
      return { notifier, status: 'failed', attempts: attempt, reason: lastResult.reason };
    }
    await abortableDelay(RETRY_DELAYS_MS[attempt - 1]!, params.signal);
  }

  return { notifier, status: 'failed', attempts: MAX_ATTEMPTS, reason: lastResult.reason };
}

async function storeCursor(key: string, fingerprint: string, scanSequence: number): Promise<void> {
  try {
    await redis.eval(
      `local current = redis.call("get", KEYS[1])
       if current then
         local ok, decoded = pcall(cjson.decode, current)
         if ok and tonumber(decoded.scanSequence) > tonumber(ARGV[3]) then return 0 end
       end
       redis.call("set", KEYS[1], ARGV[1], "EX", ARGV[2])
       return 1`,
      1,
      key,
      JSON.stringify({ fingerprint, scanSequence }),
      STATE_TTL_SECONDS,
      scanSequence,
    );
  } catch (err) {
    console.warn(`[notifiers] Failed to store notification state: ${(err as Error).message}`);
  }
}

async function acquireLock(
  key: string,
  token: string,
  signal?: AbortSignal,
): Promise<'acquired' | 'busy'> {
  const deadline = Date.now() + (LOCK_TTL_SECONDS + 5) * 1_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const acquired = await redis.set(key, token, 'EX', LOCK_TTL_SECONDS, 'NX');
    if (acquired === 'OK') return 'acquired';
    await abortableDelay(LOCK_RETRY_DELAY_MS, signal);
  }
  return 'busy';
}

async function releaseLock(key: string, token: string): Promise<void> {
  try {
    await redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0',
      1,
      key,
      token,
    );
  } catch (err) {
    console.warn(`[notifiers] Failed to release notification lock: ${(err as Error).message}`);
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new Error('Notification cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
