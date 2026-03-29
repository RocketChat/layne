import type { ClaudeConfig, ClaudeRawFinding, LineRangesByFile, LineRange } from '../types.js';
/**
 * Runs Claude against the files changed in the PR and returns findings
 * in the common format: { file, line, severity, message, ruleId, tool }.
 */
export declare function runClaude({ workspacePath, changedFiles, changedLineRanges, promptFiles, toolConfig, }: {
    workspacePath: string;
    changedFiles?: string[] | null;
    changedLineRanges?: LineRangesByFile | Record<string, LineRange[]>;
    promptFiles?: Array<{
        file: string;
        content: string;
    }>;
    toolConfig?: ClaudeConfig;
}): Promise<ClaudeRawFinding[]>;
//# sourceMappingURL=claude.d.ts.map