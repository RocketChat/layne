import { describe, expect, it } from 'vitest';
import { validateConfig } from '../config-validator.js';

describe('notification config validation', () => {
  it('accepts notification event policy and templates', () => {
    expect(validateConfig({
      '$global': {
        notifications: {
          rocketchat: {
            enabled: true,
            notifyOn: ['findings', 'coverage-failure', 'incomplete-scan', 'internal-error', 'exception-approval'],
            minFindingSeverity: 'high',
            templates: { 'incomplete-scan': '{{coverageSummary}}' },
          },
        },
      },
    })).toEqual({ valid: true });
  });

  it('rejects unknown notification events', () => {
    const result = validateConfig({ '$global': { notifications: { slack: { enabled: true, notifyOn: ['everything'] } } } });
    expect(result.valid).toBe(false);
  });

  it('rejects invalid minimum finding severity', () => {
    const result = validateConfig({ '$global': { notifications: { slack: { enabled: true, minFindingSeverity: 'urgent' } } } });
    expect(result.valid).toBe(false);
  });

  it('rejects array notifier blocks and unknown policy keys', () => {
    expect(validateConfig({ '$global': { notifications: { slack: [] } } }).valid).toBe(false);
    expect(validateConfig({ '$global': { notifications: { slack: { enabled: true, notifyWhen: [] } } } }).valid).toBe(false);
  });
});

describe('lockfile size config validation', () => {
  it('accepts global and repo lockfile limits', () => {
    expect(validateConfig({
      '$global': { maxLockfileSizeKb: 4096 },
      'acme/repo': { maxLockfileSizeKb: 8192 },
    })).toEqual({ valid: true });
  });

  it('rejects non-positive and fractional lockfile limits', () => {
    expect(validateConfig({ '$global': { maxLockfileSizeKb: 0 } }).valid).toBe(false);
    expect(validateConfig({ 'acme/repo': { maxLockfileSizeKb: 1.5 } }).valid).toBe(false);
  });
});

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

describe('Spectre cache config validation', () => {
  it('accepts bounded cache policy', () => {
    expect(validateConfig({
      '$global': { spectre: { cache: { enabled: true, positiveTtlSeconds: 86_400, negativeTtlSeconds: 3_600 } } },
    })).toEqual({ valid: true });
  });

  it('rejects unknown keys and out-of-range TTLs', () => {
    expect(validateConfig({ '$global': { spectre: { cache: { ttl: 10 } } } }).valid).toBe(false);
    expect(validateConfig({ '$global': { spectre: { cache: { negativeTtlSeconds: 10 } } } }).valid).toBe(false);
  });
});

describe('Spectre file cap config validation', () => {
  it('accepts the primary and secondary hard maxima', () => {
    expect(validateConfig({
      'acme/repo': { spectre: { fileCap: 30, secondaryFileCap: 50 } },
    })).toEqual({ valid: true });
  });

  it('rejects file caps above their hard maxima', () => {
    expect(validateConfig({ 'acme/repo': { spectre: { fileCap: 31 } } }).valid).toBe(false);
    expect(validateConfig({ 'acme/repo': { spectre: { secondaryFileCap: 51 } } }).valid).toBe(false);
  });
});

describe('Spectre AST signal config validation', () => {
  it('accepts bounded global and repository settings', () => {
    expect(validateConfig({
      '$global': { spectre: { astSignals: { mode: 'shadow', maxFiles: 500 } } },
      'acme/repo': { spectre: { astSignals: { mode: 'enabled', maxTotalBytes: 64 * 1024 * 1024, timeoutSeconds: 30 } } },
    })).toEqual({ valid: true });
  });

  it('rejects unknown nested keys, invalid modes, and values above hard bounds', () => {
    expect(validateConfig({ '$global': { spectre: { astSignals: { parser: 'tree-sitter' } } } }).valid).toBe(false);
    expect(validateConfig({ '$global': { spectre: { astSignals: { mode: 'active' } } } }).valid).toBe(false);
    expect(validateConfig({ '$global': { spectre: { astSignals: { maxFiles: 501 } } } }).valid).toBe(false);
    expect(validateConfig({ '$global': { spectre: { astSignals: { maxTotalBytes: 64 * 1024 * 1024 + 1 } } } }).valid).toBe(false);
    expect(validateConfig({ '$global': { spectre: { astSignals: { timeoutSeconds: 0 } } } }).valid).toBe(false);
  });
});
