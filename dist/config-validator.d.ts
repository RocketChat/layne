/**
 * Validates the structure of a parsed layne.json object.
 *
 * Returns { valid: true } if the config is acceptable, or
 * { valid: false, errors: string[] } listing every problem found.
 *
 * This module has no dependencies and can be imported anywhere or run
 * directly via `npm run validate-config`.
 */
export type ValidateConfigResult = {
    valid: true;
} | {
    valid: false;
    errors: string[];
};
export declare function validateConfig(config: unknown): ValidateConfigResult;
//# sourceMappingURL=config-validator.d.ts.map