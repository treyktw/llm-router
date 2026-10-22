import { generateText, Output, type LanguageModel } from 'ai';
import { TurnClassification, type TurnComplexity, type TurnIntent } from './types.js';

export interface ClassifyInput {
  prompt: string;
  recentTurns: Array<{ role: 'user' | 'assistant'; text: string }>;
  attachedContext: string[];
  workspaceKind: string | null;
}

export interface ClassifyResult {
  classification: TurnClassification | null;
  durationMs: number;
  error: string | null;
}

/**
 * Anything that can read a turn and say what kind of work it is. The policy
 * does not care how: a cheap LLM in production, a heuristic in tests and demos.
 * A classifier must never throw — failures come back as `classification: null`
 * and the policy biases upward.
 */
export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassifyResult>;
}

export const CLASSIFIER_SYSTEM = `You classify a single turn in a study and research assistant.

You are not answering the question. Decide what kind of work it is so the system
can route it to an appropriately capable model.

Guidance:
- complexity is about required reasoning, not prompt length.
- trivial: recall, formatting, one-line facts, small talk.
- standard: concept explanations, routine code, summarizing provided text.
- hard: multi-step reasoning, proofs, debugging, design tradeoffs, synthesis.
- expert: research-level reasoning, novel derivations, large multi-source analysis.
- needsRetrieval means indexed workspace sources are required. Earlier chats and
  conversation history do not count as source retrieval; for those set
  needsRetrieval false and needsTools true.
- needsTools means an action such as search, calculation, execution, rendering, or editing.
- longContext means a large attached document or transcript must be read in full.
- domain is a short subject label, or null.
- rationale is one short sentence for the activity trace.`;

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/** Rough token estimate — good enough for context-window headroom checks. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6);

/** The prompt the LLM classifier sees. Exported so it can be inspected/tested. */
export function buildClassifierPrompt(input: ClassifyInput): string {
  const history = input.recentTurns
    .map((turn) => `${turn.role}: ${truncate(turn.text, 400)}`)
    .join('\n');
  const attached =
    input.attachedContext.length > 0
      ? `\nAttached context: ${input.attachedContext.join(', ')}`
      : '';
  const workspace = input.workspaceKind ? `\nWorkspace kind: ${input.workspaceKind}` : '';
  return `${history ? `Recent turns:\n${history}\n\n` : ''}Current turn:\n${truncate(
    input.prompt,
    2_000,
  )}${attached}${workspace}`;
}

/**
 * LLM classifier using the Vercel AI SDK's structured output. Pass any
 * `LanguageModel` — the cheapest model you trust to fill in a small schema.
 */
export class AiSdkClassifier implements Classifier {
  constructor(
    private readonly model: LanguageModel,
    private readonly options: { system?: string; maxOutputTokens?: number } = {},
  ) {}

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const started = Date.now();
    try {
      const result = await generateText({
        model: this.model,
        system: this.options.system ?? CLASSIFIER_SYSTEM,
        maxOutputTokens: this.options.maxOutputTokens ?? 512,
        output: Output.object({ schema: TurnClassification }),
        prompt: buildClassifierPrompt(input),
      });

      return {
        classification: result.output,
        durationMs: Date.now() - started,
        error: null,
      };
    } catch (error) {
      return {
        classification: null,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Deterministic keyword classifier. Not a substitute for the LLM — it exists so
 * the demo and tests run with no API keys and produce the same output every
 * time. Rules are ordered; the first intent match wins.
 */
export class HeuristicClassifier implements Classifier {
  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    return { classification: heuristicClassify(input), durationMs: 0, error: null };
  }
}

const INTENT_RULES: ReadonlyArray<{ intent: TurnIntent; pattern: RegExp; domain: string | null }> = [
  { intent: 'math', pattern: /\b(prove|proof|integral|derivative|eigen\w*|theorem|lemma)\b/, domain: 'mathematics' },
  { intent: 'code', pattern: /\b(bug|function|stack trace|typescript|rust|python|refactor|compile|regex)\b/, domain: 'software' },
  { intent: 'research', pattern: /\b(literature|papers?|survey|sources|cite|state of the art)\b/, domain: 'research' },
  { intent: 'visualize', pattern: /\b(chart|plot|graph|diagram|visuali[sz]e)\b/, domain: null },
  { intent: 'summarize', pattern: /\b(summari[sz]e|tl;?dr|key points)\b/, domain: null },
  { intent: 'tutor', pattern: /\b(quiz me|teach me|practice problems?|walk me through)\b/, domain: null },
  { intent: 'media', pattern: /\b(image|photo|screenshot|picture)\b/, domain: null },
  { intent: 'recall', pattern: /\b(what did (i|we)|remind me|earlier you said|last time)\b/, domain: null },
  { intent: 'explain', pattern: /\b(explain|why does|how does|what is)\b/, domain: null },
];

const HARD_MARKERS = /\b(tradeoffs?|design|architecture|debug|step by step|compare|why)\b/;
const EXPERT_MARKERS = /\b(novel|research-level|derive from first principles|open problem)\b/;
const TOOL_MARKERS = /\b(run|execute|search|calculate|render|plot|chart|look up|earlier chats?)\b/;
const VISION_MARKERS = /\b(image|photo|screenshot|picture|diagram attached)\b/;

export function heuristicClassify(input: ClassifyInput): TurnClassification {
  const text = input.prompt.toLowerCase();
  const rule = INTENT_RULES.find((candidate) => candidate.pattern.test(text));
  const intent: TurnIntent = rule?.intent ?? 'chat';
  const words = text.split(/\s+/).filter(Boolean).length;

  let complexity: TurnComplexity;
  if (EXPERT_MARKERS.test(text)) complexity = 'expert';
  else if (HARD_MARKERS.test(text) || words > 80) complexity = 'hard';
  else if (words <= 8 && !rule) complexity = 'trivial';
  else if (intent === 'recall') complexity = 'trivial';
  else complexity = 'standard';

  const attachedLength = input.attachedContext.join(' ').length;
  const longContext = attachedLength > 20_000 || /\b(entire|whole|full) (document|transcript|book|pdf)\b/.test(text);
  const needsVision = VISION_MARKERS.test(text);
  const needsTools = TOOL_MARKERS.test(text) || intent === 'recall';

  // Confidence: a matched rule is a decent signal; small talk with no rule is
  // easy to call; everything else the heuristic is honestly unsure about.
  const confidence = rule ? 0.8 : complexity === 'trivial' ? 0.9 : 0.5;

  return {
    intent,
    complexity,
    domain: rule?.domain ?? null,
    needsRetrieval: /\b(my notes|my sources|uploaded|workspace)\b/.test(text),
    needsTools,
    needsVision,
    longContext,
    confidence,
    rationale: rule
      ? `Matched ${intent} keywords; ${complexity} by length/markers.`
      : `No intent keywords; treated as ${complexity} chat.`,
  };
}

/** Always returns the same classification. Handy for pinning policy in tests. */
export class FixedClassifier implements Classifier {
  constructor(private readonly classification: TurnClassification | null, private readonly error: string | null = null) {}
  async classify(): Promise<ClassifyResult> {
    return { classification: this.classification, durationMs: 0, error: this.error };
  }
}
