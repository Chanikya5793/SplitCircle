/**
 * aiLoop.test.ts — decision coercion + prompt assembly for the agentic
 * pipeline (doc 24). The coercers are the guard between raw model output and
 * the orchestrator (the doc-17 "coercePlan accepts anything" lesson), and the
 * assemblers are the ONLY place prompts are built — pin their shape.
 */
import { describe, expect, it } from 'vitest';

import type { AiThreadMessage } from '../aiThreads';
import {
  MAX_HOPS,
  assembleHopPrompt,
  assembleNarratorPrompt,
  assembleRouterPrompt,
  coerceDecision,
  coerceLoopStep,
  loopInstructions,
  narratorInstructions,
  routerInstructions,
} from '../aiLoop';
import type { ToolResult } from '../aiTools';

const msg = (role: AiThreadMessage['role'], text: string, over: Partial<AiThreadMessage> = {}): AiThreadMessage => ({
  id: `${role}-${text.slice(0, 8)}-${Math.floor(text.length)}`,
  role,
  text,
  createdAt: 0,
  ...over,
});

describe('coerceDecision', () => {
  it('defaults garbage to a safe answer decision', () => {
    const d = coerceDecision({ intent: 'destroy', confidence: 9, complexity: 'galactic' });
    expect(d.intent).toBe('answer');
    expect(d.confidence).toBe(1);
    expect(d.complexity).toBe('simple');
    expect(d.requests).toEqual([]);
  });

  it('demotes a clarify without a question to answer', () => {
    const d = coerceDecision({ intent: 'clarify', clarifyQuestion: '  ', clarifyOptions: ['A'] });
    expect(d.intent).toBe('answer');
  });

  it('caps and dedupes clarify options at 4', () => {
    const d = coerceDecision({
      intent: 'clarify',
      clarifyQuestion: 'Which one?',
      clarifyOptions: ['A', 'A', 'B', 'C', 'D', 'E'],
    });
    expect(d.clarifyOptions).toEqual(['A', 'B', 'C', 'D']);
  });

  it('cleans requests: drops toolless rows, caps at 3, normalizes 0/empty to unset', () => {
    const d = coerceDecision({
      intent: 'answer',
      requests: [
        { tool: 'month_summary', month: 'april', n: 0, months: 0, category: '' },
        { tool: '', month: 'june' },
        { tool: 'balances' },
        { tool: 'forecast' },
        { tool: 'budgets' },
      ],
    });
    expect(d.requests).toHaveLength(3);
    expect(d.requests[0]).toEqual({
      tool: 'month_summary', month: 'april',
      monthB: undefined, category: undefined, member: undefined,
      merchant: undefined, query: undefined, n: undefined, months: undefined,
    });
  });
});

describe('coerceLoopStep', () => {
  it('empty requests always means done', () => {
    expect(coerceLoopStep({ done: false, requests: [] }).done).toBe(true);
    expect(coerceLoopStep({ done: false, requests: [{ tool: '' }] }).done).toBe(true);
  });

  it('live requests keep the loop open', () => {
    const s = coerceLoopStep({ done: false, requests: [{ tool: 'balances' }] });
    expect(s.done).toBe(false);
    expect(s.requests[0].tool).toBe('balances');
  });
});

describe('instructions', () => {
  it('router instructions carry the contract: catalog, members, abstain, clarify, no-compute', () => {
    const text = routerInstructions({
      scopeLabel: 'the group "Flat 42"',
      memberNames: ['Chan', 'Sam Lee'],
      categories: ['Food'],
      dateLine: 'Saturday, July 19, 2026',
      toolCatalog: '- month_summary(month) — one month in depth.',
    });
    expect(text).toContain('month_summary');
    expect(text).toContain('Sam Lee');
    expect(text).toContain('NEVER compute');
    expect(text).toContain('abstain');
    expect(text).toContain('clarifyOptions');
    expect(text).toContain('July 19, 2026');
  });

  it('narrator instructions kill the sentence cap but keep grounding', () => {
    const text = narratorInstructions({ scopeLabel: 'x', currency: 'USD', dateLine: 'today' });
    expect(text).toContain('up to 3 short paragraphs');
    expect(text).toContain('MUST appear verbatim in FACTS or TOOL RESULTS');
    expect(text).not.toContain('1-3 short, friendly sentences');
  });

  it('loop instructions restate the catalog', () => {
    expect(loopInstructions('- balances() — nets.')).toContain('balances()');
  });
});

describe('prompt assembly', () => {
  const facts = '{"total":485}';

  it('router prompt: facts + resolved-clarify note + the message', () => {
    const a = assembleRouterPrompt({
      facts,
      messages: [msg('clarify', 'Which Sam?', { options: ['Sam Lee', 'Samir'] })],
      userText: 'Sam Lee',
      budgetTokens: 2000,
      resolvedClarify: true,
    });
    expect(a.prompt).toContain('FACTS');
    expect(a.prompt).toContain('do NOT clarify again');
    expect(a.prompt).toContain('Message: Sam Lee');
    expect(a.prompt).toContain('Which Sam?'); // clarify turn rides as context
    expect(a.needsRollup).toBe(false);
  });

  it('drops oldest turns under budget pressure and flags rollup', () => {
    const long = 'x'.repeat(400);
    const a = assembleRouterPrompt({
      facts,
      messages: [msg('user', `old ${long}`), msg('assistant', `mid ${long}`), msg('user', 'recent')],
      userText: 'now?',
      budgetTokens: 160,
    });
    expect(a.needsRollup).toBe(true);
    expect(a.prompt).not.toContain('old x');
    expect(a.prompt).toContain('Message: now?');
  });

  it('hop prompt numbers the results and states the hop budget', () => {
    const results: ToolResult[] = [
      { tool: 'balances', label: 'balances', json: '{"yourBalance":42.5}' },
    ];
    const p = assembleHopPrompt({ userText: 'who owes?', results, hop: 2, maxHops: MAX_HOPS - 1 });
    expect(p).toContain('T1 balances');
    expect(p).toContain(`Hop 2 of ${MAX_HOPS - 1}`);
    expect(p).toContain('who owes?');
  });

  it('narrator prompt carries tool results + assumption + drift note', () => {
    const a = assembleNarratorPrompt({
      facts,
      results: [{ tool: 'month_summary', label: 'April 2026 summary', json: '{"total":125}' }],
      assumption: 'April means April 2026',
      summary: 'Earlier: talked about food.',
      messages: [msg('user', 'aprils total?')],
      userText: 'aprils total?',
      budgetTokens: 3000,
      driftNote: 'The data has changed.',
    });
    expect(a.prompt).toContain('TOOL RESULTS');
    expect(a.prompt).toContain('April 2026 summary');
    expect(a.prompt).toContain('ASSUMPTION: April means April 2026');
    expect(a.prompt).toContain('EARLIER IN THIS CONVERSATION');
    expect(a.prompt).toContain('NOTE: The data has changed.');
    expect(a.prompt.trim().endsWith('Assistant:')).toBe(true);
  });
});
