-- train_forecast.sql
-- Train MODEL-02: a per-user monthly spending forecaster (BQML ARIMA_PLUS).
-- One time series per user; auto_arima picks the model. Uses the normalized
-- amount so multi-currency users forecast in one reporting currency (Open Q#5).
-- Replace ${PROJECT}/${DATASET}.

CREATE OR REPLACE MODEL `${PROJECT}.${DATASET}.spending_forecaster`
OPTIONS (
  model_type = 'ARIMA_PLUS',
  time_series_timestamp_col = 'month',
  time_series_data_col = 'total',
  time_series_id_col = 'user_id',
  horizon = 3,
  auto_arima = TRUE,
  data_frequency = 'MONTHLY',
  clean_spikes_and_dips = TRUE
) AS
SELECT
  paid_by AS user_id,
  TIMESTAMP_TRUNC(created_at, MONTH) AS month,
  SUM(COALESCE(amount_normalized, amount)) AS total
FROM `${PROJECT}.${DATASET}.expenses`
GROUP BY user_id, month;
