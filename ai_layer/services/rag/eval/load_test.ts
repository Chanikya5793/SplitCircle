/**
 * load_test.ts — Minimal p50/p95 latency probe for the deployed RAG service.
 * Dependency-free (uses fetch + the perf clock). Validates the master-plan target
 * of p95 < 1.8 s end-to-end. Point it at the Cloud Run URL.
 *
 *   RAG_URL=https://rag-xxptest.a.run.app RAG_SHARED_SECRET=... EVAL_USER_ID=uid \
 *   CONCURRENCY=5 REQUESTS=100 node eval/load_test.js
 */

const URL = process.env.RAG_URL || '';
const SECRET = process.env.RAG_SHARED_SECRET || '';
const USER = process.env.EVAL_USER_ID || '';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 5);
const REQUESTS = Number(process.env.REQUESTS ?? 100);
const QUERY = process.env.EVAL_QUERY || 'how much did I spend on food this month?';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function once(): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(`${URL.replace(/\/$/, '')}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-rag-secret': SECRET },
    body: JSON.stringify({ query: QUERY, userId: USER }),
  });
  await res.text();
  if (!res.ok) throw new Error(`status ${res.status}`);
  return performance.now() - t0;
}

async function main(): Promise<void> {
  if (!URL || !USER) throw new Error('RAG_URL and EVAL_USER_ID are required');
  const latencies: number[] = [];
  let errors = 0;
  let inFlight = 0;
  let started = 0;

  await new Promise<void>((resolve) => {
    const pump = () => {
      while (inFlight < CONCURRENCY && started < REQUESTS) {
        started += 1; inFlight += 1;
        once().then((ms) => latencies.push(ms)).catch(() => { errors += 1; })
          .finally(() => { inFlight -= 1; (started >= REQUESTS && inFlight === 0) ? resolve() : pump(); });
      }
    };
    pump();
  });

  latencies.sort((a, b) => a - b);
  const report = {
    requests: REQUESTS, errors,
    p50_ms: Math.round(percentile(latencies, 50)),
    p95_ms: Math.round(percentile(latencies, 95)),
    p99_ms: Math.round(percentile(latencies, 99)),
    targetP95Ms: 1800,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
  if (report.p95_ms > report.targetP95Ms) {
    // eslint-disable-next-line no-console
    console.error(`p95 ${report.p95_ms}ms exceeds target ${report.targetP95Ms}ms`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('load_test.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { percentile };
