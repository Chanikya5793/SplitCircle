# SplitCircle AI Intelligence Layer — Master Plan

> Compiled from Phases 1–4. Single source of truth for what the AI layer is, why, and how it
> ships. See `docs/01`–`04` for full detail; this is the executive + roadmap view.

---

## Executive Summary

SplitCircle is a TypeScript React Native / Expo bill-splitting app on Firebase (Firestore +
Cloud Functions v2), already differentiated by **11 split methods** (including gamified
"roulette/karma" splits), a working **Gemini 2.5 Flash** receipt parser, and a greedy
**debt-minimizer**. Its expense data, however, lives **embedded inside each group document**
(`groups/{groupId}.expenses[]`), categories are **free-form strings**, and there is **no
analytics warehouse, no ML categorization, and no conversational interface** to a user's own
financial history. That is the gap this layer fills.

We are building a GCP/Vertex AI intelligence layer in three planes: (1) an **ingestion spine**
that unnests group expenses into BigQuery and a user-namespaced Vertex **Vector Search** index;
(2) a **RAG service** that answers natural-language money questions grounded in the user's own
expenses with citations; and (3) **MCP servers** (`splitcircle-core`, `splitcircle-insights`)
that expose this to Claude and other AI assistants over the 2025-spec Streamable HTTP + OAuth
transport, plus **BigQuery ML models** for zero-effort auto-categorization and anomaly flags.

The build is sequenced by a dependency-aware priority matrix: ship the spine and the Quick Wins
(categorizer, personal-expense RAG, core MCP) first, then strategic bets (group intelligence,
forecasting, smart-split). Throughout we honor eight Critical Rules — no hardcoded secrets,
per-user RAG isolation, PII discipline, Gemini Flash for cost, idempotent pipelines, TypeScript,
tests, and inline docs.

---

## Current App Analysis (condensed — from Phase 1)

- **Stack:** RN 0.83 / Expo SDK 55 / React 19 (TS) · Firebase Auth · Firestore · RTDB (calls) ·
  Cloud Functions v2 (Node 22) · LiveKit · Expo/APNs push.
- **Core entities:** `UserProfile`, `Group` (embeds `members[]`, **`expenses[]`**,
  `settlements[]`), `Expense` (11 split methods via `splitMetadata`, free-form `category`,
  `ReceiptItem[]`), `Settlement`, `RecurringBill`, `ChatThread/Message`, `Call`. **No `Balance`
  entity** — balances are computed (`calculateBalancesFromExpenses`) and cached on members.
- **Functions:** push fan-out (`onGroupUpdated`/`onChatUpdated`/`onCallCreated`), recurring-bill
  scheduler, `generateLiveKitToken`, **`parseReceiptWithLLM` (Gemini 2.5 Flash)**.
- **AI today:** server receipt parsing only; on-device OCR; **rule-based** (not ML) receipt
  learning. Categories unclassified.
- **Critical correction driving the design:** the primary expense store is the **embedded
  array**, so ingestion triggers on `groups/{groupId}` writes and unnests — not on a flat
  `/expenses/{id}` collection.

## AI Opportunity Landscape (from Phase 2)

Auto-categorization and conversational RAG bring parity with Splitwise (which already ships an
MCP); SplitCircle leapfrogs on **grounded-with-citations money answers, gamified/split-method
intelligence, group narratives, forecasting, and anomaly detection**. Vertex map: Embeddings +
Vector Search (RAG), BigQuery ML (categorize/forecast/anomaly, no serving infra), Gemini Flash
(generation), Document AI (receipts). MCP (2025-06-18) = tools (model-controlled) / resources /
prompts over Streamable HTTP + OAuth 2.1; we bridge Firebase ID tokens into the auth layer.

---

## What We're Building

### RAG Pipelines (prioritized)
- 🟢 **RAG-01 Personal Expense Memory**, **RAG-02 Group Expense Intelligence**, **RAG-07
  Split-Method Memory** (the differentiator).
- 🔵 RAG-03 Receipt KB, RAG-04 Financial Pattern Library, RAG-06 Group Narrative.
- 🟡 RAG-05 Settlement History, RAG-08 Help RAG.
> All: one Vector Search index, `restricts` namespaced by `userId`/`groupId`; 1 expense = 1
> datapoint; `text-embedding-005` (768d) on both ingest and query.

### MCP Servers (prioritized)
- 🟢 **`splitcircle-core`** — `get_expenses`, `get_group_balances`, `add_expense` (write,
  confirm), `search_expenses` (RAG), `get_settlement_suggestions` (reuses `minimizeDebts`),
  `get_user_groups`, `get_recent_activity` + resources + prompts.
- 🟢 **`splitcircle-insights`** — `get_spending_summary`, `compare_spending_periods`,
  `find_unusual_expenses`, `ask_about_spending`, `get_group_contribution_analysis`,
  `get_top_categories`, `get_split_fairness_score`.
- 🔵 receipts / groups / forecasting · 🟡 notifications / admin.
> All tools: zod-validated, uid from **token not args**, membership-checked, output-sanitized,
> rate-limited; writes flagged for human-in-the-loop.

### Vertex AI Models (prioritized)
- 🟢 **MODEL-07 embeddings**, **MODEL-01 category classifier** (BQML `LOGISTIC_REG`, `ML.PREDICT`
  write-back only when user left category blank), **MODEL-03 anomaly** (statistical z-score v1 →
  `ARIMA_PLUS` v2).
- 🔵 MODEL-02 forecaster (`ARIMA_PLUS`), MODEL-04 settlement predictor, MODEL-05 smart split.
- 🟡 MODEL-06 trip budget.

---

## Technical Architecture (from Phase 4)

Ingestion (Cloud Functions): the single **`onGroupWritten`** trigger (wired in
`functions/src/aiLayer.ts`, gated by `AI_LAYER_ENABLED`) fans out to → unnest → BigQuery
streaming insert **and** embed → Vector Search upsert (+ write back `embeddingId`/`contentHash`
for idempotency) **and** BQML auto-categorize.
Serving (Cloud Run): RAG service (embed→search→hydrate-from-Firestore→Gemini-ground→cite) and
MCP servers. Models: BQML `ML.PREDICT` in-warehouse (no endpoints). Cache: Memorystore. Target
p95 < 1.8 s. Security: per-user `restricts` + Firestore membership re-check; PII excluded from
embeddings/logs; region-pinned; delete-propagation for right-to-erasure.

---

## Implementation Roadmap

**Sprint 1 (W1–2) Foundation:** `gcp_setup.sh` (APIs/IAM/dataset/bucket/secrets/index);
Firestore→BQ sync (unnest + backfill); **retrieval backend live — v1 uses Firestore vector
search (no always-on node) to avoid the dedicated Vector Search endpoint's floor cost; promote
to a dedicated Vertex Vector Search endpoint when query volume justifies it** (resolves Open
Question #1 — the embedding/query code is endpoint-agnostic behind `searchNeighbors`).
**Sprint 2 (W3–4) First RAG:** embedding pipeline (RAG-01/02); `queryExpenseRAG`; **MCP-01
`splitcircle-core`** on Cloud Run.
**Sprint 3 (W5–6) First ML:** MODEL-01 categorizer (BQML) + auto-categorize Function; MODEL-03
anomaly v1; eval + monitoring.
**Sprint 4 (W7–8) MCP expansion:** **MCP-02 `splitcircle-insights`**; `splitcircle-groups`;
Claude.ai integration testing.
**Sprint 5 (W9–10) Receipts:** Document AI pipeline; RAG-03; `splitcircle-receipts`.
**Sprint 6 (W11–12) Predictive:** MODEL-02 forecaster; RAG-07→MODEL-05 smart split;
`splitcircle-forecasting`.
**Sprint 7 (W13–14) Proactive + hardening:** `splitcircle-notifications`; caching; load test;
cost + RAGAS dashboards.

---

## Testing Strategy

- **Unit:** every MCP tool (input validation, membership enforcement, output shape) — Vitest,
  Firestore Admin mocked. Pure logic (balances, `minimizeDebts` reuse, debt math) tested directly.
- **Integration:** embedding idempotency (same expense → no duplicate vector), sync mapping,
  RAG end-to-end against Firestore emulator + a stub Vector Search.
- **RAG quality:** RAGAS-style metrics — **faithfulness, answer relevancy, context precision**
  on a curated golden set of expense Q&A; gate releases on faithfulness ≥ 0.85.
- **Model:** classifier accuracy ≥ 0.80 / macro-F1 tracked via `ML.EVALUATE`; promotion gated.
- **Sandbox caveat:** live Vertex/BQ/Cloud Run integration tests require a real GCP project;
  this repo ships the code + unit tests + a runnable harness. See `docs/07_testing_guide.md`.

---

## Cost Estimates (rough, order-of-magnitude)

| Item | Driver | Est. monthly @ ~10k expenses / 1k MAU |
|---|---|---|
| Embeddings (`text-embedding-005`) | ~10k + re-embeds | < $1 |
| Vector Search | 1 small index + endpoint (min node) | ~$60–250 (endpoint is the floor cost) |
| Gemini 2.5 Flash (RAG) | ~20k queries × ~2k tok | ~$5–15 |
| BigQuery | storage + query + BQML train/predict | ~$5–30 |
| Cloud Run (2 MCP) | scale-to-zero, low traffic | ~$5–20 |
| Memorystore (optional) | smallest Redis | ~$35 (or skip in v1) |
| **Total** | | **~$80–350/mo**, dominated by the Vector Search endpoint |

> Biggest lever: the Vector Search **endpoint** is an always-on floor cost. For early stage,
> consider Firestore vector search or a batch index to defer it (noted in Open Questions).

---

## Open Questions

1. ~~**Vector Search endpoint cost vs. Firestore vector extension** for v1~~ — **RESOLVED
   (self-review):** v1 ships on Firestore vector search to avoid the always-on endpoint floor
   cost; `searchNeighbors` is the seam, so promotion to a dedicated Vertex endpoint is a
   config/impl swap with no change to the RAG service or MCP tools.
2. ~~**`title` vs `description` drift**~~ — **RESOLVED:** keep `title` as the canonical field and
   tolerate `description` as a read fallback everywhere (sync mapper, embed text, classifier
   input, MCP normalize). A source-side rename is deferred to an app migration; the AI layer must
   not depend on it. No warehouse rework needed.
3. ~~**Activity feed (RAG-06)**~~ — **RESOLVED: reconstruct.** No stored log exists, but every
   change flows through a `groups/{gid}` write, so `pipelines/activity/activity_log.ts`
   (`buildActivityEvents`, pure + tested) derives add/settle/join/leave events from before→after
   diffs with deterministic ids. Wiring it into the orchestrator (persist + embed for "catch me
   up") needs `before` threaded through `fanOut` — a small follow-up.
4. ~~**Embedded-array scaling**~~ — **RESOLVED (operational):** the BQ mirror already removes the
   analytics pressure; the remaining risk is the 1 MiB group-doc limit. Decision: monitor doc
   size and migrate to a `/groups/{id}/expenses` subcollection at ~80% of the limit (which would
   also simplify triggers). Tracked as an app-side migration, not an AI-layer blocker.
5. ~~**Multi-currency in analytics**~~ — **RESOLVED: store both.** `pipelines/firestore_to_bq/fx.ts`
   adds `amount_normalized` / `normalized_currency` / `fx_rate` (config-driven rates; unknown
   currency → NULL, never a wrong number). Native amount is preserved for display/audit.
6. ~~**PII redaction depth**~~ — **RESOLVED: minimize, don't DLP (v1).** `notes` free text is
   excluded from BQ (only `notes_present` boolean); embeddings already exclude email/phone. This
   removes the need for a DLP dependency in v1; revisit DLP only if `notes` is later required in
   the warehouse.
