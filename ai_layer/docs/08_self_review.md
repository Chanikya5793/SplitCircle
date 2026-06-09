# Phase 5b — Critical Self-Review (Phases 1–5 + Phase 6 reconciliation)

> Adversarial review of the AI-layer plan and the shipped Phase 6 code, performed by
> re-reading the source (not the plan's own claims). Findings are graded by severity and
> each carries a concrete resolution. Where a fix was cheap and test-safe it is **applied in
> this same change**; conceptual corrections are folded back into `docs/01`–`04` and the
> master plan; the rest are logged as scoped follow-ups.

**Verification baseline:** all suites green — RAG **11** · core MCP **16** · insights MCP **12**
= **39 tests** (`vitest run` in each package). Model ids confirmed current as of the 2026
cutoff: `text-embedding-005`, `gemini-2.5-flash`. `node_modules` confirmed **not** tracked
(`.gitignore` honored); only source, docs, and lockfiles are committed.

---

## Findings

| # | Severity | Area | Finding | Resolution |
|---|---|---|---|---|
| **F1** | **High** | RAG hydration | Datapoint id was the **bare `expenseId`**, but expenses live EMBEDDED in `groups/{gid}.expenses[]` — so `hydrate(expenseId)` cannot locate an expense without the `groupId`. The plan's central Phase-1 finding was contradicted in the query path. A latent **ordering bug** also existed: the ranking map keyed on the raw datapoint id but sorted on bare `expenseId`. | **Fixed in code.** Datapoint id is now composite `${groupId}:${expenseId}` (`embed_expenses.ts`); `rag_service.ts` adds `parseDatapointId`, hydrate now takes `ExpenseRef[]` `{groupId, expenseId}`, and ranking keys on bare `expenseId`. Docs §2 + data-flow updated; new test asserts the parse. |
| **F2** | Medium | Ingestion triggers | Sync, embedding, and auto-categorize each register an independent `onDocumentWritten('groups/{groupId}')` → 3× invocations per write, and auto-categorize **writes back** to the group doc, re-firing all three. | **Documented (arch §2 "trigger fan-out").** Not infinite — every branch is idempotent so the write-back re-fire is a no-op; the loop self-terminates after one extra fire. Recommended consolidation into one `onGroupWritten` orchestrator = the single light hook to export from `functions/src/index.ts` (deferred to integration, per the gate). |
| **F3** | Low | Classifier features | Risk of train/serve **feature skew** on `hour_of_day` / `day_of_week`. | **Checked — no skew.** Training uses BQ `EXTRACT(HOUR/DAYOFWEEK FROM created_at)` (UTC; DAYOFWEEK Sun=1..Sat=7); `predict_service.ts` uses `getUTCHours()` and `getUTCDay()+1` → identical encoding. No action. |
| **F4** | Medium | Cost vs roadmap | Cost table flags the **always-on Vector Search endpoint** as the dominant monthly cost, yet Sprint 1 made "Vector Search index live" a hard dependency — internally inconsistent. | **Reconciled.** Master-plan Sprint 1 now ships v1 on **Firestore vector search** (no always-on node); `searchNeighbors` is the seam, so promoting to a dedicated Vertex endpoint later is a config swap. Open Question #1 marked RESOLVED. |
| **F5** | Low | Embedding model | `text-embedding-005` is English-optimized; SplitCircle is multi-currency/international. | **Documented.** Arch §2 now recommends `gemini-embedding-001` (multilingual, 768-dim) if non-English usage is material — a one-line `EMBEDDING_MODEL` swap; code default left at `005`. |
| **F6** | Cosmetic | Tooling | `vitest` emits an esbuild warning resolving the repo-root `tsconfig.json` (`extends: expo/tsconfig.base`, not installed in the sub-packages). | Non-fatal; tests pass. The `ai_layer/*` tsconfigs are already self-contained. Left as-is; can be silenced with a `tsconfigRaw` in each `vitest.config.ts` if the warning becomes noisy. |
| **F7** | Low | Field drift | The `title` vs `description` drift (Finding 2) must not re-enter the AI write path. | **Verified handled.** `embed_expenses.ts` and `predict_service.ts` both read `title ?? description`; `add_expense` writes `title`. No action. |

---

## What changed in this review

**Code (test-safe, suites green):**
- `pipelines/embedding/embed_expenses.ts` — composite datapoint id `${groupId}:${expenseId}`; `embeddingId` reverse-lookup record updated to match.
- `services/rag/rag_service.ts` — `parseDatapointId`, `ExpenseRef`, ref-based `hydrate` contract, ranking keyed on bare `expenseId` (fixes the latent ordering bug).
- `services/rag/__tests__/rag_service.test.ts` — fakes use composite ids; new test covers the parse (+1 test → 11).

**Docs:**
- `docs/04_architecture_design.md` — hydration corrected for embedded arrays; ingestion trigger fan-out note; embedding-model i18n note.
- `SPLITCIRCLE_AI_MASTER_PLAN.md` — Sprint 1 retrieval backend (Firestore vector search v1); Open Question #1 resolved.

## Follow-up shipped after the review

**RAG wired end-to-end (production adapter).** The RAG service was previously DI-only with no
concrete deps. Added:
- `services/rag/vertex_client.ts` — query-side `embedQuery`, Vector Search `findNeighbors`
  (with user/group `restricts`), and Gemini `generate`, over REST + ADC. Pure response mappers
  split out and unit-tested.
- `services/rag/rag_deps.ts` — `buildRAGDeps()` assembling the real pipeline, including the
  concrete embedded-array `hydrate` (`expenseDocFromGroup`: reads `groups/{gid}`, pulls the
  expense from `expenses[]`, resolves payer/participant names from `members[]` + tolerates the
  title/description drift). This is the F1 fix made real.
- `services/rag/server.ts` — minimal Cloud Run HTTP entry (`POST /query`, shared-secret auth);
  pure auth/parse helpers unit-tested.
- `mcp/splitcircle-core` — `lib/ragClient.ts` (`makeRagSearch`) calls the RAG service over HTTP
  when `RAG_SERVICE_URL` is set, mapping `{answer, sources[]}` → `SearchHit`; otherwise the
  existing substring fallback. Wired into `index.ts`.
- Tests added: RAG 11→24, core 16→20 (total now **56**). Both packages typecheck clean.

Still needs live GCP to *run* (Vector Search endpoint + Gemini), but the code path is complete
and the seams are exercised by unit tests.

## Deferred (require confirmation / live GCP)

- ~~**Light app hook:** export the consolidated `onGroupWritten` (sync+embed+categorize) from `functions/src/index.ts`.~~ **DONE** — `functions/src/aiLayer.ts` exports a gated `onGroupWritten` that fans out to the three pure cores (`runBqSyncForGroup` / `runEmbedForGroup` / `runAutoCategorizeForGroup`, barrelled in `ai_layer/index.ts`). No-op until `AI_LAYER_ENABLED=true`; the Functions package builds green with **zero new dependencies** (cores are dynamically imported only when enabled). Activation = provision backend + set `AI_LAYER_DIST`/deps + flip the flag.
- **Open Questions #2–#6** (title/description rename at source, activity-feed for RAG-06, multi-currency normalization in BQ, PII/DLP depth) remain product decisions — see master plan.
- **Live integration tests** (Vertex/BQ/Cloud Run) still need a real GCP project; this repo ships code + unit tests + the harness in `docs/07_testing_guide.md`.

*Self-review complete. The plan is now internally consistent with the embedded-array reality end-to-end, and the shipped code matches the corrected plan.*
