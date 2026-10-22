/**
 * Routes a short scripted conversation and prints the audit trail for each
 * turn. Uses the deterministic HeuristicClassifier, so no API keys are needed
 * and the output is identical on every run.
 *
 *   pnpm demo           # readable audit blocks
 *   pnpm demo --json    # full RouteDecision records as JSON
 */
import {
  estimateTokens,
  formatDecision,
  HeuristicClassifier,
  ProviderHealth,
  Router,
  RoutingPreference,
  type RouteDecision,
} from '../src/index.js';

interface DemoTurn {
  label: string;
  prompt: string;
  attachedTokens?: number;
  preference?: Partial<RoutingPreference>;
}

const TURNS: DemoTurn[] = [
  { label: 'small talk', prompt: 'hey, thanks!' },
  { label: 'one-line proof question', prompt: 'Prove that the square root of 2 is irrational.' },
  { label: 'debugging with tools', prompt: 'Debug this TypeScript function and run the tests: it returns undefined on empty arrays.' },
  { label: 'recall (ceiling)', prompt: 'Remind me what we decided last time about the schema?' },
  { label: 'vision', prompt: 'What is going on in this photo of my whiteboard notes?' },
  { label: 'huge attachment', prompt: 'Summarize the key points of the entire transcript.', attachedTokens: 400_000 },
  { label: 'cost ceiling', prompt: 'Walk me through the tradeoffs of event sourcing vs CRUD design.', preference: { maxTier: 'fast' } },
  { label: 'pinned model', prompt: 'Anything at all.', preference: { mode: 'pinned', pinnedModelId: 'claude-sonnet-5' } },
];

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');

  // A fixed clock keeps `decidedAt` stable so the demo output is reproducible.
  const fixedClock = new Date('2026-01-01T12:00:00.000Z');
  const health = new ProviderHealth({ now: () => fixedClock.getTime() });

  // Simulate what real traffic would have taught the health store: one provider
  // answered "insufficient balance" — a terminal fault that does not age out.
  await health.record({
    provider: 'anthropic',
    ok: false,
    message: 'Payment required | {"error":"insufficient balance"} | status 402',
  });

  const router = new Router({
    classifier: new HeuristicClassifier(),
    health,
    now: () => fixedClock,
  });

  let previous: RouteDecision | null = null;
  const records: Array<{ turn: string; prompt: string; contextSwitch: boolean; decision: RouteDecision }> = [];

  if (!asJson) {
    console.log('Provider health: anthropic marked unusable (out of credit, terminal).\n');
  }

  for (const [index, turn] of TURNS.entries()) {
    const preference = RoutingPreference.parse(turn.preference ?? {});
    const { decision, contextSwitch } = await router.routeTurn({
      turn: { prompt: turn.prompt, recentTurns: [], attachedContext: [], workspaceKind: null },
      preference,
      previous,
      estimatedInputTokens: estimateTokens(turn.prompt) + (turn.attachedTokens ?? 0),
    });

    records.push({ turn: turn.label, prompt: turn.prompt, contextSwitch, decision });
    if (!asJson) {
      console.log(`#${index + 1} ${turn.label}`);
      console.log(`  "${turn.prompt}"`);
      console.log(formatDecision(decision, { contextSwitch }));
      console.log('');
    }
    previous = decision;
  }

  if (asJson) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  // Compact summary table.
  console.table(
    records.map(({ turn, decision, contextSwitch }) => ({
      turn,
      model: decision.modelId,
      tier: decision.tier,
      mode: decision.mode,
      effort: decision.effort,
      rejected: decision.rejected.length,
      topicShift: contextSwitch,
    })),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
