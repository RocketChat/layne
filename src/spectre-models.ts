import {
  createModels,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelsApiStreamOptions,
} from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const models = createModels();

for (const provider of [
  amazonBedrockProvider(),
  anthropicProvider(),
  googleProvider(),
  mistralProvider(),
  openaiProvider(),
]) {
  models.setProvider(provider);
}

export function getSpectreModel(provider: string, modelId: string): Model<Api> | undefined {
  const model = models.getModel(provider, modelId);
  if (model) return model;

  // Cross-region inference profiles retain the cataloged base model's capabilities.
  if (provider === 'amazon-bedrock' && /^(us|eu|apac|global)\./.test(modelId)) {
    const base = models.getModel(provider, modelId.replace(/^(us|eu|apac|global)\./, ''));
    return base ? { ...base, id: modelId } : undefined;
  }

  return undefined;
}

export function completeSpectreModel(
  model: Model<Api>,
  context: Context,
  options: ModelsApiStreamOptions<Api>,
): Promise<AssistantMessage> {
  return models.complete(model, context, options);
}
