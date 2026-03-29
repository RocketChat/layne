import type { ProcessedFinding, ExceptionData, ParsedCommand, ExceptionApproversConfig } from './types.js';
export declare function generateFindingId(finding: Pick<ProcessedFinding, 'tool' | 'file' | 'line' | 'startLine'>): string;
export declare function parseExceptionCommand(body: string | null | undefined): ParsedCommand | null;
export declare function storeExceptions({ owner, repo, prNumber, approvedHeadSha, findingIds, approver, reason }: {
    owner: string;
    repo: string;
    prNumber: number;
    approvedHeadSha: string;
    findingIds: string[];
    approver: string;
    reason: string;
}): Promise<void>;
export declare function loadExceptions({ owner, repo, prNumber, findingIds }: {
    owner: string;
    repo: string;
    prNumber: number;
    findingIds: string[];
}): Promise<Map<string, ExceptionData>>;
export declare function filterStaleExceptions({ exceptions, findings, workspacePath, currentHeadSha }: {
    exceptions: Map<string, ExceptionData>;
    findings: ProcessedFinding[];
    workspacePath: string;
    currentHeadSha: string;
}): Promise<Map<string, ExceptionData>>;
export declare function resolveDriftedExceptions({ unmatchedFindings, owner, repo, prNumber, workspacePath, currentHeadSha }: {
    unmatchedFindings: ProcessedFinding[];
    owner: string;
    repo: string;
    prNumber: number;
    workspacePath: string;
    currentHeadSha: string;
}): Promise<Map<string, ExceptionData>>;
export declare function buildExceptionSummary({ findings, exceptions, baseSummary }: {
    findings: ProcessedFinding[];
    exceptions: Map<string, ExceptionData>;
    baseSummary: string;
}): {
    conclusion: 'success' | 'failure';
    summary: string;
};
export declare function isReviewerAuthorized({ reviewer, config, installationId, owner }: {
    reviewer: string;
    config: ExceptionApproversConfig;
    installationId: number;
    owner: string;
}): Promise<boolean>;
//# sourceMappingURL=exception-approvals.d.ts.map