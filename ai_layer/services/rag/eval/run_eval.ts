/**
 * run_eval.ts — Run the RAG golden set against the live service and gate on
 * faithfulness. Requires a configured GCP backend (Vertex/Vector Search/Gemini)
 * and `EVAL_USER_ID` (a uid with seeded expenses). Exits non-zero if the gate
 * fails, so it can run in a pre-release pipeline.
 *
 *   GCP_PROJECT_ID=p EVAL_USER_ID=uid node eval/run_eval.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runExpenseQuery } from '../rag_deps';
import { scoreSample, aggregate, type GoldenCase, type SampleScore } from './ragas';

async function main(): Promise<void> {
  const userId = process.env.EVAL_USER_ID;
  if (!userId) throw new Error('EVAL_USER_ID is required (a uid with seeded expenses)');
  const here = dirname(fileURLToPath(import.meta.url));
  const cases = JSON.parse(readFileSync(join(here, 'golden_set.json'), 'utf8')) as GoldenCase[];
  const gate = Number(process.env.GATE_FAITHFULNESS ?? 0.85);

  const scores: SampleScore[] = [];
  for (const gold of cases) {
    const res = await runExpenseQuery({ query: gold.question, userId });
    const score = scoreSample(gold, res.answer, res.generationMetadata.used);
    scores.push(score);
    // eslint-disable-next-line no-console
    console.log(`${score.pass ? '✓' : '✗'} ${gold.question} (faith=${score.faithfulness.toFixed(2)}, rel=${score.answerRelevancy.toFixed(2)})`);
  }

  const agg = aggregate(scores, gate);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(agg, null, 2));
  if (!agg.gatePassed) {
    // eslint-disable-next-line no-console
    console.error(`RAGAS gate FAILED: meanFaithfulness ${agg.meanFaithfulness} < ${gate}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('run_eval.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
