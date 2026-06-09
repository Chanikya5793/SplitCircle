/**
 * ragas.ts — Lightweight, deterministic RAG quality metrics (Phase 5 testing).
 *
 * A full RAGAS run uses an LLM judge; for a CI-able gate we use cheap, transparent
 * proxies that catch the failures we actually care about for grounded money
 * answers: (1) does the answer CITE its retrieved sources, and (2) does it cover
 * the facts the golden question expects ("answer relevancy"). Pure + unit-tested;
 * the LLM-judge upgrade can replace `scoreSample` without changing the runner.
 */

export interface GoldenCase {
  question: string;
  /** Substrings the answer should contain (amounts, merchants, categories). */
  mustInclude: string[];
  /** Minimum number of cited sources expected. */
  minSources?: number;
}

export interface SampleScore {
  faithfulness: number;     // citation coverage: distinct [n] cited / sources used
  answerRelevancy: number;  // fraction of mustInclude tokens present
  pass: boolean;
}

/** Distinct citation markers like [1], [2] in the answer. */
export function citedIndices(answer: string): number[] {
  const set = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
}

/** Faithfulness proxy: how many of the `usedSources` the answer actually cites. */
export function faithfulness(answer: string, usedSources: number): number {
  if (usedSources <= 0) return 0;
  return Math.min(1, citedIndices(answer).length / usedSources);
}

/** Answer relevancy proxy: fraction of expected substrings present (case-insensitive). */
export function answerRelevancy(answer: string, mustInclude: string[]): number {
  if (!mustInclude || mustInclude.length === 0) return 1;
  const lower = answer.toLowerCase();
  const hit = mustInclude.filter((t) => lower.includes(t.toLowerCase())).length;
  return hit / mustInclude.length;
}

export function scoreSample(
  gold: GoldenCase,
  answer: string,
  usedSources: number,
  minFaithfulness = 0.85,
  minRelevancy = 0.8,
): SampleScore {
  const f = faithfulness(answer, usedSources);
  const r = answerRelevancy(answer, gold.mustInclude);
  const enoughSources = usedSources >= (gold.minSources ?? 1);
  return { faithfulness: f, answerRelevancy: r, pass: f >= minFaithfulness && r >= minRelevancy && enoughSources };
}

export interface AggregateScore {
  n: number;
  meanFaithfulness: number;
  meanRelevancy: number;
  passRate: number;
  gatePassed: boolean;
}

/** Aggregate sample scores; the release gate is meanFaithfulness >= 0.85. */
export function aggregate(scores: SampleScore[], gateFaithfulness = 0.85): AggregateScore {
  const n = scores.length;
  const mean = (sel: (s: SampleScore) => number) => (n ? scores.reduce((a, s) => a + sel(s), 0) / n : 0);
  const meanFaithfulness = Number(mean((s) => s.faithfulness).toFixed(3));
  const meanRelevancy = Number(mean((s) => s.answerRelevancy).toFixed(3));
  const passRate = Number(mean((s) => (s.pass ? 1 : 0)).toFixed(3));
  return { n, meanFaithfulness, meanRelevancy, passRate, gatePassed: n > 0 && meanFaithfulness >= gateFaithfulness };
}
