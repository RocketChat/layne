import { describe, it, expect, vi } from 'vitest';

const mockQueue = { name: '', opts: {} };
const MockQueue = vi.fn().mockImplementation((name, opts) => {
  mockQueue.name = name;
  mockQueue.opts = opts;
  return mockQueue;
});

const mockRedisInstance = {};
const MockIORedis = vi.fn().mockImplementation(() => mockRedisInstance);

vi.mock('bullmq',   () => ({ Queue: MockQueue }));
vi.mock('ioredis',  () => ({ default: MockIORedis }));

await import('../queue.js');

describe('queue setup', () => {
  it('creates the Redis connection with maxRetriesPerRequest: null', () => {
    expect(MockIORedis).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxRetriesPerRequest: null })
    );
  });

  it('creates a queue named "scans"', () => {
    expect(MockQueue).toHaveBeenCalledWith('scans', expect.any(Object));
  });

  it('configures jobs to retry once on failure', () => {
    const opts = MockQueue.mock.calls[0][1];
    expect(opts.defaultJobOptions.attempts).toBe(2);
  });

  it('uses a fixed backoff strategy', () => {
    const opts = MockQueue.mock.calls[0][1];
    expect(opts.defaultJobOptions.backoff.type).toBe('fixed');
  });
});
