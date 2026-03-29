/**
 * Shared template helpers used by all notifiers and the PR commenter.
 */
import type { ProcessedFinding, TemplateContext } from '../types.js';
export declare function buildContext(findings: ProcessedFinding[], owner: string, repo: string, prNumber: number): TemplateContext;
export declare function renderTemplate(template: string, ctx: TemplateContext): string;
//# sourceMappingURL=template.d.ts.map