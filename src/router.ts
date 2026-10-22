import { rerouteAroundUnavailable } from './availability.js';
import { EXAMPLE_CATALOG, type Catalog } from './catalog.js';
import type { ClassifyInput, ClassifyResult, Classifier } from './classify.js';
import type { ProviderHealth } from './health.js';
import { isContextSwitch, route } from './policy.js';
import type { ModelProvider, RouteDecision, RoutingPreference } from './types.js';

export interface RouterOptions {
  classifier: Classifier;
  catalog?: Catalog;
  /** Optional: skip providers that recent real calls say are broken. */
  health?: ProviderHealth;
  /** Providers with credentials. Defaults to every provider in the catalog. */
  configuredProviders?: readonly ModelProvider[];
  now?: () => Date;
}

export interface RouteTurnInput {
  turn: ClassifyInput;
  preference: RoutingPreference;
  previous: RouteDecision | null;
  estimatedInputTokens: number;
}

export interface RoutedTurn {
  decision: RouteDecision;
  /** True when the model changed *and* the conversation changed shape. */
  contextSwitch: boolean;
  /** Classifier failure, if any. The decision still exists (it fell back). */
  classifierError: string | null;
}

/**
 * Glue for the whole pipeline: classify → policy → availability → switch
 * detection. Every step except the classifier and the health store is pure.
 */
export class Router {
  private readonly catalog: Catalog;

  constructor(private readonly options: RouterOptions) {
    this.catalog = options.catalog ?? EXAMPLE_CATALOG;
  }

  async routeTurn(input: RouteTurnInput): Promise<RoutedTurn> {
    // A pinned conversation does not need the classifier's opinion.
    const classified: ClassifyResult =
      input.preference.mode === 'pinned'
        ? { classification: null, durationMs: 0, error: null }
        : await this.options.classifier.classify(input.turn);

    let decision = route({
      classification: classified.classification,
      preference: input.preference,
      previous: input.previous,
      estimatedInputTokens: input.estimatedInputTokens,
      classifyMs: classified.durationMs,
      catalog: this.catalog,
      now: this.options.now,
    });

    const configured =
      this.options.configuredProviders ??
      [...new Set(this.catalog.models.map((model) => model.provider))];
    const unusable = this.options.health
      ? new Map((await this.options.health.unusable()).map((row) => [row.provider, row.reason] as const))
      : new Map<string, string | null>();

    decision = rerouteAroundUnavailable({
      decision,
      catalog: this.catalog,
      configuredProviders: configured,
      unusable,
      previous: input.previous,
    });

    return {
      decision,
      // A silent model switch is confusing; an announced one is informative.
      contextSwitch: isContextSwitch(input.previous, decision),
      classifierError: classified.error,
    };
  }
}
