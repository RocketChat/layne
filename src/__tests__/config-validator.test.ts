import { describe, expect, it } from 'vitest';
import { validateConfig } from '../config-validator.js';

describe('trigger draft config validation', () => {
  it('accepts scanOnDraft for every trigger mode', () => {
    expect(validateConfig({ '$global': { trigger: { scanOnDraft: false } } })).toEqual({ valid: true });
    expect(validateConfig({ 'acme/run': { trigger: { on: 'workflow_run', workflow: 'CI', scanOnDraft: true } } })).toEqual({ valid: true });
    expect(validateConfig({ 'acme/job': { trigger: { on: 'workflow_job', job: 'test', scanOnDraft: true } } })).toEqual({ valid: true });
  });

  it('rejects non-boolean scanOnDraft values', () => {
    expect(validateConfig({ '$global': { trigger: { scanOnDraft: 'false' } } }).valid).toBe(false);
    expect(validateConfig({ 'acme/repo': { trigger: { scanOnDraft: null } } }).valid).toBe(false);
  });
});
