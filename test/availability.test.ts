import { describe, expect, it } from 'vitest';
import { rerouteAroundUnavailable } from '../src/availability.js';
import { route } from '../src/policy.js';
import type { ModelProvider, RouteDecision } from '../src/types.js';
import { classification, fixedClock, preference, priorDecision, TEST_CATALOG } from './fixtures.js';

const ALL: ModelProvider[] = ['google', 'deepseek', 'openai', 'zhipu', 'anthropic'];

const deepDecision = (): RouteDecision =>
  route({
    classification: classification({ complexity: 'hard', needsVision: true }),
    preference: preference(),
    previous: null,
    estimatedInputTokens: 1_000,
    classifyMs: 0,
    catalog: TEST_CATALOG,
    now: fixedClock,
  });

describe('rerouteAroundUnavailable', () => {
  it('leaves the decision alone when the provider is configured and healthy', () => {
    const decision = deepDecision();
    expect(decision.modelId).toBe('deep-main');
    const result = rerouteAroundUnavailable({
      decision,
      catalog: TEST_CATALOG,
      configuredProviders: ALL,
      unusable: new Map(),
      previous: null,
    });
    expect(result).toBe(decision);
  });

  it('moves to another model in the same tier and says why (unhealthy)', () => {
    const result = rerouteAroundUnavailable({
      decision: deepDecision(),
      catalog: TEST_CATALOG,
      configuredProviders: ALL,
      unusable: new Map([['anthropic', 'out of credit']]),
      previous: null,
    });
    expect(result.modelId).toBe('deep-novision');
    expect(result.mode).toBe('fallback');
    expect(result.reason).toBe('deep-main is out of credit; using deep-novision.');
    expect(result.rejected.at(-1)).toEqual({ modelId: 'deep-main', reason: 'Provider is out of credit' });
  });

  it('distinguishes "not configured" from an unhealthy provider', () => {
    const result = rerouteAroundUnavailable({
      decision: deepDecision(),
      catalog: TEST_CATALOG,
      configuredProviders: ['deepseek', 'google'],
      unusable: new Map(),
      previous: null,
    });
    expect(result.reason).toBe('deep-main is not configured; using deep-novision.');
    expect(result.rejected.at(-1)?.reason).toBe('Provider API key is not configured');
  });

  it('steps down one tier at a time and flags the downgrade', () => {
    const result = rerouteAroundUnavailable({
      decision: deepDecision(),
      catalog: TEST_CATALOG,
      configuredProviders: ['openai', 'google'],
      unusable: new Map(),
      previous: null,
    });
    // Catalog order inside the balanced tier: bal-pricey (openai) is listed first.
    expect(result.modelId).toBe('bal-pricey');
    expect(result.tier).toBe('balanced');
    expect(result.reason).toContain('a weaker tier than this turn asked for');
  });

  it('returns the original decision when nothing at or below its tier can run', () => {
    const decision = deepDecision();
    const result = rerouteAroundUnavailable({
      decision,
      catalog: TEST_CATALOG,
      configuredProviders: [],
      unusable: new Map(),
      previous: null,
    });
    expect(result).toBe(decision);
  });

  it('returns the decision unchanged when its model is not in the catalog', () => {
    const decision = priorDecision({ modelId: 'ghost' });
    expect(
      rerouteAroundUnavailable({ decision, catalog: TEST_CATALOG, configuredProviders: [], unusable: new Map(), previous: null }),
    ).toBe(decision);
  });

  it('recomputes switchedFrom against the model actually used', () => {
    const base = { decision: deepDecision(), catalog: TEST_CATALOG, configuredProviders: ALL, unusable: new Map([['anthropic', 'out of credit']]) };
    expect(rerouteAroundUnavailable({ ...base, previous: priorDecision({ modelId: 'deep-novision' }) }).switchedFrom).toBeNull();
    expect(rerouteAroundUnavailable({ ...base, previous: priorDecision({ modelId: 'bal-main' }) }).switchedFrom).toBe('bal-main');
    expect(rerouteAroundUnavailable({ ...base, previous: null }).switchedFrom).toBeNull();
  });
});
