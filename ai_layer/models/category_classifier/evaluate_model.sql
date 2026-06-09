-- evaluate_model.sql
-- Evaluate MODEL-01 on its held-out split. Promotion gate (Phase 5): accuracy ≥ 0.80.
-- Also surfaces per-class metrics so we can see which categories are weak.
-- Replace ${PROJECT}/${DATASET}.

-- Aggregate metrics (precision, recall, accuracy, f1_score, log_loss, roc_auc):
SELECT * FROM ML.EVALUATE(MODEL `${PROJECT}.${DATASET}.expense_category_classifier`);

-- Per-class confusion (uncomment to inspect):
-- SELECT * FROM ML.CONFUSION_MATRIX(MODEL `${PROJECT}.${DATASET}.expense_category_classifier`);
