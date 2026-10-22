import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import {
  AiSdkClassifier,
  buildClassifierPrompt,
  CLASSIFIER_SYSTEM,
  estimateTokens,
  FixedClassifier,
  HeuristicClassifier,
  heuristicClassify,
  truncate,
  type ClassifyInput,
} from '../src/classify.js';
import { formatDecision } from '../src/format.js';
import { ProviderHealth } from '../src/health.js';
import { Router } from '../src/router.js';
import { TurnClassification } from '../src/types.js';
import { classification, fixedClock, preference, priorDecision, TEST_CATALOG } from './fixtures.js';

const turn = (prompt: string, overrides: Partial<ClassifyInput> = {}): ClassifyInput => ({
  prompt,
  recentTurns: [],
  attachedContext: [],
  workspaceKind: null,
  ...overrides,
});

const generateResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 10, text: 10, reasoning: undefined },
  },
  warnings: [],
});

describe('AiSdkClassifier', () => {
  it('returns the structured classification from the model', async () => {
    const expected = classification({ intent: 'math', complexity: 'hard', domain: 'algebra' });
    const model = new MockLanguageModelV4({ doGenerate: generateResult(JSON.stringify(expected)) });
    const result = await new AiSdkClassifier(model).classify(turn('prove it'));
    expect(result.error).toBeNull();
    expect(result.classification).toEqual(expected);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const call = model.doGenerateCalls[0]!;
    expect(JSON.stringify(call.prompt)).toContain('Current turn:\\nprove it');
    expect(JSON.stringify(call.prompt)).toContain('You are not answering the question');
    expect(call.maxOutputTokens).toBe(512);
  });

  it('never throws: schema violations become classification null + error', async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResult('{"intent":"dance"}') });
    const result = await new AiSdkClassifier(model).classify(turn('x'));
    expect(result.classification).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('never throws: provider errors become classification null + error', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('provider down');
      },
    });
    const result = await new AiSdkClassifier(model, { maxOutputTokens: 64 }).classify(turn('x'));
    expect(result).toMatchObject({ classification: null });
    expect(result.error).toContain('provider down');
  });

  it('stringifies non-Error throws', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw 'just a string';
      },
    });
    const result = await new AiSdkClassifier(model).classify(turn('x'));
    expect(result.error).toContain('just a string');
  });
});

describe('buildClassifierPrompt', () => {
  it('includes truncated history, attachments and workspace kind', () => {
    const prompt = buildClassifierPrompt(
      turn('current', {
        recentTurns: [
          { role: 'user', text: 'a'.repeat(500) },
          { role: 'assistant', text: 'short' },
        ],
        attachedContext: ['notes.pdf', 'slides.pptx'],
        workspaceKind: 'course',
      }),
    );
    expect(prompt).toContain(`Recent turns:\nuser: ${'a'.repeat(400)}…\nassistant: short\n\nCurrent turn:\ncurrent`);
    expect(prompt).toContain('Attached context: notes.pdf, slides.pptx');
    expect(prompt).toContain('Workspace kind: course');
  });

  it('is just the current turn when there is no context', () => {
    expect(buildClassifierPrompt(turn('hi'))).toBe('Current turn:\nhi');
  });

  it('truncates very long prompts to 2000 chars', () => {
    expect(buildClassifierPrompt(turn('x'.repeat(3_000)))).toBe(`Current turn:\n${'x'.repeat(2_000)}…`);
  });

  it('exposes the system prompt and helpers', () => {
    expect(CLASSIFIER_SYSTEM).toContain('complexity is about required reasoning');
    expect(truncate('abc', 5)).toBe('abc');
    expect(estimateTokens('a'.repeat(36))).toBe(10);
  });
});

describe('HeuristicClassifier', () => {
  it('always produces a schema-valid classification', async () => {
    for (const prompt of ['', 'hi', 'Prove this theorem', 'summarize the entire document', 'x '.repeat(200)]) {
      const { classification: c } = await new HeuristicClassifier().classify(turn(prompt));
      expect(TurnClassification.safeParse(c).success).toBe(true);
    }
  });

  it.each([
    ['Prove the derivative of x^2 is 2x', 'math'],
    ['Fix this bug in my rust function', 'code'],
    ['Find papers on transformers', 'research'],
    ['Plot a chart of these numbers', 'visualize'],
    ['tl;dr this article', 'summarize'],
    ['quiz me on chapter 3', 'tutor'],
    ['look at this photo', 'media'],
    ['what did we decide yesterday', 'recall'],
    ['explain entropy', 'explain'],
    ['good morning', 'chat'],
  ])('%s → %s', (prompt, intent) => {
    expect(heuristicClassify(turn(prompt)).intent).toBe(intent);
  });

  it('grades complexity from markers and length', () => {
    expect(heuristicClassify(turn('hey there')).complexity).toBe('trivial');
    expect(heuristicClassify(turn('remind me what we said last time about it please')).complexity).toBe('trivial');
    expect(heuristicClassify(turn('explain entropy')).complexity).toBe('standard');
    expect(heuristicClassify(turn('compare these two approaches')).complexity).toBe('hard');
    expect(heuristicClassify(turn('word '.repeat(90))).complexity).toBe('hard');
    expect(heuristicClassify(turn('a novel derivation')).complexity).toBe('expert');
  });

  it('flags tools, vision, long context and retrieval', () => {
    const c = heuristicClassify(turn('search my notes and look at this screenshot of the whole document'));
    expect(c).toMatchObject({ needsTools: true, needsVision: true, longContext: true, needsRetrieval: true });
    expect(heuristicClassify(turn('hi', { attachedContext: ['x'.repeat(25_000)] })).longContext).toBe(true);
  });

  it('is unsure about unmatched non-trivial prompts (confidence < 0.55)', () => {
    expect(heuristicClassify(turn('tell me something interesting about octopuses and their unusual nervous systems')).confidence).toBeLessThan(0.55);
  });
});

describe('Router (full pipeline)', () => {
  it('classifies, routes, and reports a context switch', async () => {
    const router = new Router({ classifier: new HeuristicClassifier(), catalog: TEST_CATALOG, now: fixedClock });
    const first = await router.routeTurn({ turn: turn('hey there'), preference: preference(), previous: null, estimatedInputTokens: 10 });
    expect(first.decision.modelId).toBe('fast-cheap');
    expect(first.contextSwitch).toBe(false);
    expect(first.classifierError).toBeNull();

    const second = await router.routeTurn({
      turn: turn('Prove the theorem'),
      preference: preference(),
      previous: first.decision,
      estimatedInputTokens: 10,
    });
    expect(second.decision.tier).toBe('deep');
    expect(second.decision.switchedFrom).toBe('fast-cheap');
    expect(second.contextSwitch).toBe(true);
  });

  it('does not call the classifier for pinned conversations', async () => {
    let calls = 0;
    const router = new Router({
      classifier: { classify: async () => ((calls += 1), { classification: null, durationMs: 0, error: null }) },
      catalog: TEST_CATALOG,
    });
    const { decision } = await router.routeTurn({
      turn: turn('x'),
      preference: preference({ mode: 'pinned', pinnedModelId: 'deep-main' }),
      previous: null,
      estimatedInputTokens: 10,
    });
    expect(calls).toBe(0);
    expect(decision.mode).toBe('pinned');
  });

  it('surfaces classifier errors and still decides (upward fallback)', async () => {
    const router = new Router({ classifier: new FixedClassifier(null, 'timeout'), catalog: TEST_CATALOG });
    const routed = await router.routeTurn({ turn: turn('x'), preference: preference(), previous: null, estimatedInputTokens: 10 });
    expect(routed.classifierError).toBe('timeout');
    expect(routed.decision.mode).toBe('fallback');
  });

  it('routes around providers that health tracking says are down', async () => {
    const health = new ProviderHealth({ now: () => 0 });
    await health.record({ provider: 'anthropic', ok: false, message: 'insufficient balance' });
    const router = new Router({
      classifier: new FixedClassifier(classification({ complexity: 'hard', needsVision: true })),
      catalog: TEST_CATALOG,
      health,
    });
    const { decision } = await router.routeTurn({ turn: turn('x'), preference: preference(), previous: null, estimatedInputTokens: 10 });
    expect(decision.modelId).toBe('deep-novision');
    expect(decision.rejected.at(-1)).toEqual({ modelId: 'deep-main', reason: 'Provider is out of credit' });
  });

  it('respects an explicit configuredProviders list', async () => {
    const router = new Router({
      classifier: new FixedClassifier(classification({ complexity: 'trivial' })),
      catalog: TEST_CATALOG,
      configuredProviders: ['google'],
    });
    const { decision } = await router.routeTurn({ turn: turn('x'), preference: preference(), previous: null, estimatedInputTokens: 10 });
    expect(decision.modelId).toBe('fast-vision');
    expect(decision.reason).toBe('fast-cheap is not configured; using fast-vision.');
  });

  it('uses the example catalog by default', async () => {
    const router = new Router({ classifier: new HeuristicClassifier() });
    const { decision } = await router.routeTurn({ turn: turn('hi'), preference: preference(), previous: null, estimatedInputTokens: 10 });
    expect(decision.modelId).toBe('gemini-3.5-flash-lite');
  });
});

describe('formatDecision', () => {
  it('renders the audit block including rejected candidates and topic shift', () => {
    const text = formatDecision(
      priorDecision({
        modelId: 'deep-main',
        tier: 'deep',
        switchedFrom: 'bal-main',
        classification: classification({ intent: 'code', domain: 'rust', needsTools: true, needsVision: true, longContext: true, needsRetrieval: true }),
        rejected: [
          { modelId: 'a', reason: 'no vision support' },
          { modelId: 'b', reason: 'no tool support' },
        ],
      }),
      { contextSwitch: true },
    );
    expect(text).toContain('model       deep-main (deep)');
    expect(text).toContain('classified  code · standard · conf 0.90 · rust');
    expect(text).toContain('needs       tools, vision, long context, retrieval');
    expect(text).toContain('switched    from bal-main (topic shift)');
    expect(text).toContain('rejected    a — no vision support\n              b — no tool support');
  });

  it('renders unclassified and no-thinking decisions', () => {
    const text = formatDecision(priorDecision({ classification: null, thinking: false, maxOutputTokens: 8_000 }));
    expect(text).toContain('classified  — (no classification)');
    expect(text).toContain('needs       —');
    expect(text).toContain('effort      medium · max 8000 out');
    expect(text).toContain('switched    no');
    expect(text).toContain('rejected    none');
  });

  it('says "none" when a classified turn needs nothing special', () => {
    expect(formatDecision(priorDecision())).toContain('needs       none');
  });
});
