import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  debug: vi.fn(),
  inFlightInc: vi.fn(),
  inFlightDec: vi.fn(),
  failures: vi.fn(),
}));

vi.mock('../spectre-models.js', () => ({ completeSpectreModel: mocks.complete }));
vi.mock('../debug.js', () => ({ debug: mocks.debug }));
vi.mock('../metrics.js', () => ({
  spectreInFlightRequests: { inc: mocks.inFlightInc, dec: mocks.inFlightDec },
  spectreProviderFailuresTotal: { inc: mocks.failures },
}));

const { createPiAiSpectreTransport } = await import('../spectre-transports/pi-ai.js');

const REQUEST = {
  key: 'chunk-1',
  prompt: 'review this diff',
  systemPrompt: 'system',
  userPrompt: 'user',
  responseSchema: { type: 'object', properties: { findings: { type: 'array' } } },
};

function model(api: Api): Model<Api> {
  return { id: 'test-model', api, provider: 'test-provider' } as Model<Api>;
}

function toolResult(argumentsValue: Record<string, unknown>) {
  return {
    stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'call-1', name: 'report_findings', arguments: argumentsValue }],
  };
}

describe('PiAiSpectreTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.complete.mockResolvedValue(toolResult({ findings: [] }));
  });

  it.each([
    ['bedrock-converse-stream', 'any'],
    ['google-generative-ai', 'any'],
    ['anthropic-messages', { type: 'tool', name: 'report_findings' }],
    ['mistral-conversations', { type: 'function', function: { name: 'report_findings' } }],
    ['openai-responses', { type: 'function', name: 'report_findings' }],
  ] as const)('forces one report_findings tool for %s', async (api, toolChoice) => {
    const transport = createPiAiSpectreTransport({ model: model(api), maxOutputTokens: 2_000 });

    await expect(transport.complete(REQUEST)).resolves.toEqual({ text: '{"findings":[]}' });
    const [, context, options] = mocks.complete.mock.calls[0] as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(context).toMatchObject({
      tools: [{
        name: 'report_findings',
        parameters: REQUEST.responseSchema,
        constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      }],
    });
    expect(options).toMatchObject({ toolChoice, maxTokens: 2_000, maxRetries: 0, temperature: 0 });
  });

  it('rejects text-only output instead of trusting prose JSON', async () => {
    const sensitiveText = 'do-not-log-this-response';
    mocks.complete.mockResolvedValueOnce({
      stopReason: 'stop',
      content: [{ type: 'text', text: sensitiveText }],
    });
    const transport = createPiAiSpectreTransport({ model: model('anthropic-messages'), maxOutputTokens: 2_000 });

    await expect(transport.complete(REQUEST)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(mocks.debug).toHaveBeenCalledWith(
      'spectre',
      expect.stringContaining(
        'stopReason=stop contentBlocks=["text"] contentBlockCount=1 textChars=24 toolCalls=0',
      ),
    );
    expect(JSON.stringify(mocks.debug.mock.calls)).not.toContain(sensitiveText);
  });

  it('classifies a missing or duplicate report_findings call as invalid output', async () => {
    mocks.complete.mockResolvedValueOnce({ stopReason: 'toolUse', content: [] });
    const transport = createPiAiSpectreTransport({ model: model('bedrock-converse-stream'), maxOutputTokens: 2_000 });
    await expect(transport.complete(REQUEST)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(mocks.debug).toHaveBeenCalledWith(
      'spectre',
      expect.stringContaining('stopReason=toolUse contentBlocks=[] contentBlockCount=0 textChars=0 toolCalls=0'),
    );

    mocks.complete.mockResolvedValueOnce({
      stopReason: 'toolUse',
      content: [
        { type: 'toolCall', id: '1', name: 'report_findings', arguments: { findings: [] } },
        { type: 'toolCall', id: '2', name: 'report_findings', arguments: { findings: [] } },
      ],
    });
    await expect(transport.complete(REQUEST)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(mocks.debug).toHaveBeenCalledWith(
      'spectre',
      expect.stringContaining('toolCalls=2 toolNames=["report_findings","report_findings"]'),
    );
  });

  it('classifies provider output truncation as invalid output', async () => {
    mocks.complete.mockResolvedValueOnce({ stopReason: 'length', content: [] });
    const transport = createPiAiSpectreTransport({ model: model('bedrock-converse-stream'), maxOutputTokens: 2_000 });

    await expect(transport.complete(REQUEST)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('preserves provider errors instead of retrying them as invalid output', async () => {
    mocks.complete.mockResolvedValueOnce({
      stopReason: 'error',
      errorMessage: '403 access denied',
      content: [],
    });
    const transport = createPiAiSpectreTransport({ model: model('bedrock-converse-stream'), maxOutputTokens: 2_000 });

    await expect(transport.complete(REQUEST)).rejects.toMatchObject({ code: 'failed', retryable: false });
    expect(mocks.failures).toHaveBeenCalledWith({ kind: 'authentication_or_configuration' });
  });

  it('preserves provider aborts as retryable timeouts', async () => {
    mocks.complete.mockResolvedValueOnce({
      stopReason: 'aborted',
      errorMessage: 'request aborted',
      content: [],
    });
    const transport = createPiAiSpectreTransport({ model: model('bedrock-converse-stream'), maxOutputTokens: 2_000 });

    await expect(transport.complete(REQUEST)).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(mocks.failures).toHaveBeenCalledWith({ kind: 'timeout' });
  });

  it('does not log or propagate provider errors containing credentials or source', async () => {
    const secret = 'synthetic-sensitive-provider-payload';
    mocks.complete.mockRejectedValueOnce(new Error(`403 ${secret}`));
    const transport = createPiAiSpectreTransport({ model: model('anthropic-messages'), maxOutputTokens: 2_000 });
    await expect(transport.complete(REQUEST)).rejects.toThrow('Provider request failed (authentication_or_configuration)');
    expect(JSON.stringify(mocks.debug.mock.calls)).not.toContain(secret);
  });

  it('omits temperature for reasoning models', async () => {
    const transport = createPiAiSpectreTransport({ model: { ...model('bedrock-converse-stream'), reasoning: true }, maxOutputTokens: 2_000 });
    await transport.complete(REQUEST);
    expect(mocks.complete.mock.calls[0]?.[2]).not.toHaveProperty('temperature');
  });
});
