-- evaluate_forecast.sql — ARIMA evaluation (per-series AIC, etc.) for monitoring.
-- Replace ${PROJECT}/${DATASET}.
SELECT * FROM ML.ARIMA_EVALUATE(MODEL `${PROJECT}.${DATASET}.spending_forecaster`);
