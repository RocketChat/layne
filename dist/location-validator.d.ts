import type { ProcessedFinding } from './types.js';
export declare function validateFindingLocations(findings: ProcessedFinding[], { workspacePath, changedFiles }: {
    workspacePath: string;
    changedFiles?: string[];
}): Promise<ProcessedFinding[]>;
//# sourceMappingURL=location-validator.d.ts.map