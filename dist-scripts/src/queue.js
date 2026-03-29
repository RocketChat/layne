import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
// maxRetriesPerRequest: null is required by BullMQ — it disables the default
// per-request retry limit so long-running jobs don't get killed mid-scan.
export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});
export const scanQueue = new Queue('scans', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: redis,
    defaultJobOptions: {
        attempts: 2, // Retry once on failure before marking the job dead
        backoff: {
            type: 'fixed',
            delay: 5000, // Wait 5 seconds before retrying
        },
        removeOnComplete: 100, // Keep the last 100 completed jobs for inspection
        removeOnFail: 200, // Keep the last 200 failed jobs for debugging
    },
});
//# sourceMappingURL=queue.js.map