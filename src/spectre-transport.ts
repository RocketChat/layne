export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface SpectreTransportRequest {
  /** Stable request identity, used by deterministic transports and evaluators. */
  key: string;
  prompt: string;
  /** Optional role-separated prompts for transports with a system-message API. */
  systemPrompt?: string;
  userPrompt?: string;
  responseSchema: JsonValue;
  signal?: AbortSignal;
}

export interface SpectreTransportResponse {
  text: string;
}

export const SPECTRE_TRANSPORT_ERROR_CODES = [
  'cancelled',
  'timeout',
  'unavailable',
  'failed',
  'invalid-response',
  'script-exhausted',
] as const;

export type SpectreTransportErrorCode = typeof SPECTRE_TRANSPORT_ERROR_CODES[number];

export interface SpectreTransportErrorOptions {
  cause?: unknown;
  retryable?: boolean;
}

export class SpectreTransportError extends Error {
  readonly code: SpectreTransportErrorCode;
  readonly retryable: boolean;

  constructor(code: SpectreTransportErrorCode, message: string, options: SpectreTransportErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'SpectreTransportError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export interface SpectreTransport {
  complete(request: SpectreTransportRequest): Promise<SpectreTransportResponse>;
}

export function spectreTransportCancelled(cause?: unknown): SpectreTransportError {
  return new SpectreTransportError('cancelled', 'Spectre transport request was cancelled', { cause });
}
