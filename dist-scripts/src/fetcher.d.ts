import type { LineRangesByFile, LineMap } from './types.js';
export declare function createWorkspace(jobId: string): Promise<string>;
export declare function setupRepo({ token, cloneUrl, headSha, baseSha, workspacePath }: {
    token: string;
    cloneUrl: string;
    headSha: string;
    baseSha: string;
    workspacePath: string;
}): Promise<void>;
export declare function getChangedFiles({ workspacePath, baseSha, headSha }: {
    workspacePath: string;
    baseSha: string;
    headSha: string;
}): Promise<string[]>;
export declare function getChangedLineRanges({ workspacePath, baseSha, headSha, files }: {
    workspacePath: string;
    baseSha: string;
    headSha: string;
    files?: string[];
}): Promise<LineRangesByFile>;
export declare function fetchCommit({ workspacePath, sha }: {
    workspacePath: string;
    sha: string;
}): Promise<void>;
export declare function checkoutFiles({ workspacePath, headSha, files }: {
    workspacePath: string;
    headSha: string;
    files: string[];
}): Promise<string[]>;
export declare function cleanupWorkspace(workspacePath: string): Promise<void>;
/**
 * Builds a Map<headLine, baseLine | null> for a single file by parsing the
 * unified diff between baseSha and headSha.
 */
export declare function buildLineMapForFile({ workspacePath, baseSha, headSha, filePath }: {
    workspacePath: string;
    baseSha: string;
    headSha: string;
    filePath: string;
}): Promise<LineMap>;
//# sourceMappingURL=fetcher.d.ts.map