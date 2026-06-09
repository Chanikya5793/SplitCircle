# Phase 2 — Use Case Research & Opportunity Mapping

> Domain research (fintech / expense-sharing AI), Vertex AI capability mapping, the MCP
> spec as it stands in 2025–2026, and a mapping of every SplitCircle user journey to
> concrete AI interventions. Grounded in the Phase 1 entity map.

---

## 1. Research Findings (sources cited)

**Finding 1 — Splitwise already ships an MCP server, and AI is the competitive frontier.**
Splitwise's roadmap explicitly centers AI/ML for receipt scanning, **automatic expense
categorization, and fraud detection**, with categorization-accuracy gains projected ~30%.
There are now *multiple* Splitwise MCP integrations (community + Composio). Takeaway: an MCP
surface over expense data is no longer novel — **the differentiator is depth** (SplitCircle's
11 split methods, group dynamics) and **quality of insights**, not the existence of an MCP.
→ [Splitwise growth strategy](https://canvasbusinessmodel.com/blogs/growth-strategy/splitwise-growth-strategy),
[Splitwise MCP (Composio)](https://composio.dev/toolkits/splitwise),
[Introducing Splitwise MCP](https://www.linkedin.com/posts/divyanshu-bansal-6b2117173_mcp-artificialintelligence-productivity-activity-7355011139363131392-wOQH).

**Finding 2 — Auto-categorization is the table-stakes AI win.** Every 2025 expense-AI
roundup leads with categorization + receipt extraction as the highest-ROI, lowest-risk
features. SplitCircle's categories are free-form today → a classifier is a clean Quick Win.
→ [Top 7 AI Tools for Expense Categorization 2025](https://www.lucid.now/blog/top-7-ai-tools-for-expense-categorization-2025/),
[Ramp — AI Expense Management](https://ramp.com/blog/ai-expense-management).

**Finding 3 — The canonical GCP RAG architecture is two subsystems.** *Ingestion*:
source → Cloud Storage/Firestore → Pub/Sub → Cloud Run function → Vertex Embeddings API →
Vector Search (streaming upsert). *Serving*: query → embed → vector search → augmented prompt
→ Gemini, with Cloud Run min-instances and `approximateNeighborsCount` as the main latency
levers. **You must use the same embedding model on both sides.**
→ [RAG infra on Vertex AI + Vector Search](https://docs.cloud.google.com/architecture/gen-ai-rag-vertex-ai-vector-search),
[Vertex AI RAG Engine](https://cloud.google.com/blog/products/ai-machine-learning/introducing-vertex-ai-rag-engine).

**Finding 4 — Chunk sizing for short records.** General RAG guidance is 300–500 tokens/chunk
with 50–100 overlap. Expenses are *tiny* (a sentence). → **One expense = one chunk** (no
splitting); the real work is composing a rich, filterable embedding text + metadata.
→ [GCP RAG spectrum](https://medium.com/google-cloud/the-gcp-rag-spectrum-vertex-ai-search-rag-engine-and-vector-search-which-one-should-you-use-f56d50720d5a).

**Finding 5 — MCP auth standard moved to OAuth 2.1 over Streamable HTTP (2025-06-18 spec).**
Remote MCP servers are OAuth **Resource Servers** advertising their auth server via
`.well-known`. The older "HTTP+SSE" transport named in the master prompt is **superseded by
Streamable HTTP**. SplitCircle already issues Firebase ID tokens — we bridge those to the MCP
auth layer. → [MCP Authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization),
[Auth0 — MCP spec updates](https://auth0.com/blog/mcp-specs-update-all-about-auth/),
[MCP 1-year recap](https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/).

---

## 2. Vertex AI Capability Map (for SplitCircle specifically)

| GCP / Vertex service | What it does | SplitCircle application |
|---|---|---|
| **Vertex AI Embeddings** (`text-embedding-005` / `gemini-embedding-001`, 768-dim) | Text → vector | Embed each expense (`title+category+notes+participants`) and monthly summaries |
| **Vertex AI Vector Search** | Managed ANN over millions of vectors, metadata filtering, streaming upsert, autoscaling endpoint | Per-user / per-group namespaced expense memory; `restricts` filter = userId (security boundary) |
| **Gemini 2.5 Flash** (Vertex / GenAI) | Cheap, fast grounded generation | RAG answer generation; NL insight summaries. **Already used in the app** for receipts |
| **BigQuery + BigQuery ML** | Warehouse + in-SQL models (`LOGISTIC_REG`, `ARIMA_PLUS`, `KMEANS`, anomaly) | Spending analytics, category classifier, monthly forecaster, anomaly detection — no separate serving infra |
| **Document AI** (Expense/OCR processors) | Structured receipt extraction | Upgrade path from current OCR+Gemini receipt flow (line items, tax, tip, merchant) |
| **Vertex AI Grounding** | Grounded, citable generation | Force RAG answers to cite retrieved expenses (anti-hallucination on money facts) |
| **Cloud Run + Functions** | Serverless hosting | Host MCP servers (Cloud Run) + embedding/sync triggers (Functions) |
| **Vertex Model Monitoring** | Drift/skew detection | Watch category-classifier drift as spend patterns shift |

**Embedding-model note:** the master prompt says `text-embedding-004`. As of 2026 the current
GA recommendation is `text-embedding-005` (English) / `gemini-embedding-001`. The code uses a
single `EMBEDDING_MODEL` constant so this is a one-line change; 768 dims retained for index
compatibility.

---

## 3. MCP Specification Summary (with SplitCircle context)

| Primitive | Control model | Definition shape | SplitCircle usage |
|---|---|---|---|
| **Tools** | Model-controlled (LLM invokes) | `{ name, title?, description, inputSchema (JSON Schema), outputSchema?, annotations? }`; results `content[]` + optional `structuredContent`; errors via `isError` or JSON-RPC | `get_expenses`, `add_expense`, `get_group_balances`, `get_settlement_suggestions`, `search_expenses`, … (write tools must be human-confirmed) |
| **Resources** | App/user-controlled (attached as context) | URI-addressable read-only data | `splitcircle://user/{uid}/expenses`, `splitcircle://group/{gid}/summary` |
| **Prompts** | User-controlled (slash-command style) | Named, parameterized templates | `analyze_my_spending`, `settle_up`, `review_expense` |

**Transport & hosting (corrected for 2025-06-18 spec):** Streamable HTTP for remote
(Claude.ai / hosted), stdio for local (Claude Desktop). Remote = OAuth 2.1 Resource Server.
**Security (per spec):** servers MUST validate inputs, enforce access control, rate-limit,
sanitize outputs; clients SHOULD require human confirmation for sensitive (write) ops. For
SplitCircle this maps directly to: **validate every tool input with zod, scope every query by
authenticated uid + group membership, never trust a `userId` argument over the token.**

---

## 4. User Journey → AI Opportunity Map

| # | Journey | AI interventions (2–3 each) | Backed by |
|---|---|---|---|
| 1 | Add a new expense | (a) **Auto-categorize** from title/amount (MODEL-01); (b) **smart split suggestion** from history (MODEL-05); (c) duplicate/anomaly flag at entry (MODEL-03) | classifier, RAG, anomaly |
| 2 | Understand my month | (a) NL **spending summary** (`get_spending_summary`); (b) period-over-period **delta + insight** (Gemini); (c) "normal for you?" baseline (RAG-04) | insights MCP, BQ |
| 3 | Settle up — who pays whom | (a) reuse `minimizeDebts` via `get_settlement_suggestions`; (b) **NL explanation** of the plan; (c) settlement-likelihood nudge (MODEL-04) | core MCP, BQ |
| 4 | Upload a receipt | (a) Document AI line-item extract; (b) **suggest itemized split** (maps to `ExpenseReceiptItem`); (c) merchant→category autofill | receipts pipeline |
| 5 | Join a group, get context | (a) **"Catch me up"** group narrative (RAG-06); (b) current balances summary; (c) my expected share trends | core+insights MCP |
| 6 | "How much on food this trip?" | (a) **filtered RAG** over group expenses (RAG-02); (b) grounded total with citations; (c) category drill-down | RAG, insights |
| 7 | Admin: group spend trends | (a) **timeline + contribution analysis** (`get_group_contribution_analysis`); (b) **trip report** generation; (c) fairness score | insights/groups MCP |
| 8 | Is this expense unusual? | (a) BQML/statistical **anomaly score + reason** (MODEL-03); (b) duplicate detection; (c) "above your usual for X" | anomaly model |
| 9 | Split a complex bill line-by-line | (a) line-item assignment assist; (b) tax/tip proration (reuse `computeItemized`); (c) NL "Sam had the steak, I had salad" → assignment | receipts MCP |
| 10 | Export / annual report | (a) **NL annual narrative**; (b) category/cohort breakdown via BQ; (c) forecast next year (MODEL-02) | insights MCP, BQ |

---

## 5. Competitive Landscape

| Capability | Splitwise | Tricount | **SplitCircle (today)** | SplitCircle leapfrog opportunity |
|---|---|---|---|---|
| Receipt OCR | ✅ (Pro) | partial | ✅ Gemini + on-device | Document AI line-item + **auto itemized split** |
| Auto-categorization | rolling out | ❌ | ❌ (free-form) | **BQML classifier, zero-effort** |
| Debt simplification | ✅ | ✅ | ✅ `minimizeDebts` | **NL-explained** settlement plans |
| Split method depth | ~4 | ~3 | **11 methods incl. gamified** | already ahead — surface via AI ("split like last time") |
| Conversational queries | basic MCP | ❌ | ❌ | **Grounded RAG over your own expenses** |
| Forecasting / budgets | ❌ | ❌ | ❌ | **ARIMA_PLUS monthly forecast + trip budgeter** |
| Anomaly / fraud flags | exploring | ❌ | ❌ | **Anomaly + duplicate detection at entry** |
| Group narrative / reports | ❌ | ❌ | ❌ | **"Catch me up" + auto trip reports** |

**Strategic read:** auto-categorization and conversational RAG bring SplitCircle to parity
fast; **gamified-split intelligence, group narratives, forecasting, and grounded-with-citations
money answers** are where it can clearly leapfrog. MCP is now table stakes — ship it, but win
on insight quality.

---

*Phase 2 complete (5+ sources, Vertex map, MCP summary, journey map, competitive analysis).
Proceeding to Phase 3 brainstorm.*
