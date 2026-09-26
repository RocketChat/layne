import { describe, expect, it } from 'vitest';
import {
  MAX_SPECTRE_EVIDENCE_LENGTH,
  MAX_SPECTRE_MESSAGE_LENGTH,
  createSpectreResponseSchema,
  parseSpectreResponse,
} from '../spectre-response.js';

const BASE_FINDING = {
  file: 'src/app.ts',
  severity: 'high',
  ruleId: 'backdoor',
  message: 'Hidden access path',
  evidence: 'openBackdoor();',
};

describe('Spectre response contract', () => {
  it('constrains structured output to exact chunk paths', () => {
    expect(createSpectreResponseSchema(['src/app.ts', 'scripts/install.ts'])).toMatchObject({
      properties: {
        findings: {
          maxItems: 6,
          items: {
            properties: {
              file: { enum: ['src/app.ts', 'scripts/install.ts'] },
              startLine: { type: ['integer', 'null'] },
              endLine: { type: ['integer', 'null'] },
            },
          },
        },
      },
    });
  });

  it('accepts nullable line hints introduced by strict schema adaptation', () => {
    const parsed = parseSpectreResponse(JSON.stringify({
      findings: [{ ...BASE_FINDING, startLine: null, endLine: null }],
    }), ['src/app.ts']);

    expect(parsed).toMatchObject({ validEnvelope: true, invalidFindings: 0 });
    expect(parsed.findings[0]).toMatchObject({ line: 1, startLine: 1, endLine: 1 });
    expect(parsed.findings[0]).not.toHaveProperty('reportedStartLine');
    expect(parsed.findings[0]).not.toHaveProperty('reportedEndLine');
  });

  it('preserves provider line hints separately from the compatibility location', () => {
    const parsed = parseSpectreResponse(JSON.stringify({
      findings: [{ ...BASE_FINDING, startLine: 7, endLine: 8 }],
    }), ['src/app.ts']);

    expect(parsed.findings[0]).toMatchObject({
      line: 7, startLine: 7, endLine: 8, reportedStartLine: 7, reportedEndLine: 8,
    });
  });

  it('retains valid siblings while counting invalid candidates', () => {
    const parsed = parseSpectreResponse(JSON.stringify({
      findings: [BASE_FINDING, { ...BASE_FINDING, file: 'outside.ts' }],
    }), ['src/app.ts']);

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.invalidFindings).toBe(1);
    expect(parsed.violations).toEqual([{ findingIndex: 1, code: 'invalid-file' }]);
  });

  it('reports safe field-level diagnostics without response values', () => {
    const sensitiveValue = 'do-not-log-this-value';
    const parsed = parseSpectreResponse(JSON.stringify({
      findings: [
        { ...BASE_FINDING, severity: sensitiveValue },
        { ...BASE_FINDING, message: 'm'.repeat(MAX_SPECTRE_MESSAGE_LENGTH + 1) },
        { ...BASE_FINDING, evidence: 'e'.repeat(MAX_SPECTRE_EVIDENCE_LENGTH + 1) },
        { ...BASE_FINDING, startLine: 0 },
        { ...BASE_FINDING, startLine: 5, endLine: 4 },
      ],
    }), ['src/app.ts', 'src/other.ts']);

    expect(parsed).toMatchObject({ candidateFindings: 5, invalidFindings: 5 });
    expect(parsed.violations).toEqual([
      { findingIndex: 0, code: 'invalid-severity' },
      { findingIndex: 1, code: 'message-too-long', actual: MAX_SPECTRE_MESSAGE_LENGTH + 1, maximum: MAX_SPECTRE_MESSAGE_LENGTH },
      { findingIndex: 2, code: 'evidence-too-long', actual: MAX_SPECTRE_EVIDENCE_LENGTH + 1, maximum: MAX_SPECTRE_EVIDENCE_LENGTH },
      { findingIndex: 3, code: 'invalid-start-line' },
      { findingIndex: 4, code: 'invalid-line-range' },
    ]);
    expect(JSON.stringify(parsed.violations)).not.toContain(sensitiveValue);
  });

  it('reports response and per-file limit violations', () => {
    const parsed = parseSpectreResponse(JSON.stringify({
      findings: Array.from({ length: 7 }, (_, index) => ({
        ...BASE_FINDING,
        file: index < 4 ? 'src/app.ts' : 'src/other.ts',
        evidence: `finding-${index}`,
      })),
    }), ['src/app.ts', 'src/other.ts']);

    expect(parsed).toMatchObject({ candidateFindings: 7, invalidFindings: 1, omittedFindings: 1 });
    expect(parsed.violations).toEqual([
      { findingIndex: 3, code: 'per-file-limit', actual: 4, maximum: 3 },
      { code: 'response-limit', actual: 7, maximum: 6 },
    ]);
  });
});
