import type { ModelDescriptor, ModelProvider, ModelTier } from './types.js';

/**
 * EXAMPLE CATALOG — NOT A PRICE LIST.
 *
 * The model ids, context windows and per-token prices below are a snapshot
 * taken when this code was written. Prices change often and model ids are
 * retired; treat every number here as stale and bring your own catalog with
 * `createCatalog()` before relying on cost estimates.
 *
 * Provider-neutral model catalog.
 *
 * Gemini is intentionally first in each tier for inexpensive development and
 * smoke testing. Claude and OpenAI stay selectable so the exact same agent,
 * tools, formatting prompt, and trace can be compared across providers.
 *
 * GLM and DeepSeek are here for the same comparison at a fraction of the price:
 * DeepSeek's flash tier is roughly a fiftieth of Claude Sonnet on input, and
 * both carry the tool support the agent needs. Their prices below are the peak
 * rates -- DeepSeek charges half of these off-peak, so an estimate made from
 * this table is never an understatement.
 */
export const EXAMPLE_MODELS: readonly ModelDescriptor[] = [
  {
    id: 'gemini-3.5-flash-lite',
    provider: 'google',
    displayName: 'Gemini 3.5 Flash-Lite',
    tier: 'fast',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    inputCostPerMTok: 0.3,
    outputCostPerMTok: 2.5,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    tier: 'fast',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: false,
    supportsTools: true,
    supportsVision: true,
    inputCostPerMTok: 1,
    outputCostPerMTok: 5,
  },
  {
    id: 'gpt-5.6-luna',
    provider: 'openai',
    displayName: 'GPT-5.6 Luna',
    tier: 'fast',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    inputCostPerMTok: 1,
    outputCostPerMTok: 6,
  },
  {
    id: 'gemini-3.7-flash',
    provider: 'google',
    displayName: 'Gemini 3.7 Flash',
    tier: 'balanced',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    inputCostPerMTok: 0.75,
    outputCostPerMTok: 3.75,
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 5',
    tier: 'balanced',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
  },
  {
    id: 'gpt-5.6-terra',
    provider: 'openai',
    displayName: 'GPT-5.6 Terra',
    tier: 'balanced',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    inputCostPerMTok: 2.5,
    outputCostPerMTok: 15,
  },
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    displayName: 'Claude Opus 5',
    tier: 'deep',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    inputCostPerMTok: 5,
    outputCostPerMTok: 25,
  },
  {
    id: 'gpt-5.6-sol',
    provider: 'openai',
    displayName: 'GPT-5.6 Sol',
    tier: 'deep',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    inputCostPerMTok: 5,
    outputCostPerMTok: 30,
  },
  {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    displayName: 'DeepSeek V4 Flash',
    tier: 'fast',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: false,
    inputCostPerMTok: 0.44,
    outputCostPerMTok: 1.32,
  },
  {
    id: 'glm-4.7',
    provider: 'zhipu',
    displayName: 'GLM-4.7',
    tier: 'balanced',
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: false,
    inputCostPerMTok: 0.6,
    outputCostPerMTok: 2.2,
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    displayName: 'DeepSeek V4 Pro',
    tier: 'deep',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: false,
    inputCostPerMTok: 1.32,
    outputCostPerMTok: 3.96,
  },
  {
    id: 'glm-5',
    provider: 'zhipu',
    displayName: 'GLM-5',
    tier: 'deep',
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: false,
    inputCostPerMTok: 1.0,
    outputCostPerMTok: 3.2,
  },
] as const;

export const DEFAULT_MODEL_ID = 'gemini-3.7-flash';
/** The cheap model the example setup uses for the LLM classifier. */
export const CLASSIFIER_MODEL_ID = 'gemini-3.5-flash-lite';

export const TIER_ORDER: readonly ModelTier[] = ['fast', 'balanced', 'deep'] as const;

export const tierRank = (tier: ModelTier): number => TIER_ORDER.indexOf(tier);

export const capTier = (desired: ModelTier, ceiling: ModelTier): ModelTier =>
  tierRank(desired) <= tierRank(ceiling) ? desired : ceiling;

export const estimateCostUsd = (
  model: ModelDescriptor,
  inputTokens: number,
  outputTokens: number,
): number =>
  (inputTokens / 1_000_000) * model.inputCostPerMTok +
  (outputTokens / 1_000_000) * model.outputCostPerMTok;

/**
 * A set of models the policy may choose from. Catalog order matters: it is the
 * tie-breaker between equally priced models and the preference order when a
 * provider is unavailable.
 */
export interface Catalog {
  readonly models: readonly ModelDescriptor[];
  /** Used when the turn is unclassified or nothing else fits. */
  readonly defaultModelId: string;
  getModel(id: string): ModelDescriptor | undefined;
  modelsInTier(tier: ModelTier): ModelDescriptor[];
  modelsByProvider(provider: ModelProvider): ModelDescriptor[];
}

export function createCatalog(
  models: readonly ModelDescriptor[],
  options: { defaultModelId: string },
): Catalog {
  const byId = new Map(models.map((model) => [model.id, model]));
  return {
    models,
    defaultModelId: options.defaultModelId,
    getModel: (id) => byId.get(id),
    modelsInTier: (tier) => models.filter((model) => model.tier === tier),
    modelsByProvider: (provider) => models.filter((model) => model.provider === provider),
  };
}

export const EXAMPLE_CATALOG: Catalog = createCatalog(EXAMPLE_MODELS, {
  defaultModelId: DEFAULT_MODEL_ID,
});
