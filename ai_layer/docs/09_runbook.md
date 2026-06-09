# Phase 6 — Operations Runbook (provisioning, training, deploy)

> Step-by-step to stand up the AI layer on a real GCP project. Everything here is
> idempotent and safe to re-run. Commands assume `PROJECT_ID`, `REGION`
> (default `us-central1`) and `BQ_DATASET=splitcircle_ml`.

---

## 1. Provision infrastructure

```bash
PROJECT_ID=my-proj REGION=us-central1 ./ai_layer/setup/gcp_setup.sh
```
Creates: APIs · service accounts (`sc-mcp`, `sc-pipeline`, `sc-embed`, `sc-rag`) ·
BQ dataset **and tables** (`expenses`/`settlements`/`groups`/`users`, expenses+settlements
day-partitioned on `created_at`) · GCS artifacts bucket · empty secrets
(`GEMINI_API_KEY`, `MCP_SHARED_SECRET`, `RAG_SHARED_SECRET`) · the streaming Vector Search index.

Add secret values (never commit them):
```bash
printf '%s' "$KEY" | gcloud secrets versions add GEMINI_API_KEY --data-file=-
openssl rand -hex 32 | gcloud secrets versions add RAG_SHARED_SECRET --data-file=-
```

Then deploy + record IDs in `.env` (see `.env.example`):
```bash
# Index endpoint + deploy (one-time; provisioning ~30–60 min)
gcloud ai index-endpoints create --display-name=sc-expense-memory-ep --region="$REGION" --public-endpoint-enabled
gcloud ai index-endpoints deploy-index <ENDPOINT_ID> --index=<INDEX_ID> \
  --deployed-index-id=sc_expense_memory_v1 --region="$REGION"
# → set VECTOR_INDEX_ID / VECTOR_INDEX_ENDPOINT_ID / VECTOR_DEPLOYED_INDEX_ID / VECTOR_ENDPOINT_HOST
```

## 2. Backfill + go live

```bash
# One-time history load (uses the same row mappers as the live trigger)
GCP_PROJECT_ID=$PROJECT_ID BQ_DATASET=$BQ_DATASET npx tsx ai_layer/pipelines/firestore_to_bq/backfill.ts
# One-time embedding backfill
VECTOR_INDEX_ID=... python ai_layer/pipelines/embedding/batch_embed.py
```
Then enable the consolidated ingestion trigger by setting `AI_LAYER_ENABLED=true`
(+ `AI_LAYER_DIST`) in the Functions runtime and deploying `functions/`.

## 3. Train + gate MODEL-01 (category classifier)

```bash
bq query --use_legacy_sql=false < <(sed "s/\${PROJECT}/$PROJECT_ID/g; s/\${DATASET}/$BQ_DATASET/g" \
  ai_layer/models/category_classifier/create_training_data.sql)
# repeat for train_model.sql
# Gate (exits non-zero if accuracy<MIN_ACCURACY or macro-f1<MIN_F1):
GCP_PROJECT_ID=$PROJECT_ID BQ_DATASET=$BQ_DATASET MIN_ACCURACY=0.8 MIN_F1=0.6 \
  node ai_layer/models/category_classifier/promote_model.js
```
Retrain weekly via `retrain_scheduler.yaml`. Only on a passing gate do you keep the
auto-categorize Function enabled.

## 4. Deploy services

| Service | Command (sketch) | SA |
|---|---|---|
| RAG service (Cloud Run) | `gcloud run deploy splitcircle-rag --source ai_layer/services/rag` | `sc-rag` |
| MCP core (Cloud Run) | `gcloud run deploy splitcircle-mcp-core --source ai_layer/mcp/splitcircle-core` | `sc-mcp` |
| MCP insights (Cloud Run) | `gcloud run deploy splitcircle-mcp-insights --source ai_layer/mcp/splitcircle-insights` | `sc-mcp` |

Set the MCP core's `RAG_SERVICE_URL` to the RAG service URL and the matching
`RAG_SHARED_SECRET` on both. Lock the MCP→RAG hop down with Cloud Run IAM
(`run.invoker` for `sc-mcp` on the RAG service) in addition to the shared secret.

## 5. Validate (see `docs/10_validation.md`)

RAGAS faithfulness ≥ 0.85 on the golden set · classifier accuracy ≥ 0.80 ·
p95 latency < 1.8 s · cost within the model in §Cost of the master plan.
