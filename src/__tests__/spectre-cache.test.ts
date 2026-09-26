import { beforeEach, describe, expect, it, vi } from 'vitest';

const metrics = vi.hoisted(() => ({ operations: vi.fn(), bytes: vi.fn() }));
vi.mock('../metrics.js', () => ({
  spectreCacheOperationsTotal: { inc: metrics.operations },
  spectreCacheEntryBytes: { observe: metrics.bytes },
}));

import {
  RedisSpectreResponseCache,
  type RedisCacheClient,
  type SpectreCacheOptions,
  type SpectreCacheRequest,
} from '../spectre-cache.js';

class FakeRedis implements RedisCacheClient {
  readonly values = new Map<string, string>();
  failReads = false;
  failWrites = false;

  async get(key: string): Promise<string | null> {
    if (this.failReads) throw new Error('Redis unavailable');
    return this.values.get(key) ?? null;
  }

  async eval(script: string, _numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const key = String(args[0]);
    if (script.includes('local expected = ARGV[1]')) {
      if (this.failWrites) throw new Error('Redis unavailable');
      const expected = String(args[5]);
      const current = this.values.get(key);
      if ((expected === '__LAYNE_MISSING__' && current !== undefined) || (expected !== '__LAYNE_MISSING__' && current !== expected)) {
        return [-1, 0];
      }
      this.values.set(key, String(args[6]));
      return [1, Number(args[9])];
    } else {
      if (this.values.get(key) !== String(args[5])) return -1;
      this.values.delete(key);
    }
    return 1;
  }
}

const request: SpectreCacheRequest = {
  key: 'whole-pr',
  systemPrompt: 'system',
  userPrompt: 'diff with secret source',
  responseSchema: { type: 'object' },
  sources: [{
    file: 'src/a.ts',
    newOid: 'b'.repeat(40),
    contentSha256: 'c'.repeat(64),
    changedLineRanges: [{ start: 1, end: 1 }],
  }],
};

function options(client: RedisCacheClient, overrides: Partial<SpectreCacheOptions> = {}): SpectreCacheOptions {
  return {
    client,
    context: { installationId: 10, repositoryId: 20, prNumber: 30, baseSha: 'base-sha' },
    provider: 'amazon-bedrock',
    model: 'qwen.test',
    modelApi: 'bedrock-converse-stream',
    maxOutputTokens: 1_200,
    config: {
      enabled: true,
      provider: 'amazon-bedrock',
      model: 'qwen.test',
      minSeverity: 'high',
      astSignals: { mode: 'off', maxFiles: 100, maxTotalBytes: 2 * 1024 * 1024, timeoutSeconds: 3 },
      cache: { enabled: true, positiveTtlSeconds: 86_400, negativeTtlSeconds: 3_600 },
    },
    mode: 'read-write',
    hmacKey: 'test-cache-signing-key',
    maxBytes: 1024 * 1024,
    buildVersion: 'test-build',
    epoch: '1',
    now: () => 1_000_000,
    ...overrides,
  };
}

describe('RedisSpectreResponseCache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('round-trips a signed positive response without exposing request content in the key', async () => {
    const redis = new FakeRedis();
    const cache = new RedisSpectreResponseCache(options(redis));

    await cache.write(request, '{"findings":[{"file":"src/a.ts"}]}', 'positive');

    expect(await cache.read(request)).toMatchObject({
      text: '{"findings":[{"file":"src/a.ts"}]}',
      resultClass: 'positive',
      agreements: 1,
    });
    const key = [...redis.values.keys()][0]!;
    expect(key).toMatch(/^layne:\{spectre-cache:v1\}:10:20:30:[0-9a-f]{64}$/);
    expect(key).not.toContain('secret source');
    expect(key).not.toContain('src/a.ts');
  });

  it('includes structural routing configuration in cache identity', async () => {
    const offRedis = new FakeRedis();
    const enabledRedis = new FakeRedis();
    const base = options(offRedis);
    const off = new RedisSpectreResponseCache({
      ...base,
      config: { ...base.config, astSignals: { mode: 'off', maxFiles: 100, maxTotalBytes: 2 * 1024 * 1024, timeoutSeconds: 3 } },
    });
    const enabled = new RedisSpectreResponseCache({
      ...base,
      client: enabledRedis,
      config: { ...base.config, astSignals: { mode: 'enabled', maxFiles: 100, maxTotalBytes: 2 * 1024 * 1024, timeoutSeconds: 3 } },
    });

    await off.write(request, '{"findings":[]}', 'negative');
    await enabled.write(request, '{"findings":[]}', 'negative');

    expect([...offRedis.values.keys()][0]).not.toBe([...enabledRedis.values.keys()][0]);
  });

  it('requires two matching live writes before a negative entry has two agreements', async () => {
    const redis = new FakeRedis();
    const cache = new RedisSpectreResponseCache(options(redis));

    await cache.write(request, '{"findings":[]}', 'negative');
    expect((await cache.read(request))?.agreements).toBe(1);

    await cache.write(request, '{"findings":[]}', 'negative');
    expect(await cache.read(request)).toMatchObject({ resultClass: 'negative', agreements: 2 });
  });

  it('never lets a concurrent negative overwrite a positive result', async () => {
    const redis = new FakeRedis();
    const positive = new RedisSpectreResponseCache(options(redis));
    const negative = new RedisSpectreResponseCache(options(redis));

    await Promise.all([
      positive.write(request, '{"findings":[{"file":"src/a.ts"}]}', 'positive'),
      negative.write(request, '{"findings":[]}', 'negative'),
    ]);

    expect(await positive.read(request)).toMatchObject({ resultClass: 'positive', agreements: 1 });
  });

  it('converges concurrent positive writes on the finding superset', async () => {
    const redis = new FakeRedis();
    const first = new RedisSpectreResponseCache(options(redis));
    const second = new RedisSpectreResponseCache(options(redis));
    const weaker = '{"findings":[{"file":"src/a.ts","ruleId":"backdoor"}]}';
    const stronger = '{"findings":[{"file":"src/a.ts","ruleId":"backdoor"},{"file":"src/b.ts","ruleId":"covert-execution"}]}';

    await Promise.all([
      first.write(request, stronger, 'positive'),
      second.write(request, weaker, 'positive'),
    ]);

    expect((await first.read(request))?.text).toBe(stronger);
  });

  it('does not let stale invalidation delete a newer entry', async () => {
    const redis = new FakeRedis();
    const cache = new RedisSpectreResponseCache(options(redis));
    await cache.write(request, '{"findings":[]}', 'negative');
    const stale = await cache.read(request);
    await cache.write(request, '{"findings":[]}', 'negative');

    await cache.invalidate(request, stale?.validationToken);

    expect(await cache.read(request)).toMatchObject({ resultClass: 'negative', agreements: 2 });
  });

  it('rejects tampering and deletes the invalid entry', async () => {
    const redis = new FakeRedis();
    const cache = new RedisSpectreResponseCache(options(redis));
    await cache.write(request, '{"findings":[]}', 'negative');
    const key = [...redis.values.keys()][0]!;
    redis.values.set(key, redis.values.get(key)!.replace('{\\"findings\\":[]}', '{\\"findings\\":[1]}'));

    expect(await cache.read(request)).toBeNull();
    expect(redis.values.has(key)).toBe(false);
  });

  it('changes identity when source, model, scope, build, or epoch changes', async () => {
    const redis = new FakeRedis();
    const variants = [
      options(redis),
      options(redis, { model: 'qwen.other' }),
      options(redis, { context: { installationId: 10, repositoryId: 21, prNumber: 30, baseSha: 'base-sha' } }),
      options(redis, { buildVersion: 'next-build' }),
      options(redis, { epoch: '2' }),
    ];
    for (const variant of variants) {
      await new RedisSpectreResponseCache(variant).write(request, '{"findings":[]}', 'negative');
    }
    const changedSource = {
      ...request,
      sources: [{ ...request.sources[0]!, newOid: 'd'.repeat(40) }],
    };
    await new RedisSpectreResponseCache(options(redis)).write(changedSource, '{"findings":[]}', 'negative');

    expect(redis.values.size).toBe(6);
  });

  it('fails open when Redis reads and writes fail', async () => {
    const redis = new FakeRedis();
    const cache = new RedisSpectreResponseCache(options(redis));
    redis.failReads = true;

    await expect(cache.read(request)).resolves.toBeNull();
    redis.failReads = false;
    redis.failWrites = true;
    await expect(cache.write(request, '{"findings":[]}', 'negative')).resolves.toBeUndefined();
  });

  it('does not read entries in write-only mode', async () => {
    const redis = new FakeRedis();
    const writer = new RedisSpectreResponseCache(options(redis));
    await writer.write(request, '{"findings":[]}', 'negative');
    const writeOnly = new RedisSpectreResponseCache(options(redis, { mode: 'write-only' }));

    await expect(writeOnly.read(request)).resolves.toBeNull();
  });

  it('rejects expired entries even when their Redis TTL has not been applied by a fake backend', async () => {
    const redis = new FakeRedis();
    let now = 1_000_000;
    const cache = new RedisSpectreResponseCache(options(redis, {
      now: () => now,
      config: {
        ...options(redis).config,
        cache: { enabled: true, positiveTtlSeconds: 60, negativeTtlSeconds: 60 },
      },
    }));
    await cache.write(request, '{"findings":[]}', 'negative');
    now += 61_000;

    await expect(cache.read(request)).resolves.toBeNull();
  });
});
