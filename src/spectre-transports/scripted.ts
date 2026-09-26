import {
  SpectreTransportError,
  spectreTransportCancelled,
  type SpectreTransport,
  type SpectreTransportRequest,
  type SpectreTransportResponse,
} from '../spectre-transport.js';

export type ScriptedSpectreStep =
  | SpectreTransportResponse
  | SpectreTransportError
  | Error
  | ((request: SpectreTransportRequest) => SpectreTransportResponse | Promise<SpectreTransportResponse>);

export type ScriptedSpectreQueues =
  | Readonly<Record<string, readonly ScriptedSpectreStep[]>>
  | ReadonlyMap<string, readonly ScriptedSpectreStep[]>;

function copyQueues(source: ScriptedSpectreQueues): Map<string, ScriptedSpectreStep[]> {
  const entries = source instanceof Map ? source.entries() : Object.entries(source);
  return new Map(Array.from(entries, ([key, steps]) => [key, [...steps]]));
}

function waitForStep(
  step: SpectreTransportResponse | Promise<SpectreTransportResponse>,
  signal?: AbortSignal,
): Promise<SpectreTransportResponse> {
  if (!signal) return Promise.resolve(step);
  if (signal.aborted) return Promise.reject(spectreTransportCancelled(signal.reason));

  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(spectreTransportCancelled(signal.reason));
    };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(step).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

export class ScriptedSpectreTransport implements SpectreTransport {
  readonly requests: SpectreTransportRequest[] = [];
  private readonly queues: Map<string, ScriptedSpectreStep[]>;

  constructor(queues: ScriptedSpectreQueues) {
    this.queues = copyQueues(queues);
  }

  remaining(key?: string): number {
    if (key !== undefined) return this.queues.get(key)?.length ?? 0;
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  async complete(request: SpectreTransportRequest): Promise<SpectreTransportResponse> {
    this.requests.push(request);
    if (request.signal?.aborted) throw spectreTransportCancelled(request.signal.reason);

    const step = this.queues.get(request.key)?.shift();
    if (step === undefined) {
      throw new SpectreTransportError(
        'script-exhausted',
        `No scripted Spectre response remains for key: ${request.key}`,
      );
    }
    if (step instanceof SpectreTransportError) throw step;
    if (step instanceof Error) {
      throw new SpectreTransportError('failed', step.message, { cause: step });
    }

    return waitForStep(typeof step === 'function' ? step(request) : step, request.signal);
  }
}

export function createScriptedSpectreTransport(queues: ScriptedSpectreQueues): ScriptedSpectreTransport {
  return new ScriptedSpectreTransport(queues);
}
