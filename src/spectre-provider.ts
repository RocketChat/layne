import type { SpectreConfig } from './types.js';

export const SPECTRE_PROVIDERS = ['anthropic', 'openai', 'google', 'mistral', 'amazon-bedrock'] as const;
export type SpectreProvider = typeof SPECTRE_PROVIDERS[number];

const PROVIDER_SET = new Set<string>(SPECTRE_PROVIDERS);

export function isSpectreProvider(value: string): value is SpectreProvider {
  return PROVIDER_SET.has(value);
}

export function validateSpectreProviderConfig(config: SpectreConfig, env = process.env): string | null {
  if (!config.enabled) return null;
  if (!config.provider?.trim()) return 'enabled Spectre requires a provider';
  if (!isSpectreProvider(config.provider)) return `unsupported Spectre provider: ${config.provider}`;
  if (!config.model?.trim()) return 'enabled Spectre requires a model';

  const credentialByProvider: Partial<Record<SpectreProvider, string>> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GEMINI_API_KEY',
    mistral: 'MISTRAL_API_KEY',
  };
  const requiredCredential = credentialByProvider[config.provider];

  if (requiredCredential && !env[requiredCredential]) {
    return `${requiredCredential} is required for Spectre provider ${config.provider}`;
  }

  // Bedrock may use bearer auth, static IAM credentials, or the standard AWS
  // credential chain. Region is always needed to resolve the endpoint.
  if (config.provider === 'amazon-bedrock' && !env.AWS_REGION && !env.AWS_DEFAULT_REGION) {
    return 'AWS_REGION or AWS_DEFAULT_REGION is required for Spectre provider amazon-bedrock';
  }

  return null;
}
