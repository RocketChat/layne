import { describe, expect, it } from 'vitest';
import { SpectreTransportError, type SpectreTransportRequest } from '../spectre-transport.js';
import { createScriptedSpectreTransport } from '../spectre-transports/scripted.js';

const request = (key: string, signal?: AbortSignal): SpectreTransportRequest => ({
  key,
  prompt: `prompt:${key}`,
  responseSchema: { type: 'object' },
  signal,
});

describe('scripted Spectre transport', () => {
  it('keeps independent FIFO queues, records requests, and reports remaining steps', async () => {
    const transport = createScriptedSpectreTransport({
      alpha: [{ text: 'alpha-1' }, { text: 'alpha-2' }],
      beta: [{ text: 'beta-1' }],
    });

    await expect(transport.complete(request('alpha'))).resolves.toEqual({ text: 'alpha-1' });
    await expect(transport.complete(request('beta'))).resolves.toEqual({ text: 'beta-1' });

    expect(transport.requests.map(recorded => recorded.key)).toEqual(['alpha', 'beta']);
    expect(transport.remaining('alpha')).toBe(1);
    expect(transport.remaining('beta')).toBe(0);
    expect(transport.remaining()).toBe(1);
  });

  it('returns typed failures for scripted errors and exhausted keys', async () => {
    const scriptedError = new SpectreTransportError('timeout', 'provider timed out', { retryable: true });
    const transport = createScriptedSpectreTransport({ failure: [scriptedError] });

    await expect(transport.complete(request('failure'))).rejects.toBe(scriptedError);
    await expect(transport.complete(request('failure'))).rejects.toMatchObject({
      name: 'SpectreTransportError',
      code: 'script-exhausted',
    });
  });

  it('honours cancellation without consuming the queued response', async () => {
    const controller = new AbortController();
    controller.abort('test cancellation');
    const transport = createScriptedSpectreTransport({ cancelled: [{ text: 'unused' }] });

    await expect(transport.complete(request('cancelled', controller.signal))).rejects.toMatchObject({
      name: 'SpectreTransportError',
      code: 'cancelled',
    });
    expect(transport.remaining('cancelled')).toBe(1);
    expect(transport.requests).toHaveLength(1);
  });

  it('can cancel an asynchronous scripted step', async () => {
    const controller = new AbortController();
    const transport = createScriptedSpectreTransport({
      pending: [() => new Promise(() => undefined)],
    });
    const completion = transport.complete(request('pending', controller.signal));
    controller.abort();

    await expect(completion).rejects.toMatchObject({ code: 'cancelled' });
  });
});
