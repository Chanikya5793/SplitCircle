-- train_model.sql
-- Train MODEL-01: a multi-class logistic regression that predicts an expense
-- category from its title text, amount, and time features. BigQuery ML applies
-- TF-IDF style featurization to STRING columns automatically, so `title` works as
-- a text feature without manual tokenization.
--
-- auto_class_weights handles category imbalance; a held-out split lets ML.EVALUATE
-- report honest accuracy. Replace ${PROJECT}/${DATASET}.

CREATE OR REPLACE MODEL `${PROJECT}.${DATASET}.expense_category_classifier`
OPTIONS (
  model_type = 'LOGISTIC_REG',
  input_label_cols = ['label'],
  auto_class_weights = TRUE,
  data_split_method = 'AUTO_SPLIT',
  max_iterations = 50,
  early_stop = TRUE
) AS
SELECT
  title,
  amount,
  hour_of_day,
  day_of_week,
  participant_count,
  label
FROM `${PROJECT}.${DATASET}.expense_training_data`;
