# Firestore → BigQuery Sync

Mirrors SplitCircle's Firestore data into the `splitcircle_ml` BigQuery dataset so the
ML models (category classifier, anomaly, forecaster) and the `splitcircle-insights` MCP
server can run SQL analytics.

## Why it triggers on `groups/{groupId}` (not `/expenses/{id}`)

Per **Phase 1**, expenses and settlements are stored as **embedded arrays inside the group
document**. There is no canonical flat `/expenses` collection in production, so the sync
listens to group writes and **unnests** the arrays into flat rows. This is the single most
important design decision in the pipeline.

## Files

| File | Purpose |
|---|---|
| `schema.json` | BigQuery table schemas: `expenses`, `settlements`, `groups`, `users` |
| `sync_function.ts` | Cloud Function v2 (`onDocumentWritten('groups/{groupId}')`) — streaming sync |
| `backfill.ts` | One-time backfill of all existing groups (reuses the same row mappers) |

## Setup

1. Run `../../setup/gcp_setup.sh` (creates the dataset).
2. Create the tables from `schema.json`:
   ```bash
   for t in expenses settlements groups users; do
     bq mk --table "${GCP_PROJECT_ID}:${BQ_DATASET}.$t" \
       <(node -e "console.log(JSON.stringify(require('./schema.json').$t))")
   done
   ```
3. Deploy `sync_function.ts` with the existing Functions codebase (add the export to
   `functions/src/index.ts`, install `@google-cloud/bigquery`). Set `BQ_DATASET` env.
4. Backfill once:
   ```bash
   GCP_PROJECT_ID=... BQ_DATASET=splitcircle_ml \
   GOOGLE_APPLICATION_CREDENTIALS=./sa.json npx ts-node backfill.ts
   ```

## Guarantees

- **Idempotent** — deterministic `insertId = ${id}:${updatedAt}` de-dupes duplicate trigger
  fires; downstream views take the latest `synced_at` per id.
- **PII-minimal** — `notes` free text is reduced to `notes_present`; expense text is never
  logged. `title` is kept (classifier feature). See Critical Rules #3.
- **Append-only** — never mutates; safe to replay.

## Known extension points

- **Right-to-erasure**: on group delete, tombstone/delete BQ rows + Vector Search datapoints.
- **Currency normalization**: add an FX-normalized amount column if cross-currency analytics
  are needed (Open Question #5).
