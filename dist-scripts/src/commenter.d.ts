import type { ProcessedFinding, CommentConfig } from './types.js';
/**
 * Creates or updates a Layne security comment on a PR.
 * Never throws.
 */
export declare function postComment({ findings, owner, repo, prNumber, installationId, conclusion, commentConfig }: {
    findings: ProcessedFinding[];
    owner: string;
    repo: string;
    prNumber: number;
    installationId: number;
    conclusion: string;
    commentConfig: CommentConfig & {
        warningTemplate?: string | null;
    };
}): Promise<void>;
//# sourceMappingURL=commenter.d.ts.map