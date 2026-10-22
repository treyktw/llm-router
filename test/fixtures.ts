import { createCatalog } from '../src/catalog.js';
import type { ModelDescriptor, RouteDecision, RoutingPreference, TurnClassification } from '../src/types.js';

/**
 * A small synthetic catalog so tests pin exact behaviour without depending on
 * the example catalog's (stale-by-design) prices.
 *
 * fast:     fast-cheap (no vision, no thinking, 100k)  fast-vision (vision, 1M)
 * balanced: bal-small (no tools, 50k)  bal-main (default)  bal-pricey
 * deep:     deep-novision  deep-main
 */
export const model = (overrides: Partial<ModelDescriptor> & Pick<ModelDescriptor, 'id' | 'tier'>): ModelDescriptor => ({
  provider: 'local',
  displayName: overrides.id,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  supportsThinking: true,
  supportsTools: true,
  supportsVision: true,
  inputCostPerMTok: 1,
  outputCostPerMTok: 1,
  ...overrides,
});

export const TEST_MODELS: ModelDescriptor[] = [
  model({ id: 'fast-vision', tier: 'fast', provider: 'google', inputCostPerMTok: 0.5 }),
  model({
    id: 'fast-cheap',
    tier: 'fast',
    provider: 'deepseek',
    inputCostPerMTok: 0.1,
    supportsVision: false,
    supportsThinking: false,
    contextWindow: 100_000,
    maxOutputTokens: 4_000,
  }),
  model({ id: 'bal-pricey', tier: 'balanced', provider: 'openai', inputCostPerMTok: 3 }),
  model({ id: 'bal-small', tier: 'balanced', provider: 'zhipu', inputCostPerMTok: 0.2, supportsTools: false, contextWindow: 50_000 }),
  model({ id: 'bal-main', tier: 'balanced', provider: 'google', inputCostPerMTok: 1 }),
  model({ id: 'deep-main', tier: 'deep', provider: 'anthropic', inputCostPerMTok: 5 }),
  model({ id: 'deep-novision', tier: 'deep', provider: 'deepseek', inputCostPerMTok: 1.5, supportsVision: false }),
];

export const TEST_CATALOG = createCatalog(TEST_MODELS, { defaultModelId: 'bal-main' });

export const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');
export const fixedClock = () => FIXED_NOW;

export const classification = (overrides: Partial<TurnClassification> = {}): TurnClassification => ({
  intent: 'chat',
  complexity: 'standard',
  domain: null,
  needsRetrieval: false,
  needsTools: false,
  needsVision: false,
  longContext: false,
  confidence: 0.9,
  rationale: 'synthetic',
  ...overrides,
});

export const preference = (overrides: Partial<RoutingPreference> = {}): RoutingPreference => ({
  mode: 'auto',
  pinnedModelId: null,
  maxTier: 'deep',
  allowThinking: true,
  ...overrides,
});

export const priorDecision = (overrides: Partial<RouteDecision> = {}): RouteDecision => ({
  modelId: 'bal-main',
  tier: 'balanced',
  mode: 'auto',
  effort: 'medium',
  thinking: true,
  maxOutputTokens: 32_000,
  reason: 'previous turn',
  classification: classification(),
  switchedFrom: null,
  rejected: [],
  decidedAt: FIXED_NOW.toISOString(),
  classifyMs: 10,
  ...overrides,
});
