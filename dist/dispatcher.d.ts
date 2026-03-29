import type { ScanContext, LineRangesByFile, RawFinding } from './types.js';
export declare function dispatch({ scanContext, changedLineRanges, owner, repo }: {
    scanContext: ScanContext;
    changedLineRanges: LineRangesByFile;
    owner: string;
    repo: string;
}): Promise<RawFinding[]>;
//# sourceMappingURL=dispatcher.d.ts.map