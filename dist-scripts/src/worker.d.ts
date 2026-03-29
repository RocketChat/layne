import 'dotenv/config';
import type { Job } from 'bullmq';
import type { JobData } from './types.js';
/**
 * Core job processor — exported so tests can invoke it directly
 * without needing a live BullMQ worker or Redis connection.
 */
export declare function processJob(job: Job<JobData>): Promise<void>;
export declare function shutdown(): Promise<void>;
//# sourceMappingURL=worker.d.ts.map