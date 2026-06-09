/**
 * promote_model.ts — Promotion gate for MODEL-01 (Phase 5 testing strategy).
 *
 * Runs ML.EVALUATE on the trained classifier and decides whether it clears the
 * release bar (accuracy >= MIN_ACCURACY, macro f1 >= MIN_F1). Exits non-zero when
 * the gate fails so it can sit in a CI/retrain pipeline. The decision logic
 * (`evaluateGate`) is PURE and unit-tested; the BigQuery call lives in `main()`.
 *
 *   GCP_PROJECT_ID=p BQ_DATASET=splitcircle_ml MIN_ACCURACY=0.8 \
 *   node promote_model.js
 */

import { BigQuery } from '@google-cloud/bigquery';

export interface EvalMetrics {
  accuracy?: number | string;
  f1_score?: number | string;
  log_loss?: number | string;
}

export interface GateResult {
  pass: boolean;
  accuracy: number;
  f1: number;
  reasons: string[];
}

/** PURE: decide promotion from ML.EVALUATE metrics. */
export function evaluateGate(m: EvalMetrics, minAccuracy = 0.8, minF1 = 0.6): GateResult {
  const accuracy = Number(m.accuracy ?? 0);
  const f1 = Number(m.f1_score ?? 0);
  const reasons: string[] = [];
  if (!(accuracy >= minAccuracy)) reasons.push(`accuracy ${accuracy.toFixed(3)} < ${minAccuracy}`);
  if (!(f1 >= minF1)) reasons.push(`macro f1 ${f1.toFixed(3)} < ${minF1}`);
  return { pass: reasons.length === 0, accuracy, f1, reasons };
}

async function main(): Promise<void> {
  const PROJECT = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT || '';
  const DATASET = process.env.BQ_DATASET || 'splitcircle_ml';
  const REGION = process.env.GCP_REGION || 'us-central1';
  const bq = new BigQuery();
  const [rows] = await bq.query({
    query: `SELECT * FROM ML.EVALUATE(MODEL \`${PROJECT}.${DATASET}.expense_category_classifier\`)`,
    location: REGION,
  });
  const gate = evaluateGate(
    (rows?.[0] ?? {}) as EvalMetrics,
    Number(process.env.MIN_ACCURACY ?? 0.8),
    Number(process.env.MIN_F1 ?? 0.6),
  );
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(gate, null, 2));
  if (!gate.pass) {
    // eslint-disable-next-line no-console
    console.error(`Promotion gate FAILED: ${gate.reasons.join('; ')}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('Promotion gate PASSED.');
}

if (process.argv[1] && process.argv[1].endsWith('promote_model.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
