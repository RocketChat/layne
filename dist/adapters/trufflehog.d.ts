import type { TrufflehogConfig, TrufflehogFinding } from '../types.js';
export declare function runTrufflehog({ workspacePath, changedFiles, toolConfig, }: {
    workspacePath: string;
    changedFiles?: string[] | null;
    toolConfig?: TrufflehogConfig;
}): Promise<TrufflehogFinding[]>;
//# sourceMappingURL=trufflehog.d.ts.map