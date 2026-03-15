import { describe, it, expect } from 'vitest';
import { buildContext, renderTemplate } from '../../notifiers/template.js';

const FINDING_CRITICAL = { file: 'a.js', line: 1, severity: 'critical', message: 'critical', ruleId: 'r/c', tool: 'semgrep' };
const FINDING_HIGH     = { file: 'b.js', line: 2, severity: 'high',     message: 'high',     ruleId: 'r/h', tool: 'semgrep' };
const FINDING_MEDIUM   = { file: 'c.js', line: 3, severity: 'medium',   message: 'medium',   ruleId: 'r/m', tool: 'semgrep' };
const FINDING_LOW      = { file: 'd.js', line: 4, severity: 'low',      message: 'low',      ruleId: 'r/l', tool: 'semgrep' };

describe('buildContext()', () => {
  it('sets repo to owner/repoName', () => {
    const ctx = buildContext([], 'acme', 'payments', 42);
    expect(ctx.repo).toBe('acme/payments');
  });

  it('sets owner and repoName separately', () => {
    const ctx = buildContext([], 'acme', 'payments', 42);
    expect(ctx.owner).toBe('acme');
    expect(ctx.repoName).toBe('payments');
  });

  it('sets prNumber', () => {
    const ctx = buildContext([], 'acme', 'payments', 42);
    expect(ctx.prNumber).toBe(42);
  });

  it('sets prUrl', () => {
    const ctx = buildContext([], 'acme', 'payments', 42);
    expect(ctx.prUrl).toBe('https://github.com/acme/payments/pull/42');
  });

  it('counts findings by severity', () => {
    const ctx = buildContext([FINDING_CRITICAL, FINDING_HIGH, FINDING_HIGH, FINDING_MEDIUM, FINDING_LOW], 'o', 'r', 1);
    expect(ctx.critical).toBe(1);
    expect(ctx.high).toBe(2);
    expect(ctx.medium).toBe(1);
    expect(ctx.low).toBe(1);
  });

  it('sets total to findings.length', () => {
    const ctx = buildContext([FINDING_HIGH, FINDING_MEDIUM], 'o', 'r', 1);
    expect(ctx.total).toBe(2);
  });

  it('sets total to 0 with no findings', () => {
    const ctx = buildContext([], 'o', 'r', 1);
    expect(ctx.total).toBe(0);
    expect(ctx.critical).toBe(0);
    expect(ctx.high).toBe(0);
    expect(ctx.medium).toBe(0);
    expect(ctx.low).toBe(0);
  });

  it('builds summary with nonzero counts', () => {
    const ctx = buildContext([FINDING_HIGH, FINDING_MEDIUM], 'o', 'r', 1);
    expect(ctx.summary).toBe('Found 2 issue(s): 1 high, 1 medium.');
  });

  it('builds summary with "none" when no findings', () => {
    const ctx = buildContext([], 'o', 'r', 1);
    expect(ctx.summary).toBe('Found 0 issue(s): none.');
  });

  it('ignores unknown severity values in counts', () => {
    const unknownSev = { ...FINDING_HIGH, severity: 'info' };
    const ctx = buildContext([unknownSev], 'o', 'r', 1);
    expect(ctx.high).toBe(0);
    expect(ctx.total).toBe(1); // total still counts all findings
  });
});

describe('renderTemplate()', () => {
  it('substitutes a known placeholder', () => {
    expect(renderTemplate('hello {{repo}}', { repo: 'acme/payments' })).toBe('hello acme/payments');
  });

  it('substitutes multiple placeholders', () => {
    const result = renderTemplate('{{owner}}/{{repoName}} #{{prNumber}}', {
      owner: 'acme', repoName: 'payments', prNumber: 42,
    });
    expect(result).toBe('acme/payments #42');
  });

  it('leaves unknown placeholders unchanged', () => {
    expect(renderTemplate('{{unknown}}', { repo: 'acme/payments' })).toBe('{{unknown}}');
  });

  it('substitutes the same placeholder multiple times', () => {
    expect(renderTemplate('{{repo}} and {{repo}}', { repo: 'x' })).toBe('x and x');
  });

  it('returns the template unchanged when there are no placeholders', () => {
    expect(renderTemplate('no placeholders here', {})).toBe('no placeholders here');
  });
});
