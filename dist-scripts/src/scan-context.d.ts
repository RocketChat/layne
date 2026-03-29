import type { ScanContext, ScanConfig } from './types.js';
export declare function createScanContext({ workspacePath, changedFiles, baseSha, headSha, scanConfig }: {
    workspacePath: string;
    changedFiles: string[];
    baseSha: string;
    headSha: string;
    scanConfig?: Partial<ScanConfig>;
}): Promise<ScanContext>;
export declare function filterFindingsToChangedLines<T extends {
    file: string;
    line?: number;
}>(findings: T[], scanContext?: ScanContext | null): T[];
//# sourceMappingURL=scan-context.d.ts.map