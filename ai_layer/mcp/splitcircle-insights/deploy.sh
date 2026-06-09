#!/usr/bin/env bash
# deploy.sh — Deploy splitcircle-insights to Cloud Run.
set -euo pipefail
PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="splitcircle-mcp-insights"
SA="sc-mcp@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud run deploy "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" --source=. \
  --service-account="${SA}" --allow-unauthenticated \
  --set-env-vars="FIREBASE_PROJECT_ID=${PROJECT_ID},GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${REGION},BQ_DATASET=splitcircle_ml" \
  --cpu=1 --memory=512Mi --min-instances=0 --max-instances=10 --concurrency=40

echo "✅ Deployed splitcircle-insights. The server enforces Firebase ID-token auth on every request."
