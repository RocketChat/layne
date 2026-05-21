import { describe, it, expect } from 'vitest';
import { validateConfig } from '../config-validator.js';

describe('validateConfig()', () => {
  describe('$global scanner keys', () => {
    it('accepts $global.semgrep without flagging it as an unknown key', () => {
      const result = validateConfig({
        '$global': { semgrep: { extraArgs: ['--config', 'p/owasp-top-ten'] } },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts $global.trufflehog without flagging it as an unknown key', () => {
      const result = validateConfig({
        '$global': { trufflehog: { enabled: false } },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts $global.claude without flagging it as an unknown key', () => {
      const result = validateConfig({
        '$global': { claude: { enabled: true, model: 'claude-sonnet-4-6' } },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts $global.piAgent without flagging it as an unknown key', () => {
      const result = validateConfig({
        '$global': { piAgent: { enabled: false, model: 'claude-opus-4-6' } },
      });
      expect(result.valid).toBe(true);
    });

    it('still rejects a genuinely unknown key in $global', () => {
      const result = validateConfig({
        '$global': { typo_key: true },
      });
      expect(result.valid).toBe(false);
      expect((result as { valid: false; errors: string[] }).errors[0]).toMatch(/unknown key/);
    });

    it('validates the contents of $global.semgrep (rejects bad extraArgs)', () => {
      const result = validateConfig({
        '$global': { semgrep: { extraArgs: [123] } },
      });
      expect(result.valid).toBe(false);
      expect((result as { valid: false; errors: string[] }).errors[0]).toMatch(/extraArgs/);
    });

    it('validates the contents of $global.claude (rejects non-claude model)', () => {
      const result = validateConfig({
        '$global': { claude: { enabled: true, model: 'gpt-4o' } },
      });
      expect(result.valid).toBe(false);
      expect((result as { valid: false; errors: string[] }).errors[0]).toMatch(/model/);
    });
  });

  describe('validateLabels — removeOnException', () => {
    it('accepts labels.removeOnException as a valid key', () => {
      const result = validateConfig({
        'acme/app': { labels: { removeOnException: ['security-exception'] } },
      });
      expect(result.valid).toBe(true);
    });

    it('rejects labels.removeOnException when not an array', () => {
      const result = validateConfig({
        'acme/app': { labels: { removeOnException: 'security-exception' } },
      });
      expect(result.valid).toBe(false);
      expect((result as { valid: false; errors: string[] }).errors[0]).toMatch(/removeOnException/);
    });

    it('rejects labels.removeOnException when items are not strings', () => {
      const result = validateConfig({
        'acme/app': { labels: { removeOnException: [42] } },
      });
      expect(result.valid).toBe(false);
      expect((result as { valid: false; errors: string[] }).errors[0]).toMatch(/removeOnException/);
    });
  });
});
