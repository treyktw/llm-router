import type { RouteDecision } from './types.js';

/**
 * Render a decision as a short, human-readable audit block — the same facts the
 * product shows under "View activity", as plain text.
 */
export function formatDecision(decision: RouteDecision, options: { contextSwitch?: boolean } = {}): string {
  const c = decision.classification;
  const rows: Array<[string, string]> = [
    ['model', `${decision.modelId} (${decision.tier})`],
    ['mode', decision.mode],
    ['reason', decision.reason],
    [
      'classified',
      c
        ? `${c.intent} · ${c.complexity} · conf ${c.confidence.toFixed(2)}${c.domain ? ` · ${c.domain}` : ''}`
        : '— (no classification)',
    ],
    [
      'needs',
      c
        ? [c.needsTools && 'tools', c.needsVision && 'vision', c.longContext && 'long context', c.needsRetrieval && 'retrieval']
            .filter(Boolean)
            .join(', ') || 'none'
        : '—',
    ],
    ['effort', `${decision.effort}${decision.thinking ? ' + thinking' : ''} · max ${decision.maxOutputTokens} out`],
    ['switched', decision.switchedFrom ? `from ${decision.switchedFrom}${options.contextSwitch ? ' (topic shift)' : ''}` : 'no'],
  ];
  if (decision.rejected.length === 0) {
    rows.push(['rejected', 'none']);
  } else {
    decision.rejected.forEach((r, index) =>
      rows.push([index === 0 ? 'rejected' : '', `${r.modelId} — ${r.reason}`]),
    );
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n');
}
