# Phase 6 — Validation & Release Gates

> How we prove the AI layer is good enough to ship. Each gate is a runnable check;
> the pure scoring logic is unit-tested in-repo, the live runs require a configured
> GCP backend (see `09_runbook.md`).

---

## 1. RAG quality (RAGAS-style)

Golden set: `services/rag/eval/golden_set.json` (expand over time). Runner:
`services/rag/eval/run_eval.ts` runs each question through the live RAG service and
scores it with the pure metrics in `eval/ragas.ts`:

- **faithfulness** — fraction of the *used* sources the answer actually cites (`[n]`).
- **answerRelevancy** — fraction of the golden `mustInclude` facts present.

```bash
GCP_PROJECT_ID=$PROJECT_ID EVAL_USER_ID=<seeded-uid> GATE_FAITHFULNESS=0.85 \
  node ai_layer/services/rag/eval/run_eval.js
```

**Release gate: mean faithfulness ≥ 0.85** (exits non-zero otherwise). The scoring is
deterministic and CI-able today; swap `scoreSample` for an LLM judge later without
touching the runner. (Metric math covered by `__tests__/ragas.test.ts`.)

## 2. Classifier quality (MODEL-01)

`models/category_classifier/promote_model.js` runs `ML.EVALUATE` and gates on
**accuracy ≥ 0.80** and **macro-F1 ≥ 0.60** (configurable; pure `evaluateGate`
tested). Only a passing gate keeps the auto-categorize Function enabled.

## 3. Latency

`services/rag/eval/load_test.ts` drives the deployed RAG service and reports
p50/p95/p99. **Target: p95 < 1.8 s** end-to-end (exits non-zero if exceeded).

```bash
RAG_URL=<cloud-run-url> RAG_SHARED_SECRET=... EVAL_USER_ID=<uid> \
  CONCURRENCY=5 REQUESTS=100 node ai_layer/services/rag/eval/load_test.js
```

Levers if p95 is high: Cloud Run `min-instances=1` (warm), Memorystore cache on
`hash(query+uid+filters)`, `approximateNeighborsCount` tuning, smaller `topK`.

## 4. Cost (order-of-magnitude, ~1k MAU / ~10k expenses)

| Item | Driver | Est. $/mo |
|---|---|---|
| Embeddings (`text-embedding-005`) | ~10k + re-embeds | < $1 |
| Vector retrieval | **Firestore vector search (v1)** — no always-on node | ~$1–5 |
| Gemini 2.5 Flash (RAG + insights) | ~20k calls × ~2k tok | ~$5–15 |
| BigQuery | storage + query + BQML train/predict/forecast | ~$5–30 |
| Cloud Run (RAG + 2 MCP) | scale-to-zero | ~$5–20 |
| Memorystore (optional) | smallest Redis | ~$35 (skip in v1) |
| **Total (v1, endpoint deferred)** | | **~$20–75/mo** |

Promote to a dedicated Vertex Vector Search **endpoint** (~$60–250/mo floor) only
when query volume justifies it — `searchNeighbors` is the swap seam (Open Q#1).
Token usage is logged per RAG query for attribution (Critical Rule #4).

## 5. Unit-test gate (CI, runs today)

All packages are green and typecheck clean:
RAG **32** · MCP core **20** · MCP insights **14** · pipelines **20** ·
classifier **9** · forecaster **3** · smart-split **6** · notifications **4** ·
receipts **3** · functions **3**.
