import type { Api, Model, ModelsApiStreamOptions, Tool, ToolCall } from '@earendil-works/pi-ai';
import { debug } from '../debug.js';
import {
  spectreInFlightRequests,
  spectreProviderFailuresTotal,
} from '../metrics.js';
import {
  SpectreTransportError,
  type SpectreTransport,
  type SpectreTransportRequest,
  type SpectreTransportResponse,
} from '../spectre-transport.js';
import { completeSpectreModel } from '../spectre-models.js';

export interface PiAiSpectreTransportOptions {
  model: Model<Api>;
  maxOutputTokens: number;
}

const REPORT_FINDINGS_TOOL = 'report_findings';

function forcedToolChoice(api: Api): unknown {
  if (api === 'bedrock-converse-stream' || api === 'google-generative-ai' || api === 'google-vertex') return 'any';
  if (api === 'anthropic-messages') return { type: 'tool', name: REPORT_FINDINGS_TOOL };
  if (api === 'mistral-conversations' || api === 'openai-completions') {
    return { type: 'function', function: { name: REPORT_FINDINGS_TOOL } };
  }
  if (api === 'openai-responses' || api === 'azure-openai-responses') {
    return { type: 'function', name: REPORT_FINDINGS_TOOL };
  }
  return 'required';
}

function supportsTemperature(model: Model<Api>): boolean {
  return !model.reasoning;
}

function failureKind(message: string): { code: 'timeout' | 'unavailable' | 'failed'; metric: string; retryable: boolean } {
  const normalized = message.toLowerCase();
  if (/\b(401|403)\b|auth|credential|access.?denied|configuration/.test(normalized)) {
    return { code: 'failed', metric: 'authentication_or_configuration', retryable: false };
  }
  if (/\b429\b|rate.?limit/.test(normalized)) {
    return { code: 'unavailable', metric: 'rate_limited', retryable: true };
  }
  if (/\b5\d\d\b|service unavailable|internal server/.test(normalized)) {
    return { code: 'unavailable', metric: 'provider_5xx', retryable: true };
  }
  if (/timeout|timed out|abort/.test(normalized)) {
    return { code: 'timeout', metric: 'timeout', retryable: true };
  }
  if (/dns|enotfound|econn|network/.test(normalized)) {
    return { code: 'unavailable', metric: 'connection', retryable: true };
  }
  return { code: 'failed', metric: 'unknown', retryable: true };
}

function serializedByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return -1;
  }
}

export class PiAiSpectreTransport implements SpectreTransport {
  constructor(private readonly options: PiAiSpectreTransportOptions) {}

  async complete(request: SpectreTransportRequest): Promise<SpectreTransportResponse> {
    spectreInFlightRequests.inc();
    try {
      const tool: Tool = {
        name: REPORT_FINDINGS_TOOL,
        description: 'Return the complete set of Spectre findings for this request.',
        parameters: request.responseSchema as never,
        constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      };
      const result = await completeSpectreModel(this.options.model, {
        systemPrompt: request.systemPrompt,
        messages: [{
          role: 'user' as const,
          timestamp: Date.now(),
          content: request.userPrompt ?? request.prompt,
        }],
        tools: [tool],
      }, {
        ...(supportsTemperature(this.options.model) ? { temperature: 0 } : {}),
        maxTokens: this.options.maxOutputTokens,
        maxRetries: 0,
        toolChoice: forcedToolChoice(this.options.model.api),
        signal: request.signal,
      } as ModelsApiStreamOptions<Api>);
      const calls = result.content.filter((content): content is ToolCall => content.type === 'toolCall');
      const contentBlocks = result.content.slice(0, 20).map(content => content.type);
      const textCharacters = result.content.reduce(
        (count, content) => count + (content.type === 'text' ? content.text.length : 0),
        0,
      );
      const toolArgumentBytes = calls.reduce((count, call) => count + serializedByteLength(call.arguments), 0);
      const responseDetails = `key=${request.key} provider=${this.options.model.provider}`
        + ` model=${this.options.model.id} api=${this.options.model.api} stopReason=${result.stopReason}`
        + ` contentBlocks=${JSON.stringify(contentBlocks)} contentBlockCount=${result.content.length}`
        + ` textChars=${textCharacters} toolCalls=${calls.length}`
        + ` toolNames=${JSON.stringify(calls.slice(0, 10).map(call => call.name === REPORT_FINDINGS_TOOL ? REPORT_FINDINGS_TOOL : '[unexpected]'))}`
        + ` toolArgumentBytes=${toolArgumentBytes}`;

      if (result.stopReason === 'length') {
        debug('spectre', `invalid provider response: ${responseDetails}`);
        throw new SpectreTransportError('invalid-response', 'Provider output token limit reached');
      }
      if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        const message = result.errorMessage || `Provider stopped with reason: ${result.stopReason}`;
        const failure = result.stopReason === 'aborted'
          ? { code: 'timeout' as const, metric: 'timeout', retryable: true }
          : failureKind(message);
        spectreProviderFailuresTotal.inc({ kind: failure.metric });
        throw new SpectreTransportError(failure.code, `Provider request failed (${failure.metric})`, { retryable: failure.retryable });
      }
      if (result.stopReason !== 'toolUse') {
        debug('spectre', `invalid provider response: ${responseDetails}`);
        throw new SpectreTransportError(
          'invalid-response',
          'Provider did not return report_findings',
        );
      }
      if (calls.length !== 1 || calls[0]?.name !== REPORT_FINDINGS_TOOL) {
        debug('spectre', `invalid provider response: ${responseDetails}`);
        throw new SpectreTransportError(
          'invalid-response',
          calls.length === 0 ? 'Provider did not call report_findings' : 'Provider returned an invalid report_findings call',
        );
      }
      return {
        text: JSON.stringify(calls[0].arguments),
      };
    } catch (error) {
      if (error instanceof SpectreTransportError) throw error;
      const original = error as Error;
      const failure = failureKind(original.message);
      debug('spectre', `provider request failed (${failure.metric})`);
      spectreProviderFailuresTotal.inc({ kind: failure.metric });
      throw new SpectreTransportError(failure.code, `Provider request failed (${failure.metric})`, {
        retryable: failure.retryable,
      });
    } finally {
      spectreInFlightRequests.dec();
    }
  }
}

export function createPiAiSpectreTransport(options: PiAiSpectreTransportOptions): PiAiSpectreTransport {
  return new PiAiSpectreTransport(options);
}
