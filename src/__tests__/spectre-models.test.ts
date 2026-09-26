import { describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-ai', () => ({
  createModels: () => ({
    setProvider: vi.fn(),
    getModel: (provider: string, id: string) => id === 'vendor.model-v1'
      ? { id, provider, api: 'bedrock-converse-stream', contextWindow: 100_000 }
      : undefined,
  }),
}));
const { getSpectreModel } = await import('../spectre-models.js');

describe('Spectre model registry', () => {
  it.each(['us', 'eu', 'apac', 'global'])('resolves a cataloged Bedrock model through a %s profile', prefix => {
    expect(getSpectreModel('amazon-bedrock', `${prefix}.vendor.model-v1`)).toMatchObject({
      id: `${prefix}.vendor.model-v1`, provider: 'amazon-bedrock', contextWindow: 100_000,
    });
  });

  it('does not manufacture unknown models or profiles for other providers', () => {
    expect(getSpectreModel('amazon-bedrock', 'us.unknown')).toBeUndefined();
    expect(getSpectreModel('openai', 'us.vendor.model-v1')).toBeUndefined();
  });
});
