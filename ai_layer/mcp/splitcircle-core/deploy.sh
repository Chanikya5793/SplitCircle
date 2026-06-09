#!/usr/bin/env bash
#
# deploy.sh — Deploy splitcircle-core to Cloud Run.
# Requires: PROJECT_ID, REGION; the sc-mcp service account from gcp_setup.sh.
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="splitcircle-mcp-core"
SA="sc-mcp@${PROJECT_ID}.iam.gserviceaccount.com"

# Optional: set RAG_SERVICE_URL to the deployed RAG Cloud Run URL to enable
# semantic search_expenses (falls back to substring scan when unset).
RAG_SERVICE_URL="${RAG_SERVICE_URL:-}"

# Gemini calls in this repo use ADC (no API-key secret needed here). The only
# secret this service uses is the MCP→RAG shared secret.
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --source=. \
  --service-account="${SA}" \
  --allow-unauthenticated \
  --set-env-vars="FIREBASE_PROJECT_ID=${PROJECT_ID},GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${REGION},BQ_DATASET=splitcircle_ml${RAG_SERVICE_URL:+,RAG_SERVICE_URL=${RAG_SERVICE_URL}}" \
  --set-secrets="RAG_SHARED_SECRET=RAG_SHARED_SECRET:latest" \
  --cpu=1 --memory=512Mi --min-instances=0 --max-instances=10 --concurrency=40

echo "✅ Deployed. MCP endpoint: \$(gcloud run services describe ${SERVICE} --region=${REGION} --format='value(status.url)')/mcp"
echo "Note: --allow-unauthenticated exposes the URL; the server itself enforces Firebase ID-token auth on every request."
