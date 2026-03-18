import { describe, it, expect } from 'vitest';
import { buildAnnotations } from '../reporter.js';

function finding(overrides = {}) {
  const line = overrides.line ?? overrides.startLine ?? 10;
  return {
    file:     'src/app.js',
    line,
    startLine: overrides.startLine ?? line,
    endLine: overrides.endLine ?? overrides.startLine ?? line,
    severity: 'high',
    message:  'Hardcoded secret detected',
    ruleId:   'trufflehog/aws-key',
    tool:     'trufflehog',
    ...overrides,
  };
}

describe('buildAnnotations()', () => {
  describe('conclusion', () => {
    it('returns success when there are no findings', () => {
      const { conclusion } = buildAnnotations([]);
      expect(conclusion).toBe('success');
    });

    it('returns success when all findings are medium or below', () => {
      const { conclusion } = buildAnnotations([
        finding({ severity: 'medium' }),
        finding({ severity: 'low' }),
        finding({ severity: 'info' }),
      ]);
      expect(conclusion).toBe('success');
    });

    it('returns failure when there is a high severity finding', () => {
      const { conclusion } = buildAnnotations([finding({ severity: 'high' })]);
      expect(conclusion).toBe('failure');
    });

    it('returns failure when there is a critical severity finding', () => {
      const { conclusion } = buildAnnotations([finding({ severity: 'critical' })]);
      expect(conclusion).toBe('failure');
    });

    it('returns failure when critical and low findings are mixed', () => {
      const { conclusion } = buildAnnotations([
        finding({ severity: 'critical' }),
        finding({ severity: 'low' }),
      ]);
      expect(conclusion).toBe('failure');
    });
  });

  describe('summary', () => {
    it('returns a clean message when there are no findings', () => {
      const { summary } = buildAnnotations([]);
      expect(summary).toBe('No issues found.');
    });

    it('includes counts per severity in the summary', () => {
      const findings = [
        finding({ severity: 'critical' }),
        finding({ severity: 'high' }),
        finding({ severity: 'high' }),
        finding({ severity: 'medium' }),
      ];
      const { summary } = buildAnnotations(findings);
      expect(summary).toContain('1 critical');
      expect(summary).toContain('2 high');
      expect(summary).toContain('1 medium');
      expect(summary).toContain('0 low');
    });
  });

  describe('annotations', () => {
    it('maps each finding to a GitHub annotation object', () => {
      const [annotation] = buildAnnotations([finding()]).annotations;

      expect(annotation).toMatchObject({
        path:             'src/app.js',
        start_line:       10,
        end_line:         10,
        annotation_level: 'failure',
        title:            '[trufflehog] trufflehog/aws-key',
        message:          'Hardcoded secret detected',
      });
    });

    it('maps critical → failure annotation level', () => {
      const [a] = buildAnnotations([finding({ severity: 'critical' })]).annotations;
      expect(a.annotation_level).toBe('failure');
    });

    it('maps high → failure annotation level', () => {
      const [a] = buildAnnotations([finding({ severity: 'high' })]).annotations;
      expect(a.annotation_level).toBe('failure');
    });

    it('maps medium → warning annotation level', () => {
      const [a] = buildAnnotations([finding({ severity: 'medium' })]).annotations;
      expect(a.annotation_level).toBe('warning');
    });

    it('maps low → notice annotation level', () => {
      const [a] = buildAnnotations([finding({ severity: 'low' })]).annotations;
      expect(a.annotation_level).toBe('notice');
    });

    it('maps info → notice annotation level', () => {
      const [a] = buildAnnotations([finding({ severity: 'info' })]).annotations;
      expect(a.annotation_level).toBe('notice');
    });

    it('maps unknown severity → notice annotation level', () => {
      const [a] = buildAnnotations([finding({ severity: 'something-unknown' })]).annotations;
      expect(a.annotation_level).toBe('notice');
    });

    it('returns an empty array when there are no findings', () => {
      const { annotations } = buildAnnotations([]);
      expect(annotations).toHaveLength(0);
    });

    it('produces one annotation per finding', () => {
      const findings = [finding(), finding({ line: 20 }), finding({ line: 30 })];
      const { annotations } = buildAnnotations(findings);
      expect(annotations).toHaveLength(3);
    });

    it('uses startLine/endLine when a finding spans multiple lines', () => {
      const [annotation] = buildAnnotations([finding({
        line: 20,
        startLine: 20,
        endLine: 24,
      })]).annotations;

      expect(annotation.start_line).toBe(20);
      expect(annotation.end_line).toBe(24);
    });

    it('uses annotationStartLine/annotationEndLine when present', () => {
      const [annotation] = buildAnnotations([finding({
        line: 20,
        startLine: 20,
        endLine: 24,
        annotationStartLine: 20,
        annotationEndLine: 20,
      })]).annotations;

      expect(annotation.start_line).toBe(20);
      expect(annotation.end_line).toBe(20);
    });

    it('skips findings that are not eligible for inline annotations', () => {
      const { annotations, summary } = buildAnnotations([
        finding(),
        finding({
          line: 30,
          startLine: 30,
          endLine: 30,
          annotationEligible: false,
        }),
      ]);

      expect(annotations).toHaveLength(1);
      expect(summary).toContain('1 finding(s) could not be placed inline.');
    });
  });
});
