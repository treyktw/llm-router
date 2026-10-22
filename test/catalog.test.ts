import { describe, expect, it } from 'vitest';
import {
  capTier,
  DEFAULT_MODEL_ID,
  CLASSIFIER_MODEL_ID,
  estimateCostUsd,
  EXAMPLE_CATALOG,
  EXAMPLE_MODELS,
  tierRank,
} from '../src/catalog.js';
import { ModelDescriptor } from '../src/types.js';

describe('example catalog', () => {
  it('every entry is a valid ModelDescriptor with a unique id', () => {
    for (const model of EXAMPLE_MODELS) expect(ModelDescriptor.safeParse(model).success).toBe(true);
    expect(new Set(EXAMPLE_MODELS.map((m) => m.id)).size).toBe(EXAMPLE_MODELS.length);
  });

  it('contains the default and classifier models', () => {
    expect(EXAMPLE_CATALOG.getModel(DEFAULT_MODEL_ID)).toBeDefined();
    expect(EXAMPLE_CATALOG.getModel(CLASSIFIER_MODEL_ID)).toBeDefined();
  });

  it('has at least one model in every tier', () => {
    for (const tier of ['fast', 'balanced', 'deep'] as const) {
      expect(EXAMPLE_CATALOG.modelsInTier(tier).length).toBeGreaterThan(0);
    }
  });

  it('filters by provider', () => {
    const ids = EXAMPLE_CATALOG.modelsByProvider('deepseek').map((m) => m.id);
    expect(ids).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
  });
});

describe('tier helpers', () => {
  it('ranks tiers fast < balanced < deep', () => {
    expect([tierRank('fast'), tierRank('balanced'), tierRank('deep')]).toEqual([0, 1, 2]);
  });

  it('capTier only ever lowers', () => {
    expect(capTier('deep', 'balanced')).toBe('balanced');
    expect(capTier('fast', 'deep')).toBe('fast');
    expect(capTier('balanced', 'balanced')).toBe('balanced');
  });
});

describe('estimateCostUsd', () => {
  it('prices input and output per million tokens', () => {
    const model = EXAMPLE_CATALOG.getModel('claude-sonnet-5')!;
    // 1M in at $3 + 0.5M out at $15 = $10.50 (example prices, not current ones)
    expect(estimateCostUsd(model, 1_000_000, 500_000)).toBeCloseTo(10.5);
    expect(estimateCostUsd(model, 0, 0)).toBe(0);
  });
});
