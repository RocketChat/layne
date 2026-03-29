import type { ProcessedFinding } from './types.js';
/**
 * Suppresses findings that already have a `// SECURITY: <reason>` comment at
 * the base SHA.
 */
export declare function suppressFindings(findings: ProcessedFinding[], { workspacePath, baseSha, headSha }: {
    workspacePath: string;
    baseSha: string;
    headSha: string;
}): Promise<ProcessedFinding[]>;
//# sourceMappingURL=suppressor.d.ts.map