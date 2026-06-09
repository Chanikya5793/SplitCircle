# Expense Category Classifier (MODEL-01)

Zero-effort auto-categorization. A BigQuery ML multi-class logistic regression that predicts
an expense `category` from its `title`, `amount`, and time features. Serves via in-warehouse
`ML.PREDICT` (no endpoint to run).

## Why this model first

Phase 1 found categories are **free-form strings with no taxonomy** and many expenses are left
`uncategorized`. This is the highest-ROI, lowest-risk AI win (Phase 2/3): it needs only data we
already have and maps to the most frequent journey (adding an expense).

## Pipeline

| File | Purpose |
|---|---|
| `create_training_data.sql` | Build labeled training set (uses real `title`; folds rare classes into `other`) |
| `train_model.sql` | Train `LOGISTIC_REG` with auto class weights + AUTO_SPLIT |
| `evaluate_model.sql` | `ML.EVALUATE` — promotion gate: accuracy ≥ 0.80 |
| `predict.sql` | Single-row + batch inference templates |
| `predict_service.ts` | Cloud Function: auto-categorize new expenses (only when user left it blank) |
| `retrain_scheduler.yaml` | Weekly retrain manifest |

## Run

```bash
# substitute ${PROJECT}/${DATASET} (e.g. with sed) then:
bq query --use_legacy_sql=false < create_training_data.sql
bq query --use_legacy_sql=false < train_model.sql
bq query --use_legacy_sql=false < evaluate_model.sql
```

## Guardrails

- **Never overwrites a user's category** — write-back only when blank/`uncategorized`
  (Critical Rule #5). Predictions below `CATEGORY_CONFIDENCE` (default 0.6) are not applied.
- Predicted categories are tagged `categorySource: 'model'` so the app can show "auto" and let
  the user correct (correction data improves the next retrain).
- **Note:** `predict_service` write-back re-triggers the group write (and thus embed/sync); the
  blank-check keeps it idempotent and loop-free, but consider debouncing at scale.
