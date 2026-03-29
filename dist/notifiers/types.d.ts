import type { ProcessedFinding, NotifierConfig } from '../types.js';
export interface ExceptionApprovalInfo {
    approved: boolean;
    approver?: string;
    reason?: string;
    findingIds?: string[];
}
/** Params passed to the top-level notify() orchestrator */
export interface NotifyOrchestratorParams {
    findings: ProcessedFinding[];
    owner: string;
    repo: string;
    prNumber: number;
    notificationConfig: Record<string, NotifierConfig>;
    exceptionApproval?: ExceptionApprovalInfo | null;
}
/** Params passed to each individual notifier implementation */
export interface NotifyParams {
    findings: ProcessedFinding[];
    owner: string;
    repo: string;
    prNumber: number;
    toolConfig: NotifierConfig;
    exceptionApproval?: ExceptionApprovalInfo | null;
}
/** Contract for individual notifier implementations */
export interface Notifier {
    notify(params: NotifyParams): Promise<void>;
}
//# sourceMappingURL=types.d.ts.map