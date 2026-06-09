/**
 * forecast_service.ts — MODEL-02 monthly spending forecaster serving (ARIMA_PLUS).
 *
 * Runs ML.FORECAST and returns a tidy per-user forecast. The row mapper
 * (`mapForecastRows`) is PURE and unit-tested; BigQuery is imported lazily inside
 * `main()` so this module (and its tests) stay dependency-light.
 */

export interface ForecastRow {
  user_id?: string;
  forecast_timestamp?: string | { value: string };
  forecast_value?: number | string;
  prediction_interval_lower_bound?: number | string;
  prediction_interval_upper_bound?: number | string;
}

export interface ForecastPoint {
  userId: string;
  month: string; // YYYY-MM
  predicted: number;
  lower: number;
  upper: number;
}

/** Normalize a BigQuery TIMESTAMP (string or {value}) to a YYYY-MM month. */
export function toMonth(ts: ForecastRow['forecast_timestamp']): string {
  const raw = typeof ts === 'object' && ts ? ts.value : ts;
  if (!raw) return '';
  return String(raw).slice(0, 7); // YYYY-MM
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const cents = (n: number): number => Math.round(n * 100) / 100;

/** PURE: map ML.FORECAST rows to clean forecast points (intervals clamped ≥ 0). */
export function mapForecastRows(rows: ForecastRow[]): ForecastPoint[] {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.user_id)
    .map((r) => ({
      userId: String(r.user_id),
      month: toMonth(r.forecast_timestamp),
      predicted: cents(Math.max(0, num(r.forecast_value))),
      lower: cents(Math.max(0, num(r.prediction_interval_lower_bound))),
      upper: cents(Math.max(0, num(r.prediction_interval_upper_bound))),
    }));
}

async function main(): Promise<void> {
  const PROJECT = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT || '';
  const DATASET = process.env.BQ_DATASET || 'splitcircle_ml';
  const REGION = process.env.GCP_REGION || 'us-central1';
  // Variable specifier so this light harness needn't install the BigQuery client
  // just to typecheck the pure mapper (resolved at runtime in the pipeline SA env).
  const spec = '@google-cloud/bigquery';
  const { BigQuery } = await import(spec);
  const bq = new BigQuery();
  const [rows] = await bq.query({
    query: `SELECT user_id, forecast_timestamp, forecast_value,
                   prediction_interval_lower_bound, prediction_interval_upper_bound
            FROM ML.FORECAST(MODEL \`${PROJECT}.${DATASET}.spending_forecaster\`,
              STRUCT(3 AS horizon, 0.8 AS confidence_level))`,
    location: REGION,
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(mapForecastRows(rows as ForecastRow[]), null, 2));
}

if (process.argv[1] && process.argv[1].endsWith('forecast_service.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
