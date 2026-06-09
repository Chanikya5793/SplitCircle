#!/usr/bin/env bash
#
# gcp_setup.sh — Idempotent provisioning of the SplitCircle AI layer on GCP.
#
# Enables APIs, creates least-privilege service accounts, a BigQuery dataset, a
# Cloud Storage bucket for ML artifacts, Secret Manager placeholders, and a
# Vertex AI Vector Search index for expense memory.
#
# SAFE TO RE-RUN: every step checks for existence first. No secrets are written
# in plaintext here — only empty secret containers are created (see Critical Rule #1).
#
# Usage:
#   PROJECT_ID=my-proj REGION=us-central1 ./gcp_setup.sh
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
DATASET="${BQ_DATASET:-splitcircle_ml}"
BUCKET="gs://${PROJECT_ID}-splitcircle-ml-artifacts"
INDEX_DISPLAY_NAME="${INDEX_DISPLAY_NAME:-sc-expense-memory}"

echo "▶ Project=${PROJECT_ID} Region=${REGION} Dataset=${DATASET}"
gcloud config set project "${PROJECT_ID}" >/dev/null

# ── 1. Enable required APIs ───────────────────────────────────────────────────
echo "▶ Enabling APIs…"
gcloud services enable \
  aiplatform.googleapis.com \
  bigquery.googleapis.com \
  bigqueryconnection.googleapis.com \
  run.googleapis.com \
  cloudfunctions.googleapis.com \
  documentai.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  pubsub.googleapis.com \
  redis.googleapis.com \
  storage.googleapis.com \
  eventarc.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com

# ── 2. Service accounts (least privilege) ─────────────────────────────────────
create_sa () {  # name, display
  if ! gcloud iam service-accounts describe "$1@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$1" --display-name="$2"
  else
    echo "  ✓ SA $1 exists"
  fi
}
bind () {  # sa, role
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:$1@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$2" --condition=None >/dev/null
}

echo "▶ Service accounts…"
create_sa sc-mcp      "SplitCircle MCP servers"
create_sa sc-pipeline "SplitCircle ML pipeline"
create_sa sc-embed    "SplitCircle embedding pipeline"

# MCP: read Firestore, use Vertex + BQ read, access secrets
for r in roles/datastore.viewer roles/aiplatform.user roles/bigquery.dataViewer \
         roles/bigquery.jobUser roles/secretmanager.secretAccessor; do bind sc-mcp "$r"; done
# Pipeline: train/predict in BQ, use Vertex
for r in roles/bigquery.dataEditor roles/bigquery.jobUser roles/aiplatform.user; do bind sc-pipeline "$r"; done
# Embed: read Firestore, use Vertex, stage to GCS
for r in roles/datastore.user roles/aiplatform.user roles/storage.objectAdmin; do bind sc-embed "$r"; done

# ── 3. BigQuery dataset ───────────────────────────────────────────────────────
echo "▶ BigQuery dataset…"
if ! bq --location="${REGION}" show "${PROJECT_ID}:${DATASET}" >/dev/null 2>&1; then
  bq --location="${REGION}" mk --dataset --description "SplitCircle ML/analytics" "${PROJECT_ID}:${DATASET}"
else
  echo "  ✓ dataset exists"
fi

# ── 4. Cloud Storage bucket ───────────────────────────────────────────────────
echo "▶ Storage bucket…"
if ! gcloud storage buckets describe "${BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "${BUCKET}" --location="${REGION}" --uniform-bucket-level-access
else
  echo "  ✓ bucket exists"
fi

# ── 5. Secret Manager placeholders (NO values committed) ──────────────────────
echo "▶ Secret placeholders…"
for s in GEMINI_API_KEY MCP_SHARED_SECRET; do
  if ! gcloud secrets describe "$s" >/dev/null 2>&1; then
    gcloud secrets create "$s" --replication-policy=automatic
    echo "  → created empty secret $s — add a version with:"
    echo "      printf '%s' \"\$VALUE\" | gcloud secrets versions add $s --data-file=-"
  else
    echo "  ✓ secret $s exists"
  fi
done

# ── 6. Vertex AI Vector Search index (streaming, 768-dim, dot-product) ─────────
echo "▶ Vector Search index…"
if ! gcloud ai indexes list --region="${REGION}" --format="value(displayName)" 2>/dev/null \
      | grep -qx "${INDEX_DISPLAY_NAME}"; then
  TMP_META="$(mktemp)"
  cat > "${TMP_META}" <<JSON
{
  "contentsDeltaUri": "${BUCKET}/index-staging/",
  "config": {
    "dimensions": 768,
    "approximateNeighborsCount": 50,
    "distanceMeasureType": "DOT_PRODUCT_DISTANCE",
    "algorithmConfig": { "treeAhConfig": {} }
  }
}
JSON
  gcloud ai indexes create \
    --region="${REGION}" \
    --display-name="${INDEX_DISPLAY_NAME}" \
    --metadata-file="${TMP_META}" \
    --index-update-method=STREAM_UPDATE
  rm -f "${TMP_META}"
  echo "  → index creation started (provisioning can take ~30–60 min)."
  echo "    Then create an IndexEndpoint and DeployIndex; record IDs in your .env."
else
  echo "  ✓ index '${INDEX_DISPLAY_NAME}' exists"
fi

echo "✅ Done. Next: deploy an IndexEndpoint, set .env (see ai_layer/.env.example), then deploy pipelines + MCP."
