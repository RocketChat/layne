import type { ProcessedFinding, ReportResult } from './types.js';
/**
 * Converts raw tool findings into GitHub Check Run annotations
 * and decides the overall scan conclusion.
 */
export declare function buildAnnotations(findings: ProcessedFinding[]): ReportResult;
//# sourceMappingURL=reporter.d.ts.map