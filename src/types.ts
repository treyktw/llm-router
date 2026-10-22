import { z } from 'zod';

/**
 * Model routing contracts.
 *
 * The app never hard-codes a model at a call site. Every turn is classified,
 * then routed, and the decision is stored alongside the message — so the UI can
 * show why a given answer came from a given model, and so routing policy can be
 * changed without rewriting the chat surface.
 */

export const ModelProvider = z.enum([
  'anthropic',
  'openai',
  'google',
  'zhipu',
  'deepseek',
  'local',
]);
export type ModelProvider = z.infer<typeof ModelProvider>;

/** Cost/capability class, independent of provider. Policy reasons in tiers. */
export const ModelTier = z.enum(['fast', 'balanced', 'deep']);
export type ModelTier = z.infer<typeof ModelTier>;

export const ThinkingEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type ThinkingEffort = z.infer<typeof ThinkingEffort>;

export const ModelDescriptor = z.object({
  id: z.string(),
  provider: ModelProvider,
  displayName: z.string(),
  tier: ModelTier,
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  supportsThinking: z.boolean(),
  supportsTools: z.boolean(),
  supportsVision: z.boolean(),
  /** USD per million tokens. Used by policy, and shown in the model picker. */
  inputCostPerMTok: z.number().nonnegative(),
  outputCostPerMTok: z.number().nonnegative(),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptor>;

/**
 * What the user is asking for. Drives both model choice and which agent
 * persona/tool allow-list the turn runs under.
 */
export const TurnIntent = z.enum([
  'chat',
  'explain',
  'tutor',
  'research',
  'code',
  'math',
  'media',
  'visualize',
  'summarize',
  'recall',
]);
export type TurnIntent = z.infer<typeof TurnIntent>;

export const TurnComplexity = z.enum(['trivial', 'standard', 'hard', 'expert']);
export type TurnComplexity = z.infer<typeof TurnComplexity>;

/** The classifier's read on a single turn. Cheap model, structured output. */
export const TurnClassification = z.object({
  intent: TurnIntent,
  complexity: TurnComplexity,
  /** Subject area, free text — 'linear algebra', 'rust', 'thesis'. */
  domain: z.string().nullable(),
  needsRetrieval: z.boolean(),
  needsTools: z.boolean(),
  needsVision: z.boolean(),
  /** True when the turn must read a large amount of attached context. */
  longContext: z.boolean(),
  /** 0..1. Low confidence biases the router upward, never downward. */
  confidence: z.number().min(0).max(1),
  /** One short sentence. Surfaced in the activity trace, not the answer. */
  rationale: z.string(),
});
export type TurnClassification = z.infer<typeof TurnClassification>;

/** How the model for a turn was chosen. */
export const RouteMode = z.enum([
  /** Classifier + policy picked it. */
  'auto',
  /** User pinned a model for this conversation. */
  'pinned',
  /** Policy fell back after a failure or an unavailable model. */
  'fallback',
]);
export type RouteMode = z.infer<typeof RouteMode>;

export const RejectedCandidate = z.object({ modelId: z.string(), reason: z.string() });
export type RejectedCandidate = z.infer<typeof RejectedCandidate>;

export const RouteDecision = z.object({
  modelId: z.string(),
  tier: ModelTier,
  mode: RouteMode,
  effort: ThinkingEffort,
  thinking: z.boolean(),
  maxOutputTokens: z.number().int().positive(),
  /** Why this model, in one line. Shown under 'View activity'. */
  reason: z.string(),
  classification: TurnClassification.nullable(),
  /**
   * Set when this turn routed differently from the previous one — the
   * context switch itself is a fact worth showing and worth debugging.
   */
  switchedFrom: z.string().nullable(),
  /** Models tried and rejected, in order, with the reason. */
  rejected: z.array(RejectedCandidate).default([]),
  decidedAt: z.iso.datetime(),
  /** Wall time the classifier took. Routing must stay cheap. */
  classifyMs: z.number().nonnegative().nullable(),
});
export type RouteDecision = z.infer<typeof RouteDecision>;

/** Per-conversation routing preferences the user controls. */
export const RoutingPreference = z.object({
  mode: z.enum(['auto', 'pinned']).default('auto'),
  pinnedModelId: z.string().nullable().default(null),
  /** Ceiling the router may not exceed, for cost control. */
  maxTier: ModelTier.default('deep'),
  allowThinking: z.boolean().default(true),
});
export type RoutingPreference = z.infer<typeof RoutingPreference>;
