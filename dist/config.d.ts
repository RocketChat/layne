import type { ScanConfig } from './types.js';
export declare const DEFAULT_CONFIG: Readonly<ScanConfig>;
export declare function loadScanConfig({ owner, repo }: {
    owner: string;
    repo: string;
}): Promise<ScanConfig>;
//# sourceMappingURL=config.d.ts.map