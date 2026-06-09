-- predict.sql
-- Inference template for MODEL-01. Returns the predicted category and the model's
-- confidence (max class probability). The serving Cloud Function (predict_service.ts)
-- runs a single-row version of this with parameters.
--
-- Single-expense prediction (parameterized): @title, @amount, @hour, @dow, @pcount.
SELECT
  predicted_label AS category,
  (
    SELECT MAX(p.prob)
    FROM UNNEST(predicted_label_probs) AS p
  ) AS confidence
FROM ML.PREDICT(
  MODEL `${PROJECT}.${DATASET}.expense_category_classifier`,
  (
    SELECT
      LOWER(TRIM(@title))      AS title,
      @amount                  AS amount,
      @hour                    AS hour_of_day,
      @dow                     AS day_of_week,
      @pcount                  AS participant_count
  )
);

-- Batch backfill: categorize all currently-uncategorized expenses (write-back is
-- handled by the app/service only when the user left the category blank).
-- SELECT expense_id, predicted_label AS category
-- FROM ML.PREDICT(
--   MODEL `${PROJECT}.${DATASET}.expense_category_classifier`,
--   (SELECT expense_id, LOWER(TRIM(title)) AS title, amount,
--           EXTRACT(HOUR FROM created_at) AS hour_of_day,
--           EXTRACT(DAYOFWEEK FROM created_at) AS day_of_week,
--           participant_count
--    FROM `${PROJECT}.${DATASET}.expenses`
--    WHERE category IS NULL OR LOWER(TRIM(category)) = 'uncategorized')
-- );
