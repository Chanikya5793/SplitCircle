-- create_training_data.sql
-- Build the training dataset for MODEL-01 (expense category classifier) from the
-- synced expense history. Adapted to SplitCircle's real schema (Phase 1): the text
-- field is `title` (not `description`), and there is no user-set expense date, so we
-- use `created_at` for temporal features.
--
-- Only rows with a human-set category are used as labels; very rare categories are
-- folded into 'other' to avoid degenerate classes. Replace ${PROJECT}/${DATASET}.

CREATE OR REPLACE TABLE `${PROJECT}.${DATASET}.expense_training_data` AS
WITH labeled AS (
  SELECT
    LOWER(TRIM(title))                       AS title,
    amount,
    EXTRACT(HOUR      FROM created_at)        AS hour_of_day,
    EXTRACT(DAYOFWEEK FROM created_at)        AS day_of_week,
    participant_count,
    LOWER(TRIM(category))                     AS category
  FROM `${PROJECT}.${DATASET}.expenses`
  WHERE category IS NOT NULL
    AND TRIM(category) != ''
    AND LOWER(TRIM(category)) != 'uncategorized'
    AND title IS NOT NULL
    AND created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 365 DAY)
),
counts AS (
  SELECT category, COUNT(*) AS n FROM labeled GROUP BY category
)
SELECT
  l.title,
  l.amount,
  l.hour_of_day,
  l.day_of_week,
  l.participant_count,
  -- Fold rare categories (< 20 examples) into 'other'.
  IF(c.n < 20, 'other', l.category) AS label
FROM labeled l
JOIN counts c USING (category);
