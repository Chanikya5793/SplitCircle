# splitcircle-insights MCP Server

Spending-intelligence MCP server: NL summaries, period comparisons, anomaly detection,
grounded Q&A, and group contribution analysis. Backed by BigQuery (`splitcircle_ml`),
the RAG service, and Gemini 2.5 Flash.

## Tools (all read-only)

| Tool | Description | Backed by |
|---|---|---|
| `get_spending_summary` | Total, by-category, top expenses, trend for a period | BigQuery |
| `compare_spending_periods` | Period-over-period delta + NL insight | BigQuery + Gemini |
| `find_unusual_expenses` | Statistical outliers vs. the user's category baseline (MODEL-03 v1) | BigQuery |
| `ask_about_spending` | Grounded NL answer over the user's expenses | RAG service |
| `get_group_contribution_analysis` | Per-member paid vs. owed vs. fair share | Firestore |

## Auth & transport

Same as `splitcircle-core`: Streamable HTTP at `POST /mcp`, Firebase ID-token verified per
request, uid derived from the token (never from args), group membership enforced before any
group data is returned.

## Run / Test / Deploy

```bash
npm install
npm test                              # pure aggregation + tool tests, no GCP
npm run build && npm start            # local :8080
PROJECT_ID=my-proj REGION=us-central1 ./deploy.sh
```

## Notes / extension points

- `getUserRows` approximates `userShare = amount / participant_count` until a
  participant-expanded BigQuery view is materialized (Open Question: add it for exact
  per-member attribution).
- `find_unusual_expenses` is the statistical v1 of MODEL-03; upgrade to BQML
  `ML.DETECT_ANOMALIES` over `ARIMA_PLUS` for seasonality-aware detection.
