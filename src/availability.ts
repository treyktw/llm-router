import { tierRank, TIER_ORDER, type Catalog } from './catalog.js';
import type { ModelProvider, RouteDecision } from './types.js';

export interface AvailabilityInput {
  decision: RouteDecision;
  catalog: Catalog;
  /** Providers with a key configured. */
  configuredProviders: readonly ModelProvider[];
  /** Providers health tracking currently considers unusable, with a reason. */
  unusable: ReadonlyMap<string, string | null>;
  previous: RouteDecision | null;
}

/**
 * Re-route a policy decision around providers that cannot answer right now.
 *
 * Configured is not the same as working. A provider with a key and no balance
 * passes every check and fails every call, and routing to it costs a request
 * and a wait before the fallback rescues the turn -- which is the fallback
 * doing its job to cover something that was already known.
 *
 * Applies to a pinned model too. Choosing one is an instruction, but the
 * instruction cannot be carried out: an empty account answers nothing, and
 * attempting it spends a wait to arrive at a failure already recorded. The
 * switch is announced, so the choice is not overridden silently.
 *
 * Pure: returns the decision unchanged when the chosen provider is available,
 * or when nothing at or below its tier is.
 */
export function rerouteAroundUnavailable(input: AvailabilityInput): RouteDecision {
  const { decision, catalog, configuredProviders, unusable, previous } = input;
  const model = catalog.getModel(decision.modelId);
  if (!model) return decision;

  const availableProviders = new Set(
    configuredProviders.filter((provider) => !unusable.has(provider)),
  );
  if (availableProviders.has(model.provider)) return decision;

  const fault = unusable.get(model.provider) ?? null;
  const why = fault ?? 'not configured';
  const whyRejected = fault ? `Provider is ${fault}` : 'Provider API key is not configured';

  // Come down from the requested tier one step at a time. Dropping a `deep`
  // turn straight to the cheapest configured model is the silent downgrade
  // the policy exists to prevent — take the best tier we can actually run.
  const reachable = TIER_ORDER.slice(0, tierRank(decision.tier) + 1).reverse();
  const fallback = reachable
    .flatMap((tier) => catalog.models.filter((candidate) => candidate.tier === tier))
    .find((candidate) => availableProviders.has(candidate.provider));

  if (!fallback) return decision;

  const downgraded = tierRank(fallback.tier) < tierRank(decision.tier);
  const previousModelId = previous?.modelId ?? null;
  return {
    ...decision,
    modelId: fallback.id,
    tier: fallback.tier,
    mode: 'fallback',
    // Says which of the two it is. "Not configured" for a provider that is
    // configured and out of credit sends someone to check a key that is fine.
    reason: downgraded
      ? `${model.displayName} is ${why}; using ${fallback.displayName} — a weaker tier than this turn asked for.`
      : `${model.displayName} is ${why}; using ${fallback.displayName}.`,
    // Recompute against the model we will actually call. Reporting a switch
    // away from the model we just landed back on is a lie.
    switchedFrom: previousModelId && previousModelId !== fallback.id ? previousModelId : null,
    rejected: [...decision.rejected, { modelId: model.id, reason: whyRejected }],
  };
}
