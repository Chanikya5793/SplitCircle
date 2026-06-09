# SplitCircle AI Intelligence Layer

A GCP / Vertex AI intelligence layer on top of the SplitCircle bill-splitting app:
**RAG over your own expenses**, **MCP servers** for AI assistants, and **BigQuery ML**
models for auto-categorization and anomaly detection.

> Built in six grounded phases. Start with `SPLITCIRCLE_AI_MASTER_PLAN.md` for the full
> story, or `docs/01_codebase_analysis.md` for how the existing app actually works.

## What's here

```
ai_layer/
├── README.md                       ← you are here
├── SPLITCIRCLE_AI_MASTER_PLAN.md   ← Phase 5: the compiled plan
├── .env.example                    ← config template (no secrets)
├── setup/gcp_setup.sh              ← idempotent GCP provisioning
├── docs/                           ← Phase 1–4 analysis + usage/API/testing guides
├── pipelines/
│   ├── firestore_to_bq/            ← unnest groups.expenses[] → BigQuery
│   └── embedding/                  ← expenses → text-embedding-005 → Vector Search
├── services/rag/                   ← queryExpenseRAG (embed→search→hydrate→Gemini)
├── models/category_classifier/     ← BigQuery ML MODEL-01 (+ auto-categorize Fn)
└── mcp/
    ├── splitcircle-core/           ← CRUD + settlements + RAG search (Cloud Run)
    └── splitcircle-insights/       ← spending intelligence (Cloud Run)
```

## The one thing to know

SplitCircle stores expenses as an **embedded array inside each group document**
(`groups/{groupId}.expenses[]`) — not a flat `/expenses` collection. So every pipeline here
triggers on **group writes and unnests the array**. This is the load-bearing design decision;
see `docs/01_codebase_analysis.md` §6.

## Quick start

```bash
# 1. Provision GCP (APIs, IAM, dataset, bucket, secrets, vector index)
PROJECT_ID=my-proj REGION=us-central1 ./setup/gcp_setup.sh

# 2. Create BQ tables + backfill (see pipelines/firestore_to_bq/README.md)
# 3. Populate the vector index (pipelines/embedding/batch_embed.py)
# 4. Train the classifier (models/category_classifier/README.md)

# 5. Run the MCP servers' tests (no GCP needed)
cd mcp/splitcircle-core && npm install && npm test
cd ../splitcircle-insights && npm install && npm test

# 6. Deploy MCP servers to Cloud Run
cd mcp/splitcircle-core && PROJECT_ID=my-proj ./deploy.sh
```

## Component map

| Component | Reads | Writes | Hosted on |
|---|---|---|---|
| `firestore_to_bq` | `groups/{id}` | BigQuery `splitcircle_ml.*` | Cloud Functions |
| `embedding` | `groups/{id}` | Vector Search + `_embedHashes` | Cloud Functions / batch |
| `services/rag` | Vector Search + Firestore + Gemini | — | library (used by MCP) |
| `category_classifier` | BigQuery | Firestore (blank categories only) | BigQuery ML + Function |
| `splitcircle-core` MCP | Firestore (+ RAG) | `groups.expenses[]` (add_expense) | Cloud Run |
| `splitcircle-insights` MCP | BigQuery + Firestore + RAG | — | Cloud Run |

## Critical rules honored

No hardcoded secrets · per-user RAG isolation (`restricts` + membership) · PII excluded from
embeddings/logs · Gemini **Flash** for cost · idempotent pipelines · TypeScript-first · unit
tests for every tool · documented throughout. See `docs/07_testing_guide.md` for what is and
isn't runnable in a sandbox without a live GCP project.
