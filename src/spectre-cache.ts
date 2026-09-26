import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Redis } from 'ioredis';
import { spectreCacheEntryBytes, spectreCacheOperationsTotal } from './metrics.js';
import type { JsonValue } from './spectre-transport.js';
import type { LineRange, SpectreCacheContext, SpectreConfig } from './types.js';
import { SPECTRE_STRUCTURAL_RULES_VERSION } from './spectre-structural-version.js';

export type SpectreCacheMode = 'off' | 'write-only' | 'verify' | 'read-write';
export type SpectreCacheResultClass = 'positive' | 'negative';

export interface SpectreCacheSourceCommitment {
  file: string;
  newOid: string;
  contentSha256: string;
  changedLineRanges: readonly LineRange[];
}

export interface SpectreCacheRequest {
  key: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: JsonValue;
  sources: readonly SpectreCacheSourceCommitment[];
}

export interface SpectreCachedResponse {
  text: string;
  resultClass: SpectreCacheResultClass;
  agreements: number;
  validationToken?: string;
}

export interface SpectreResponseCache {
  readonly mode: SpectreCacheMode;
  read(request: SpectreCacheRequest): Promise<SpectreCachedResponse | null>;
  write(request: SpectreCacheRequest, text: string, resultClass: SpectreCacheResultClass): Promise<void>;
  invalidate(request: SpectreCacheRequest, validationToken?: string): Promise<void>;
  recordServed(resultClass: SpectreCacheResultClass): void;
  recordVerification(cached: SpectreCacheResultClass, live: SpectreCacheResultClass, matches: boolean): void;
}

export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  on?(event: string, listener: (error: Error) => void): unknown;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

interface CacheEnvelopePayload {
  version: 1;
  scope: string;
  descriptor: string;
  resultClass: SpectreCacheResultClass;
  agreements: number;
  createdAt: number;
  expiresAt: number;
  text: string;
}

interface CacheEnvelope {
  payload: CacheEnvelopePayload;
  signature: string;
}

export interface SpectreCacheOptions {
  client: RedisCacheClient;
  context: SpectreCacheContext;
  provider: string;
  model: string;
  modelApi: string;
  maxOutputTokens: number;
  config: SpectreConfig;
  mode: SpectreCacheMode;
  hmacKey: string;
  maxBytes: number;
  buildVersion: string;
  epoch: string;
  now?: () => number;
}

const CACHE_VERSION = 1;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 96 * 1024;
const CIRCUIT_FAILURES = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;
const HASH_TAG = '{spectre-cache:v1}';

const WRITE_SCRIPT = `
local entry = KEYS[1]
local order = KEYS[2]
local expires = KEYS[3]
local sizes = KEYS[4]
local totalKey = KEYS[5]
local expected = ARGV[1]
local value = ARGV[2]
local ttl = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local size = tonumber(ARGV[5])
local maximum = tonumber(ARGV[6])
local current = redis.call('GET', entry)
if expected == '__LAYNE_MISSING__' then
  if current then return {-1, tonumber(redis.call('GET', totalKey) or '0')} end
elseif current ~= expected then
  return {-1, tonumber(redis.call('GET', totalKey) or '0')}
end
local oldSize = tonumber(redis.call('HGET', sizes, entry) or '0')
redis.call('SET', entry, value, 'EX', ttl)
redis.call('ZADD', order, now, entry)
redis.call('ZADD', expires, now + ttl * 1000, entry)
redis.call('HSET', sizes, entry, size)
local total = tonumber(redis.call('GET', totalKey) or '0') + size - oldSize
local expired = redis.call('ZRANGEBYSCORE', expires, '-inf', now, 'LIMIT', 0, 100)
for _, victim in ipairs(expired) do
  if victim ~= entry then
    local victimSize = tonumber(redis.call('HGET', sizes, victim) or '0')
    redis.call('DEL', victim)
    redis.call('ZREM', order, victim)
    redis.call('ZREM', expires, victim)
    redis.call('HDEL', sizes, victim)
    total = total - victimSize
  end
end
local attempts = 0
while total > maximum and attempts < 1000 do
  local victims = redis.call('ZRANGE', order, 0, 0)
  if #victims == 0 then break end
  local victim = victims[1]
  local victimSize = tonumber(redis.call('HGET', sizes, victim) or '0')
  redis.call('DEL', victim)
  redis.call('ZREM', order, victim)
  redis.call('ZREM', expires, victim)
  redis.call('HDEL', sizes, victim)
  total = total - victimSize
  attempts = attempts + 1
end
if total < 0 then total = 0 end
if redis.call('EXISTS', entry) == 0 then
  redis.call('SET', totalKey, total)
  return {0, total}
end
if total > maximum then
  local currentSize = tonumber(redis.call('HGET', sizes, entry) or '0')
  redis.call('DEL', entry)
  redis.call('ZREM', order, entry)
  redis.call('ZREM', expires, entry)
  redis.call('HDEL', sizes, entry)
  total = total - currentSize
  if total < 0 then total = 0 end
  redis.call('SET', totalKey, total)
  return {0, total}
end
redis.call('SET', totalKey, total)
return {1, total}
`;

const DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local size = tonumber(redis.call('HGET', KEYS[4], KEYS[1]) or '0')
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], KEYS[1])
redis.call('ZREM', KEYS[3], KEYS[1])
redis.call('HDEL', KEYS[4], KEYS[1])
local total = tonumber(redis.call('GET', KEYS[5]) or '0') - size
if total < 0 then total = 0 end
redis.call('SET', KEYS[5], total)
return total
`;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function positiveFindingKeys(text: string): Set<string> | null {
  try {
    const parsed = JSON.parse(text) as { findings?: unknown };
    if (!Array.isArray(parsed.findings) || parsed.findings.length === 0) return null;
    return new Set(parsed.findings.map(finding => canonicalJson(finding)));
  } catch {
    return null;
  }
}

function isFindingSuperset(candidateText: string, existingText: string): boolean {
  const candidate = positiveFindingKeys(candidateText);
  const existing = positiveFindingKeys(existingText);
  return candidate !== null && existing !== null
    && candidate.size > existing.size
    && [...existing].every(finding => candidate.has(finding));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validContext(context: SpectreCacheContext): boolean {
  return validInteger(context.installationId)
    && validInteger(context.repositoryId)
    && validInteger(context.prNumber)
    && typeof context.baseSha === 'string'
    && context.baseSha.length > 0;
}

function timingSafeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function spectreCacheModeFromEnv(): SpectreCacheMode {
  const mode = process.env.SPECTRE_CACHE_MODE ?? 'off';
  return mode === 'write-only' || mode === 'verify' || mode === 'read-write' ? mode : 'off';
}

export class RedisSpectreResponseCache implements SpectreResponseCache {
  readonly mode: SpectreCacheMode;
  private readonly scope: string;
  private readonly prefix: string;
  private readonly metadataKeys: [string, string, string, string];
  private readonly baseDescriptor: Record<string, unknown>;
  private failures = 0;
  private disabledUntil = 0;

  constructor(private readonly options: SpectreCacheOptions) {
    this.mode = options.mode;
    this.scope = `${options.context.installationId}:${options.context.repositoryId}:${options.context.prNumber}`;
    this.prefix = `layne:${HASH_TAG}:${this.scope}`;
    this.metadataKeys = [
      `layne:${HASH_TAG}:order`,
      `layne:${HASH_TAG}:expires`,
      `layne:${HASH_TAG}:sizes`,
      `layne:${HASH_TAG}:bytes`,
    ];
    const scannerConfig: Partial<SpectreConfig> = { ...options.config };
    delete scannerConfig.cache;
    this.baseDescriptor = {
      cacheVersion: CACHE_VERSION,
      buildVersion: options.buildVersion,
      epoch: options.epoch,
      scope: this.scope,
      mergeBaseSha: options.context.baseSha,
      provider: options.provider,
      model: options.model,
      modelApi: options.modelApi,
      maxOutputTokens: options.maxOutputTokens,
      structuralRulesVersion: SPECTRE_STRUCTURAL_RULES_VERSION,
      scannerConfig,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private descriptor(request: SpectreCacheRequest): string {
    return sha256(canonicalJson({
      ...this.baseDescriptor,
      request: {
        key: request.key,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        responseSchema: request.responseSchema,
        sources: request.sources,
      },
    }));
  }

  private key(descriptor: string): string {
    return `${this.prefix}:${descriptor}`;
  }

  private sign(payload: CacheEnvelopePayload): string {
    return createHmac('sha256', this.options.hmacKey).update(canonicalJson(payload)).digest('hex');
  }

  private decode(raw: string, descriptor: string): CacheEnvelopePayload | null {
    if (Buffer.byteLength(raw, 'utf8') > MAX_ENVELOPE_BYTES) return null;
    try {
      const envelope = JSON.parse(raw) as Partial<CacheEnvelope>;
      const payload = envelope.payload;
      if (!payload || typeof envelope.signature !== 'string') return null;
      if (payload.version !== CACHE_VERSION || payload.scope !== this.scope || payload.descriptor !== descriptor) return null;
      if (payload.resultClass !== 'positive' && payload.resultClass !== 'negative') return null;
      if (!Number.isSafeInteger(payload.agreements) || payload.agreements < 1 || payload.agreements > 1_000) return null;
      if (!Number.isSafeInteger(payload.createdAt) || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= this.now()) return null;
      if (typeof payload.text !== 'string' || Buffer.byteLength(payload.text, 'utf8') > MAX_RESPONSE_BYTES) return null;
      return timingSafeHexEqual(envelope.signature, this.sign(payload as CacheEnvelopePayload))
        ? payload as CacheEnvelopePayload
        : null;
    } catch {
      return null;
    }
  }

  private available(): boolean {
    return this.now() >= this.disabledUntil;
  }

  private succeeded(): void {
    this.failures = 0;
  }

  private failed(operation: string): void {
    this.failures++;
    if (this.failures >= CIRCUIT_FAILURES) this.disabledUntil = this.now() + CIRCUIT_COOLDOWN_MS;
    spectreCacheOperationsTotal.inc({ operation, outcome: 'error', result: 'none' });
  }

  private async readPayload(request: SpectreCacheRequest, metric = true): Promise<{
    payload: CacheEnvelopePayload;
    descriptor: string;
    raw: string;
  } | null> {
    if (!this.available()) {
      if (metric) spectreCacheOperationsTotal.inc({ operation: 'read', outcome: 'bypassed', result: 'none' });
      return null;
    }
    const descriptor = this.descriptor(request);
    try {
      const raw = await this.options.client.get(this.key(descriptor));
      this.succeeded();
      if (raw === null) {
        if (metric) spectreCacheOperationsTotal.inc({ operation: 'read', outcome: 'miss', result: 'none' });
        return null;
      }
      const payload = this.decode(raw, descriptor);
      if (!payload) {
        if (metric) spectreCacheOperationsTotal.inc({ operation: 'read', outcome: 'invalid', result: 'none' });
        await this.invalidate(request, raw);
        return null;
      }
      if (metric) spectreCacheOperationsTotal.inc({ operation: 'read', outcome: 'hit', result: payload.resultClass });
      return { payload, descriptor, raw };
    } catch {
      this.failed('read');
      return null;
    }
  }

  private async observeForWrite(request: SpectreCacheRequest): Promise<{
    descriptor: string;
    raw: string | null;
    payload: CacheEnvelopePayload | null;
  } | null> {
    if (!this.available()) return null;
    const descriptor = this.descriptor(request);
    try {
      const raw = await this.options.client.get(this.key(descriptor));
      this.succeeded();
      return { descriptor, raw, payload: raw === null ? null : this.decode(raw, descriptor) };
    } catch {
      this.failed('read');
      return null;
    }
  }

  async read(request: SpectreCacheRequest): Promise<SpectreCachedResponse | null> {
    if (this.mode === 'off' || this.mode === 'write-only') return null;
    const stored = await this.readPayload(request);
    return stored ? {
      text: stored.payload.text,
      resultClass: stored.payload.resultClass,
      agreements: stored.payload.agreements,
      validationToken: stored.raw,
    } : null;
  }

  async write(request: SpectreCacheRequest, text: string, resultClass: SpectreCacheResultClass): Promise<void> {
    if (this.mode === 'off' || !this.available() || Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const observed = await this.observeForWrite(request);
      if (!observed) return;
      if (observed.payload?.resultClass === 'positive' && resultClass === 'negative') {
        spectreCacheOperationsTotal.inc({ operation: 'write', outcome: 'preserved', result: 'positive' });
        return;
      }
      if (observed.payload?.resultClass === 'positive' && resultClass === 'positive'
        && !isFindingSuperset(text, observed.payload.text)) {
        spectreCacheOperationsTotal.inc({ operation: 'write', outcome: 'preserved', result: 'positive' });
        return;
      }
      const agreements = resultClass === 'negative' && observed.payload?.resultClass === 'negative'
        ? Math.min(observed.payload.agreements + 1, 1_000)
        : 1;
      const ttl = resultClass === 'positive'
        ? this.options.config.cache!.positiveTtlSeconds
        : this.options.config.cache!.negativeTtlSeconds;
      const now = this.now();
      const payload: CacheEnvelopePayload = {
        version: CACHE_VERSION,
        scope: this.scope,
        descriptor: observed.descriptor,
        resultClass,
        agreements,
        createdAt: now,
        expiresAt: now + ttl * 1000,
        text,
      };
      const serialized = canonicalJson({ payload, signature: this.sign(payload) });
      const serializedBytes = Buffer.byteLength(serialized, 'utf8');
      if (serializedBytes > MAX_ENVELOPE_BYTES) return;
      try {
        const evaluated = await this.options.client.eval(
          WRITE_SCRIPT,
          5,
          this.key(observed.descriptor),
          ...this.metadataKeys,
          observed.raw ?? '__LAYNE_MISSING__',
          serialized,
          ttl,
          now,
          serializedBytes,
          this.options.maxBytes,
        );
        const outcome = Array.isArray(evaluated) ? Number(evaluated[0]) : Number(evaluated);
        this.succeeded();
        if (outcome === -1) continue;
        if (outcome === 0) {
          spectreCacheOperationsTotal.inc({ operation: 'write', outcome: 'budget-rejected', result: resultClass });
          return;
        }
        spectreCacheOperationsTotal.inc({ operation: 'write', outcome: 'success', result: resultClass });
        (spectreCacheEntryBytes as { observe(value: number): void }).observe(serializedBytes);
        return;
      } catch {
        this.failed('write');
        return;
      }
    }
    spectreCacheOperationsTotal.inc({ operation: 'write', outcome: 'conflict', result: resultClass });
  }

  async invalidate(request: SpectreCacheRequest, validationToken?: string): Promise<void> {
    if (!this.available() || validationToken === undefined) return;
    const descriptor = this.descriptor(request);
    try {
      const evaluated = await this.options.client.eval(
        DELETE_SCRIPT,
        5,
        this.key(descriptor),
        ...this.metadataKeys,
        validationToken,
      );
      this.succeeded();
      spectreCacheOperationsTotal.inc({
        operation: 'delete',
        outcome: Number(evaluated) === -1 ? 'conflict' : 'success',
        result: 'none',
      });
    } catch {
      this.failed('delete');
    }
  }

  recordVerification(cached: SpectreCacheResultClass, live: SpectreCacheResultClass, matches: boolean): void {
    spectreCacheOperationsTotal.inc({
      operation: 'verify',
      outcome: matches ? 'match' : 'disagreement',
      result: `${cached}-${live}`,
    });
  }

  recordServed(resultClass: SpectreCacheResultClass): void {
    spectreCacheOperationsTotal.inc({ operation: 'serve', outcome: 'success', result: resultClass });
  }
}

let productionClient: Redis | null = null;

function getProductionClient(): Redis {
  if (productionClient) return productionClient;
  productionClient = new Redis(process.env.SPECTRE_CACHE_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    lazyConnect: true,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
  });
  void productionClient.connect().catch(() => {});
  productionClient.on('error', () => {
    // Operations are fail-open and instrument their own errors.
  });
  return productionClient;
}

export function createProductionSpectreCache({
  context,
  provider,
  model,
  modelApi,
  maxOutputTokens,
  config,
}: {
  context?: SpectreCacheContext;
  provider: string;
  model: string;
  modelApi: string;
  maxOutputTokens: number;
  config: SpectreConfig;
}): SpectreResponseCache | undefined {
  const mode = spectreCacheModeFromEnv();
  if (!config.cache?.enabled || mode === 'off' || !context || !validContext(context)) return undefined;
  const hmacKey = process.env.SPECTRE_CACHE_HMAC_KEY;
  const maxBytes = Number(process.env.SPECTRE_CACHE_MAX_BYTES);
  if (!hmacKey || Buffer.byteLength(hmacKey, 'utf8') < 32 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 * 1024) return undefined;
  const buildVersion = process.env.LAYNE_BUILD_SHA;
  if (!buildVersion) return undefined;
  return new RedisSpectreResponseCache({
    client: getProductionClient(),
    context,
    provider,
    model,
    modelApi,
    maxOutputTokens,
    config,
    mode,
    hmacKey,
    maxBytes,
    buildVersion,
    epoch: process.env.SPECTRE_CACHE_EPOCH ?? '1',
  });
}

export async function closeSpectreCacheClient(): Promise<void> {
  const client = productionClient;
  productionClient = null;
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
