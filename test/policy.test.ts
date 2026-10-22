import { describe, expect, it } from 'vitest';
import { createCatalog, EXAMPLE_CATALOG } from '../src/catalog.js';
import {
  COMPLEXITY_TIER,
  EFFORT_BY_COMPLEXITY,
  fits,
  isContextSwitch,
  orderedCandidates,
  route,
  type RouteInput,
} from '../src/policy.js';
import { RouteDecision, type TurnClassification, type TurnComplexity, type TurnIntent } from '../src/types.js';
import {
  classification,
  FIXED_NOW,
  fixedClock,
  model,
  preference,
  priorDecision,
  TEST_CATALOG,
} from './fixtures.js';

const input = (overrides: Partial<RouteInput> = {}): RouteInput => ({
  classification: classification(),
  preference: preference(),
  previous: null,
  estimatedInputTokens: 1_000,
  classifyMs: 12,
  catalog: TEST_CATALOG,
  now: fixedClock,
  ...overrides,
});

const routeWith = (c: Partial<TurnClassification>, extra: Partial<RouteInput> = {}) =>
  route(input({ classification: classification(c), ...extra }));

describe('complexity tiering', () => {
  it.each<[TurnComplexity, string, string]>([
    ['trivial', 'fast', 'fast-cheap'],
    ['standard', 'balanced', 'bal-small'],
    ['hard', 'deep', 'deep-novision'],
    ['expert', 'deep', 'deep-novision'],
  ])('%s → %s tier, cheapest model first (%s)', (complexity, tier, modelId) => {
    const decision = routeWith({ complexity });
    expect(COMPLEXITY_TIER[complexity]).toBe(tier);
    expect(decision.tier).toBe(tier);
    expect(decision.modelId).toBe(modelId);
    expect(decision.mode).toBe('auto');
    expect(decision.rejected).toEqual([]);
  });

  it('sorts candidates within a tier by input cost, not catalog order', () => {
    // bal-pricey is listed first in the catalog but costs the most.
    const ids = orderedCandidates(TEST_CATALOG, 'balanced', 'balanced').map((m) => m.id);
    expect(ids).toEqual(['bal-small', 'bal-main', 'bal-pricey']);
  });

  it('keeps catalog order for equally priced models (stable sort)', () => {
    const catalog = createCatalog(
      [model({ id: 'b', tier: 'fast' }), model({ id: 'a', tier: 'fast' })],
      { defaultModelId: 'a' },
    );
    expect(orderedCandidates(catalog, 'fast', 'deep').slice(0, 2).map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('intent ceilings', () => {
  it('recall is capped to fast even when the classifier says hard', () => {
    const decision = routeWith({ intent: 'recall', complexity: 'hard' });
    expect(decision.tier).toBe('fast');
    expect(decision.modelId).toBe('fast-cheap');
  });

  it('summarize is capped to balanced', () => {
    const decision = routeWith({ intent: 'summarize', complexity: 'expert' });
    expect(decision.tier).toBe('balanced');
  });

  it('a ceiling never raises: trivial summarize stays fast', () => {
    expect(routeWith({ intent: 'summarize', complexity: 'trivial' }).tier).toBe('fast');
  });
});

describe('intent floors', () => {
  it.each<[TurnIntent, string]>([
    ['code', 'balanced'],
    ['math', 'deep'],
    ['research', 'deep'],
    ['visualize', 'balanced'],
    ['tutor', 'balanced'],
  ])('trivial %s is raised to at least %s', (intent, floor) => {
    expect(routeWith({ intent, complexity: 'trivial' }).tier).toBe(floor);
  });

  it.each<TurnIntent>(['chat', 'explain', 'media'])('%s has no floor', (intent) => {
    expect(routeWith({ intent, complexity: 'trivial' }).tier).toBe('fast');
  });

  it('a floor never lowers: expert code stays deep', () => {
    expect(routeWith({ intent: 'code', complexity: 'expert' }).tier).toBe('deep');
  });
});

describe('capability raises (only ever up)', () => {
  it('needsTools raises fast to balanced', () => {
    const decision = routeWith({ complexity: 'trivial', needsTools: true });
    expect(decision.tier).toBe('balanced');
  });

  it('longContext raises fast to balanced', () => {
    expect(routeWith({ complexity: 'trivial', longContext: true }).tier).toBe('balanced');
  });

  it('low confidence raises fast to balanced', () => {
    expect(routeWith({ complexity: 'trivial', confidence: 0.3 }).tier).toBe('balanced');
  });

  it('confidence exactly at the threshold does not raise', () => {
    expect(routeWith({ complexity: 'trivial', confidence: 0.55 }).tier).toBe('fast');
  });

  it('raises do not lower a deep turn', () => {
    const decision = routeWith({ complexity: 'hard', needsTools: true, longContext: true, confidence: 0.1 });
    expect(decision.tier).toBe('deep');
  });

  it('a raise beats an intent ceiling: recall that needs tools lands on balanced', () => {
    expect(routeWith({ intent: 'recall', complexity: 'trivial', needsTools: true }).tier).toBe('balanced');
  });
});

describe('user cost ceiling (maxTier)', () => {
  it('pushes a deep turn back down', () => {
    const decision = routeWith({ intent: 'math', complexity: 'expert' }, { preference: preference({ maxTier: 'fast' }) });
    expect(decision.tier).toBe('fast');
  });

  it('overrides capability raises', () => {
    const decision = routeWith({ complexity: 'trivial', needsTools: true }, { preference: preference({ maxTier: 'fast' }) });
    expect(decision.tier).toBe('fast');
  });

  it('stops the upward search at the ceiling and falls back when nothing fits', () => {
    // Vision on fast: fast-cheap lacks vision, fast-vision is too small for 900k*1.3.
    const decision = routeWith(
      { complexity: 'trivial', needsVision: true },
      { preference: preference({ maxTier: 'fast' }), estimatedInputTokens: 900_000 },
    );
    expect(decision.mode).toBe('fallback');
    expect(decision.reason).toBe('No candidate met the turn requirements');
    expect(decision.rejected.map((r) => r.modelId)).toEqual(['fast-cheap', 'fast-vision']);
  });
});

describe('candidate filtering and rejected reasons', () => {
  it('rejects for missing vision and records why, in order', () => {
    const decision = routeWith({ complexity: 'trivial', needsVision: true });
    expect(decision.modelId).toBe('fast-vision');
    expect(decision.rejected).toEqual([{ modelId: 'fast-cheap', reason: 'no vision support' }]);
  });

  it('rejects for missing tool support', () => {
    const decision = routeWith({ complexity: 'standard', needsTools: true });
    expect(decision.modelId).toBe('bal-main');
    expect(decision.rejected).toEqual([{ modelId: 'bal-small', reason: 'no tool support' }]);
  });

  it('rejects for context window, using 1.3x headroom', () => {
    // 40k * 1.3 = 52k > bal-small's 50k window.
    const decision = routeWith({ complexity: 'standard' }, { estimatedInputTokens: 40_000 });
    expect(decision.modelId).toBe('bal-main');
    expect(decision.rejected).toEqual([{ modelId: 'bal-small', reason: 'context window too small' }]);
  });

  it('accepts a model exactly at the headroom limit', () => {
    // 38_461 * 1.3 = 49_999.3 <= 50_000
    expect(routeWith({ complexity: 'standard' }, { estimatedInputTokens: 38_461 }).modelId).toBe('bal-small');
  });

  it('searches upward into the next tier rather than downgrading', () => {
    const catalog = createCatalog(
      [
        model({ id: 'f', tier: 'fast', supportsVision: false }),
        model({ id: 'b', tier: 'balanced', supportsVision: false }),
        model({ id: 'd', tier: 'deep' }),
      ],
      { defaultModelId: 'b' },
    );
    const decision = routeWith({ complexity: 'trivial', needsVision: true }, { catalog });
    expect(decision.modelId).toBe('d');
    expect(decision.tier).toBe('deep');
    expect(decision.reason).toContain('(fast)'); // the policy tier, not the landed tier
    expect(decision.rejected).toEqual([
      { modelId: 'f', reason: 'no vision support' },
      { modelId: 'b', reason: 'no vision support' },
    ]);
  });

  it('falls back to the default when no model in any reachable tier fits', () => {
    const decision = routeWith({ complexity: 'trivial' }, { estimatedInputTokens: 10_000_000 });
    expect(decision.mode).toBe('fallback');
    expect(decision.modelId).toBe('bal-main');
    expect(decision.rejected).toHaveLength(TEST_CATALOG.models.length);
    expect(decision.rejected.every((r) => r.reason === 'context window too small')).toBe(true);
  });

  it('checks vision before tools before context', () => {
    const tiny = model({ id: 'tiny', tier: 'fast', supportsVision: false, supportsTools: false, contextWindow: 10 });
    expect(fits(tiny, classification({ needsVision: true, needsTools: true }), 1_000)).toBe('no vision support');
    expect(fits(tiny, classification({ needsTools: true }), 1_000)).toBe('no tool support');
    expect(fits(tiny, classification(), 1_000)).toBe('context window too small');
    expect(fits(tiny, classification(), 1)).toBeNull();
  });

  it('with no classification only the context window is checked', () => {
    const tiny = model({ id: 'tiny', tier: 'fast', supportsVision: false, supportsTools: false, contextWindow: 10 });
    expect(fits(tiny, null, 1)).toBeNull();
    expect(fits(tiny, null, 100)).toBe('context window too small');
  });
});

describe('orderedCandidates edge cases', () => {
  it('returns the requested tier even if it is above the ceiling (defensive path)', () => {
    expect(orderedCandidates(TEST_CATALOG, 'deep', 'fast').map((m) => m.tier)).toEqual(['deep', 'deep']);
  });

  it('includes every tier from the start upward when uncapped', () => {
    const tiers = orderedCandidates(TEST_CATALOG, 'fast', 'deep').map((m) => m.tier);
    expect(tiers).toEqual(['fast', 'fast', 'balanced', 'balanced', 'balanced', 'deep', 'deep']);
  });
});

describe('pinned models', () => {
  it('uses the pinned model and skips tier policy entirely', () => {
    const decision = routeWith(
      { intent: 'math', complexity: 'expert' },
      { preference: preference({ mode: 'pinned', pinnedModelId: 'fast-cheap' }) },
    );
    expect(decision.modelId).toBe('fast-cheap');
    expect(decision.mode).toBe('pinned');
    expect(decision.reason).toBe('Pinned to fast-cheap');
    expect(decision.rejected).toEqual([]);
  });

  it('works with no classification (pinned turns skip the classifier)', () => {
    const decision = route(input({ classification: null, preference: preference({ mode: 'pinned', pinnedModelId: 'deep-main' }) }));
    expect(decision.mode).toBe('pinned');
    expect(decision.effort).toBe('high');
  });

  it('a pinned model that fails a hard capability check is rejected, then policy routes', () => {
    const decision = routeWith(
      { complexity: 'trivial', needsVision: true },
      { preference: preference({ mode: 'pinned', pinnedModelId: 'fast-cheap' }) },
    );
    expect(decision.mode).toBe('auto');
    expect(decision.modelId).toBe('fast-vision');
    // The pin's rejection comes first, then fast-cheap again as a normal candidate.
    expect(decision.rejected).toEqual([
      { modelId: 'fast-cheap', reason: 'no vision support' },
      { modelId: 'fast-cheap', reason: 'no vision support' },
    ]);
  });

  it('a pinned model that fails with no classification falls back to the default', () => {
    const decision = route(
      input({
        classification: null,
        estimatedInputTokens: 90_000,
        preference: preference({ mode: 'pinned', pinnedModelId: 'fast-cheap' }),
      }),
    );
    expect(decision.mode).toBe('fallback');
    expect(decision.modelId).toBe('bal-main');
    expect(decision.rejected).toEqual([{ modelId: 'fast-cheap', reason: 'context window too small' }]);
  });

  it('an unknown pinned id is ignored and policy routes normally', () => {
    const decision = routeWith({ complexity: 'trivial' }, { preference: preference({ mode: 'pinned', pinnedModelId: 'retired-model' }) });
    expect(decision.mode).toBe('auto');
    expect(decision.modelId).toBe('fast-cheap');
    expect(decision.rejected).toEqual([]);
  });

  it('pinned mode with no pinned id behaves like auto', () => {
    const decision = routeWith({ complexity: 'trivial' }, { preference: preference({ mode: 'pinned', pinnedModelId: null }) });
    expect(decision.mode).toBe('auto');
  });

  it('a pinned id is ignored in auto mode', () => {
    const decision = routeWith({ complexity: 'trivial' }, { preference: preference({ mode: 'auto', pinnedModelId: 'deep-main' }) });
    expect(decision.modelId).toBe('fast-cheap');
  });
});

describe('unclassified turns', () => {
  it('defaults to the catalog default and says why', () => {
    const decision = route(input({ classification: null }));
    expect(decision.mode).toBe('fallback');
    expect(decision.modelId).toBe('bal-main');
    expect(decision.reason).toBe('Unclassified turn — defaulting to the most capable model');
    expect(decision.classification).toBeNull();
  });

  it('assumes hard effort when there is no classification', () => {
    expect(route(input({ classification: null })).effort).toBe('high');
  });

  it('throws if the default model is missing from the catalog', () => {
    const broken = createCatalog([model({ id: 'only', tier: 'fast' })], { defaultModelId: 'ghost' });
    expect(() => route(input({ classification: null, catalog: broken }))).toThrow('Default model ghost missing from catalog');
  });

  it('throws on the no-fit path too if the default is missing', () => {
    const broken = createCatalog([model({ id: 'only', tier: 'fast', contextWindow: 1 })], { defaultModelId: 'ghost' });
    expect(() => route(input({ catalog: broken }))).toThrow('Default model ghost missing from catalog');
  });
});

describe('decision record', () => {
  it.each<[TurnComplexity]>([['trivial'], ['standard'], ['hard'], ['expert']])(
    'effort follows complexity (%s)',
    (complexity) => {
      expect(routeWith({ complexity }).effort).toBe(EFFORT_BY_COMPLEXITY[complexity]);
    },
  );

  it('enables thinking only when allowed AND supported, and sizes output accordingly', () => {
    const thinking = routeWith({ complexity: 'standard' });
    expect(thinking.thinking).toBe(true);
    expect(thinking.maxOutputTokens).toBe(32_000);

    const disallowed = routeWith({ complexity: 'standard' }, { preference: preference({ allowThinking: false }) });
    expect(disallowed.thinking).toBe(false);
    expect(disallowed.maxOutputTokens).toBe(8_000);

    // fast-cheap does not support thinking and only allows 4k output.
    const unsupported = routeWith({ complexity: 'trivial' });
    expect(unsupported.modelId).toBe('fast-cheap');
    expect(unsupported.thinking).toBe(false);
    expect(unsupported.maxOutputTokens).toBe(4_000);
  });

  it('builds the reason from intent, complexity, domain, tools and long context', () => {
    const decision = routeWith({ intent: 'code', complexity: 'standard', domain: 'rust', needsTools: true, longContext: true });
    expect(decision.reason).toBe('bal-main (balanced) — code · standard · rust · tools · long context');
  });

  it('omits optional reason parts when absent', () => {
    expect(routeWith({ complexity: 'trivial' }).reason).toBe('fast-cheap (fast) — chat · trivial');
  });

  it('carries classification, classifyMs and the injected clock', () => {
    const c = classification({ complexity: 'trivial' });
    const decision = route(input({ classification: c, classifyMs: 87 }));
    expect(decision.classification).toEqual(c);
    expect(decision.classifyMs).toBe(87);
    expect(decision.decidedAt).toBe(FIXED_NOW.toISOString());
  });

  it('uses the real clock when none is injected', () => {
    const before = Date.now();
    const decision = route({ ...input(), now: undefined });
    expect(Date.parse(decision.decidedAt)).toBeGreaterThanOrEqual(before);
  });

  it('records switchedFrom only when the model actually changed', () => {
    expect(routeWith({ complexity: 'trivial' }).switchedFrom).toBeNull();
    expect(routeWith({ complexity: 'trivial' }, { previous: priorDecision({ modelId: 'fast-cheap' }) }).switchedFrom).toBeNull();
    expect(routeWith({ complexity: 'trivial' }, { previous: priorDecision({ modelId: 'bal-main' }) }).switchedFrom).toBe('bal-main');
  });

  it('always validates against the RouteDecision schema', () => {
    for (const decision of [
      routeWith({ complexity: 'expert', intent: 'math', needsVision: true }),
      route(input({ classification: null })),
      routeWith({}, { preference: preference({ mode: 'pinned', pinnedModelId: 'deep-main' }) }),
    ]) {
      expect(RouteDecision.safeParse(decision).success).toBe(true);
    }
  });

  it('defaults to the bundled example catalog', () => {
    const decision = route({ ...input(), catalog: undefined, classification: classification({ complexity: 'trivial' }) });
    expect(EXAMPLE_CATALOG.getModel(decision.modelId)).toBeDefined();
    expect(decision.tier).toBe('fast');
  });
});

describe('determinism', () => {
  it('same input → identical decision', () => {
    const args = input({ classification: classification({ intent: 'code', complexity: 'hard', needsVision: true, confidence: 0.4 }) });
    const first = route(args);
    for (let i = 0; i < 20; i += 1) expect(route(args)).toEqual(first);
  });

  it('does not mutate its inputs or leak rejected lists between calls', () => {
    const c = classification({ complexity: 'trivial', needsVision: true });
    const frozen = structuredClone(c);
    const first = route(input({ classification: c }));
    const second = route(input({ classification: c }));
    expect(c).toEqual(frozen);
    expect(first.rejected).not.toBe(second.rejected);
    expect(second.rejected).toHaveLength(1);
  });

  it('routes the example catalog deterministically across a matrix of turns', () => {
    const intents: TurnIntent[] = ['chat', 'code', 'math', 'recall', 'summarize'];
    const complexities: TurnComplexity[] = ['trivial', 'standard', 'hard', 'expert'];
    const run = () =>
      intents.flatMap((intent) =>
        complexities.map((complexity) =>
          route({ ...input({ classification: classification({ intent, complexity }) }), catalog: EXAMPLE_CATALOG }).modelId,
        ),
      );
    expect(run()).toEqual(run());
  });
});

describe('isContextSwitch', () => {
  const next = (overrides = {}) => priorDecision({ modelId: 'deep-main', ...overrides });

  it('is false on the first turn', () => {
    expect(isContextSwitch(null, next())).toBe(false);
  });

  it('is false when the model did not change, even if the topic did', () => {
    expect(
      isContextSwitch(priorDecision({ modelId: 'deep-main' }), next({ classification: classification({ intent: 'math' }) })),
    ).toBe(false);
  });

  it('is true when either side is unclassified and the model changed', () => {
    expect(isContextSwitch(priorDecision({ classification: null }), next())).toBe(true);
    expect(isContextSwitch(priorDecision(), next({ classification: null }))).toBe(true);
  });

  it('is true on an intent change', () => {
    expect(isContextSwitch(priorDecision(), next({ classification: classification({ intent: 'code' }) }))).toBe(true);
  });

  it('is true on a domain change', () => {
    expect(isContextSwitch(priorDecision(), next({ classification: classification({ domain: 'biology' }) }))).toBe(true);
  });

  it('is false when the model changed but intent and domain did not (just a fluctuation)', () => {
    expect(isContextSwitch(priorDecision(), next({ classification: classification({ complexity: 'hard' }) }))).toBe(false);
  });
});
