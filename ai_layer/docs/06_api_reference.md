# 06 — API Reference

Reference for the RAG service, MCP tools, and the ML model interfaces. Types are TypeScript
(see source for full definitions). All user-scoped calls derive `userId` from the verified
Firebase token.

## RAG Service (`services/rag/rag_service.ts`)

### `queryExpenseRAG(query: RAGQuery, deps: RAGDeps): Promise<RAGResult>`

```ts
interface RAGQuery {
  query: string;
  userId: string;                 // authenticated scope (required; throws if empty)
  groupId?: string;
  filters?: {
    dateRange?: { start: Date; end: Date };
    categories?: string[];
    minAmount?: number;
    maxAmount?: number;
  };
  topK?: number;                  // default 10
}

interface RAGResult {
  answer: string;
  sources: ExpenseDocument[];     // hydrated, ranked, filtered
  confidence: number;             // 0..1 heuristic (coverage-based)
  generationMetadata: {
    model: string; retrieved: number; used: number; cached: boolean;
    promptTokens?: number; candidateTokens?: number;
  };
}
```
Pipeline: embed query → Vector Search (`restricts` = userId) → hydrate from Firestore → filter
→ Gemini 2.5 Flash grounded generation → structured result. `RAGDeps` is injectable for tests.

## MCP: splitcircle-core tools

| Tool | Input | Output (`structuredContent`) |
|---|---|---|
| `get_expenses` | `{ groupId?, limit=50, category?, dateRange?{start,end ISO} }` | `{ expenses[], count }` |
| `get_group_balances` | `{ groupId }` | `{ groupId, currency, balances:[{userId,displayName,net,owes,isOwed}] }` |
| `get_settlement_suggestions` | `{ groupId }` | `{ groupId, settlements:[{from,fromName,to,toName,amount,currency}] }` |
| `get_user_groups` | `{}` | `{ groups:[{groupId,name,currency,memberCount,expenseCount,myNetBalance,status}] }` |
| `get_recent_activity` | `{ groupId?, limit=20 }` | `{ activity:[{type,id,groupId,summary,amount,currency,at}] }` |
| `search_expenses` | `{ query, groupId?, limit=10 }` | `{ results[], answer }` |
| `add_expense` *(write)* | `{ groupId, title, amount, paidBy, participants[{userId,share}], splitType, category, date?, notes?, requestId? }` | `{ expenseId, expense }` |

Errors: validation/permission/rate-limit failures return MCP tool results with `isError: true`
and a safe message (no PII).

## MCP: splitcircle-insights tools

| Tool | Input | Output |
|---|---|---|
| `get_spending_summary` | `{ period: week\|month\|quarter\|year, groupId? }` | `{ period, total, byCategory, topExpenses[], count, trend }` |
| `compare_spending_periods` | `{ period, groupId? }` | `{ total1, total2, delta, deltaPercent, trend, categoryBreakdown, insight }` |
| `find_unusual_expenses` | `{ lookbackDays=30, groupId? }` | `{ anomalies:[{expense, reason, anomalyScore}] }` |
| `ask_about_spending` | `{ question, groupId? }` | `{ answer, sources[] }` |
| `get_group_contribution_analysis` | `{ groupId }` | `{ groupId, members:[{userId,totalPaid,totalOwed,fairShare,delta}] }` |

## Embedding pipeline (`pipelines/embedding/embedding_client.ts`)

- `buildEmbeddingText(input): string` — pure; the per-expense text (excludes email/phone).
- `embedText(text): Promise<number[]>` — 768-dim, task `RETRIEVAL_DOCUMENT`.
- `embedQuery(text): Promise<number[]>` — 768-dim, task `RETRIEVAL_QUERY`.
- `upsertDatapoint(dp): Promise<void>` — streaming upsert with `restricts` (user/group).

## ML: category classifier (BigQuery ML)

- Train/eval/predict: `models/category_classifier/*.sql`.
- Inference contract: input `{ title, amount, hour_of_day, day_of_week, participant_count }`
  → output `{ category, confidence }`.
- Serving Function: `autoCategorizeExpenses` (writes back only when category is blank).

## Sync pipeline (`pipelines/firestore_to_bq/sync_function.ts`)

- `mapExpenseRow(groupId, currency, expense, syncedAt)` / `mapSettlementRow(...)` — pure mappers
  (also used by `backfill.ts`).
- BigQuery tables per `schema.json`: `expenses`, `settlements`, `groups`, `users`.
