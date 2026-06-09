-- forecast.sql — 3-month-ahead forecast with 80% prediction intervals.
-- Replace ${PROJECT}/${DATASET}.
SELECT
  user_id,
  forecast_timestamp,
  forecast_value,
  prediction_interval_lower_bound,
  prediction_interval_upper_bound
FROM ML.FORECAST(MODEL `${PROJECT}.${DATASET}.spending_forecaster`,
  STRUCT(3 AS horizon, 0.8 AS confidence_level));
