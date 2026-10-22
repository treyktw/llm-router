import { capTier, EXAMPLE_CATALOG, tierRank, TIER_ORDER, type Catalog } from './catalog.js';
import type {
  ModelDescriptor,
  ModelTier,
  RouteDecision,
  RoutingPreference,
  ThinkingEffort,
  TurnClassification,
  TurnComplexity,
  TurnIntent,
} from './types.js';

/**
 * Routing policy. Pure — no I/O, no database, no provider SDKs — so it can be
 * unit tested and reasoned about on its own.
 *
 * The shape of the decision is deliberate: start from complexity, adjust for
 * intent, then apply hard requirements (vision, context length) as filters that
 * can only push *up*, never down. A wrong cheap answer costs more than a right
 * expensive one.
 */

export const COMPLEXITY_TIER: Record<TurnComplexity, ModelTier> = {
  trivial: 'fast',
  standard: 'balanced',
  hard: 'deep',
  expert: 'deep',
};

/**
 * Intents that are structurally hard regardless of how simple the question
 * looks. A one-line question about a proof is still a proof.
 */
export const INTENT_FLOOR: Partial<Record<TurnIntent, ModelTier>> = {
  code: 'balanced',
  math: 'deep',
  research: 'deep',
  visualize: 'balanced',
  tutor: 'balanced',
};

/** Intents where speed matters more than depth. */
export const INTENT_CEILING: Partial<Record<TurnIntent, ModelTier>> = {
  recall: 'fast',
  summarize: 'balanced',
};

export const EFFORT_BY_COMPLEXITY: Record<TurnComplexity, ThinkingEffort> = {
  trivial: 'low',
  standard: 'medium',
  hard: 'high',
  expert: 'xhigh',
};

/** Below this the classifier is treated as unsure, and unsure costs more. */
export const LOW_CONFIDENCE_THRESHOLD = 0.55;

/** Headroom multiplier on the input estimate before comparing to the window. */
export const CONTEXT_HEADROOM = 1.3;

const raise = (current: ModelTier, floor: ModelTier): ModelTier =>
  tierRank(floor) > tierRank(current) ? floor : current;

export interface RouteInput {
  classification: TurnClassification | null;
  preference: RoutingPreference;
  /** The previous assistant turn's route, for context-switch detection. */
  previous: RouteDecision | null;
  /** Rough size of everything being sent, including attached context. */
  estimatedInputTokens: number;
  classifyMs: number | null;
  /** Models to choose from. Defaults to the bundled example catalog. */
  catalog?: Catalog;
  /** Clock for `decidedAt`. Injected so decisions are reproducible in tests. */
  now?: () => Date;
}

/**
 * Pick the model for a turn.
 *
 * Returns a full decision record rather than a model id — the reason and the
 * rejected candidates are part of the product (they appear under "View
 * activity"), not debug noise.
 */
export function route(input: RouteInput): RouteDecision {
  const { classification, preference, previous, estimatedInputTokens, classifyMs } = input;
  const catalog = input.catalog ?? EXAMPLE_CATALOG;
  const now = input.now ?? (() => new Date());
  const rejected: RouteDecision['rejected'] = [];
  const shared = { classification, previous, preference, rejected, classifyMs, now };

  // A pinned model short-circuits everything except hard capability checks.
  if (preference.mode === 'pinned' && preference.pinnedModelId) {
    const pinned = catalog.getModel(preference.pinnedModelId);
    if (pinned && fits(pinned, classification, estimatedInputTokens) === null) {
      return decide(pinned, {
        ...shared,
        mode: 'pinned',
        reason: `Pinned to ${pinned.displayName}`,
      });
    }
    if (pinned) {
      rejected.push({
        modelId: pinned.id,
        reason: fits(pinned, classification, estimatedInputTokens) ?? 'unavailable',
      });
    }
  }

  // No classification (classifier failed or was skipped) — bias upward.
  if (!classification) {
    return decide(defaultModel(catalog), {
      ...shared,
      mode: 'fallback',
      reason: 'Unclassified turn — defaulting to the most capable model',
    });
  }

  let tier = COMPLEXITY_TIER[classification.complexity];

  const ceiling = INTENT_CEILING[classification.intent];
  if (ceiling) tier = capTier(tier, ceiling);

  const floor = INTENT_FLOOR[classification.intent];
  if (floor) tier = raise(tier, floor);

  // Hard requirements only ever push the tier up.
  if (classification.needsTools) tier = raise(tier, 'balanced');
  if (classification.longContext) tier = raise(tier, 'balanced');

  // An unsure classifier is a reason to spend more, not less.
  if (classification.confidence < LOW_CONFIDENCE_THRESHOLD) tier = raise(tier, 'balanced');

  // The user's cost ceiling is the one constraint that pushes back down.
  tier = capTier(tier, preference.maxTier);

  const candidates = orderedCandidates(catalog, tier, preference.maxTier);
  for (const candidate of candidates) {
    const problem = fits(candidate, classification, estimatedInputTokens);
    if (problem) {
      rejected.push({ modelId: candidate.id, reason: problem });
      continue;
    }
    return decide(candidate, {
      ...shared,
      mode: 'auto',
      reason: explain(classification, candidate, tier),
    });
  }

  return decide(defaultModel(catalog), {
    ...shared,
    mode: 'fallback',
    reason: 'No candidate met the turn requirements',
  });
}

function defaultModel(catalog: Catalog): ModelDescriptor {
  const model = catalog.getModel(catalog.defaultModelId);
  if (!model) throw new Error(`Default model ${catalog.defaultModelId} missing from catalog`);
  return model;
}

/** Preferred tier first, then upward — never silently downgrade. */
export function orderedCandidates(
  catalog: Catalog,
  tier: ModelTier,
  ceiling: ModelTier,
): ModelDescriptor[] {
  const start = TIER_ORDER.indexOf(tier);
  const reachable = TIER_ORDER.slice(start).filter((t) => tierRank(t) <= tierRank(ceiling));
  const tiers = reachable.length > 0 ? reachable : [tier];
  return tiers.flatMap((t) =>
    catalog.modelsInTier(t).sort((a, b) => a.inputCostPerMTok - b.inputCostPerMTok),
  );
}

/** Returns a rejection reason, or null when the model can serve the turn. */
export function fits(
  model: ModelDescriptor,
  classification: TurnClassification | null,
  estimatedInputTokens: number,
): string | null {
  if (classification?.needsVision && !model.supportsVision) return 'no vision support';
  if (classification?.needsTools && !model.supportsTools) return 'no tool support';
  // Leave room for the response and for context that grows during the turn.
  if (estimatedInputTokens * CONTEXT_HEADROOM > model.contextWindow) {
    return 'context window too small';
  }
  return null;
}

function explain(
  classification: TurnClassification,
  model: ModelDescriptor,
  tier: ModelTier,
): string {
  const parts = [`${classification.intent} · ${classification.complexity}`];
  if (classification.domain) parts.push(classification.domain);
  if (classification.needsTools) parts.push('tools');
  if (classification.longContext) parts.push('long context');
  return `${model.displayName} (${tier}) — ${parts.join(' · ')}`;
}

function decide(
  model: ModelDescriptor,
  ctx: {
    mode: RouteDecision['mode'];
    reason: string;
    classification: TurnClassification | null;
    previous: RouteDecision | null;
    preference: RoutingPreference;
    rejected: RouteDecision['rejected'];
    classifyMs: number | null;
    now: () => Date;
  },
): RouteDecision {
  const complexity = ctx.classification?.complexity ?? 'hard';
  const effort = EFFORT_BY_COMPLEXITY[complexity];
  const thinking = ctx.preference.allowThinking && model.supportsThinking;

  return {
    modelId: model.id,
    tier: model.tier,
    mode: ctx.mode,
    effort,
    thinking,
    // Deep answers get room; quick ones do not need 128k of headroom.
    maxOutputTokens: Math.min(model.maxOutputTokens, thinking ? 32_000 : 8_000),
    reason: ctx.reason,
    classification: ctx.classification,
    switchedFrom: ctx.previous && ctx.previous.modelId !== model.id ? ctx.previous.modelId : null,
    rejected: ctx.rejected,
    decidedAt: ctx.now().toISOString(),
    classifyMs: ctx.classifyMs,
  };
}

/**
 * Whether the conversation meaningfully changed shape between turns. Used to
 * decide when to tell the user the model switched, rather than switching
 * silently on every small fluctuation.
 */
export function isContextSwitch(previous: RouteDecision | null, next: RouteDecision): boolean {
  if (!previous) return false;
  if (previous.modelId === next.modelId) return false;
  const before = previous.classification;
  const after = next.classification;
  if (!before || !after) return true;
  return before.intent !== after.intent || before.domain !== after.domain;
}
