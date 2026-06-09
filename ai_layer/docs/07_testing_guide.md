# 07 — Testing Guide

What is tested, how to run it, and — importantly — what can and cannot be verified without a
live GCP project.

## Test layers

| Layer | What | Where | Needs GCP? |
|---|---|---|---|
| **Unit** | Pure logic + every MCP tool (validation, membership, output shape) | `mcp/*/src/__tests__`, `services/rag/__tests__` | ❌ No |
| **Integration** | Embedding idempotency, BQ mapping, RAG end-to-end on emulator + stubbed Vector Search | (templates below) | Emulator only |
| **Live integration** | Real Vertex / BigQuery / Cloud Run / Firebase tokens | manual | ✅ Yes |
| **RAG quality** | RAGAS-style metrics on a golden set | `eval/` (to add) | Vertex (Gemini) |
| **Model quality** | `ML.EVALUATE` accuracy gate | BigQuery | ✅ Yes |

## Running the unit tests (no GCP)

```bash
# MCP servers
cd ai_layer/mcp/splitcircle-core      && npm install && npm test
cd ai_layer/mcp/splitcircle-insights  && npm install && npm test

# RAG service (uses the same vitest tooling)
cd ai_layer/services/rag && npm install && npm test   # see vitest config note below
```

Unit tests use **dependency injection + in-memory fakes** for Firestore, Vector Search,
BigQuery, and Gemini — so they run fully offline and deterministically. Coverage includes:

- **RAG** (`services/rag/__tests__/rag_service.test.ts`): full pipeline, the `userId`
  security boundary, neighbor-order preservation, the no-results short-circuit (no LLM call),
  caching, and all `context_builder` filters/confidence.
- **splitcircle-core** (`src/__tests__/tools.test.ts`): balance + debt-minimization math
  (asserts the exact greedy result), all 7 tools, membership enforcement, `add_expense`
  validation (share-sum, non-member payer), and the rate limiter (burst + refill).
- **splitcircle-insights** (`src/__tests__/insights.test.ts`): summarize / compare / anomaly /
  contribution helpers, plus all 5 tools and error propagation.

## RAG quality (RAGAS metrics)

Build a golden set of `{ question, expected_answer, relevant_expense_ids }` from real
(anonymized) expenses, then score generated answers on:

| Metric | Meaning | Release gate |
|---|---|---|
| **Faithfulness** | Answer is supported by retrieved context (no hallucination) | ≥ 0.85 |
| **Answer relevancy** | Answer addresses the question | ≥ 0.80 |
| **Context precision** | Retrieved expenses are actually relevant | ≥ 0.70 |
| **Context recall** | Relevant expenses were retrieved | ≥ 0.70 |

Money answers are unforgiving, so faithfulness is the hard gate. Run RAGAS (Vertex Gemini as
judge) in CI against the golden set; fail the build below the gates.

## Model quality (classifier)

```bash
bq query --use_legacy_sql=false < models/category_classifier/evaluate_model.sql
```
Promotion gate: **accuracy ≥ 0.80** (and inspect `ML.CONFUSION_MATRIX` for weak classes). The
retrain job re-runs eval weekly; alert on a drop > 5 points.

## Integration test templates (emulator)

- **Embedding idempotency:** write the same expense twice → assert exactly one
  `upsertDatapoint` call and a stable `_embedHashes` entry.
- **Sync mapping:** push a group doc into the Firestore emulator → assert the unnested BQ rows
  match `mapExpenseRow` output (run against a BQ sandbox or a fake insert client).
- **RAG end-to-end:** seed the emulator, stub Vector Search to return known ids → assert the
  cited answer references the right sources.

## Sandbox caveat (honest scope)

This repository ships **code + unit tests + a runnable harness**. It was authored in an
isolated environment **without** a GCP project, Vertex AI, BigQuery, or Firebase credentials,
so the following are **not** executed here and require a real project to validate:
deploying MCP servers to Cloud Run, populating/querying the Vector Search index, running
BigQuery ML training/prediction, and live RAGAS evaluation. Each component documents its live
verification steps in its own README.
