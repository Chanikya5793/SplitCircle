# 22 — Stats & Insights: engine, AI tiers, chat digests, budgets

Built 2026-07-17/18 from the stats brainstorm (all decisions user-locked). Companion to
[doc 21](21_money_in_chat.md) (money-in-chat cards — digests/alerts ride that pipeline).

## Decisions (locked)

| Question | Decision |
|---|---|
| Stats upgrades | ALL: time ranges + trends · member/fairness · merchants+savings · forecast |
| AI surfaces | Stats insight cards + chat digest/alert cards + (later) AI chat hook |
| Engine staging | on-device → PCC → deterministic heuristics (always render) |
| Rec types | ALL: insights/anomalies · budgets · settle-timing · forecast + wrapped |
| Admin panel | Insights section in Money-in-Chat sheet: digest cadence (off/weekly/monthly), anomaly posts (default OFF), budget alerts (default ON), fairness admins-only |
| Scope | Group stats AND personal cross-group dashboard, both shipped |
| PCC policy | ON by default, disclosed, kill-switch in the personal dashboard (`pcc_deep_analysis_v1`) |
| Budgets | BOTH: group (admin-set, `Group.budgets`, Firestore-synced) + personal (private, AsyncStorage `personal_budgets_v1`, keyed `currency:category`) |

## Architecture

- **`src/utils/statsInsights.ts`** — pure, vitest-covered engine: `rangeWindow`,
  `aggregateRange`, `categoryTrends`, `memberBreakdown` (+fairness), `merchantAggregate`
  (title-normalized merchants + receipt-OCR savings), `buildForecast` (burn-rate +
  `monthlyCommitment` from recurring bills), `detectAnomalies` (recent vs 90d category
  baseline, ≥2×, ≥3 baseline rows), `settleVelocity`, `budgetStatus`,
  `buildHeuristicCards` (the no-AI tier), `buildStatsFacts` (compact facts JSON for the
  models — models NARRATE, never compute), `buildPersonalStats` (cross-group, amounts
  stay per-currency — never cross-currency summed).
- **`src/services/insightsAiService.ts`** — narrative tier. `narrateInsights(facts,
  {deep})`: deep prefers PCC, lite prefers on-device, both fall through, null ⇒ heuristic
  cards only. Session-cached per facts-hash.
- **Surfaces**: `GroupStatsScreen` (rebuilt: range chips, AI narrative card labeled
  on-device/PCC, heuristic insight cards, budget burn bars, member/fairness, merchants,
  trajectory) and `PersonalStatsScreen` (Settings ▸ Your spending: per-group shares,
  per-currency categories, personal budgets, PCC toggle + availability).
- **Chat cards**: digest (`kind:'digest'`) + alerts (`kind:'insight'`) ride the doc-21
  ExpenseRef pipeline. Digest triggers CLIENT-side in ChatRoomScreen when the previous
  period's card is absent; budget/anomaly alerts fire from `addExpense`. All idempotent
  via **deterministic message ids** (`digest-<group>-<period>`,
  `budget-<group>-<month>-<cat>-<pct>`, `anomaly-<group>-<expenseId>`) — concurrent
  posts from several members converge to one message.

## PCC — hard-won gotchas

- **NEVER construct `PrivateCloudComputeLanguageModel` on the simulator** — it
  SIGSEGVs natively (expo module-holder `NotificationCenterManager.addDelegate` race,
  3 crash reports) instead of reporting unavailable. Gate: `Device.isDevice &&
  getOnDeviceAiAvailability() === 'available'` (PCC eligibility ⊆ Apple Intelligence
  eligibility). Note the iOS 27 sim DOES report on-device availability='available', so
  the availability check alone is NOT a sim guard.
- **Serialize PCC probes** (`serialPccProbe`): two concurrent model constructions crash
  the expo event plumbing. One in-flight probe at a time, app-wide.
- **2026-07-18 update: the same race bites ON-DEVICE model calls on real hardware.** Two
  concurrent `askOnDevice` constructions (Group Stats narrating twice while recurring
  bills loaded) corrupted the Hermes heap on the physical iPhone 17 Pro — SIGSEGV inside
  the VM on digest-card tap. ALL FM calls now ride one global queue (`serializeFm` in
  `modules/splitcircle-ai/index.ts`) and `narrateInsights` dedupes identical in-flight
  requests. Never call the native module directly.
- PCC end-to-end (`available:true`, real narratives) is only provable on the user's
  entitled physical device via TestFlight — sim shows the graceful fallback path.

## Narrative-tier reliability (fixed 2026-07-18)

The stats narrator (and the doc-23 insights chat/titles/summaries) originally rode
`askOnDevice` — a Q&A-shaped door whose NATIVE session persona says "answer using
ONLY the numbered expense lines … otherwise say you don't have enough expense
data", wraps the prompt under an EMPTY `Expenses:` block, and forces the
`OnDeviceExpenseAnswer` citation struct. The real instructions rode inside
"Question:", fighting the persona → deflections, Q&A phrasing, random formatting:
the "sloppy/inconsistent/unreliable" stats AI. Fixes, all shipped together:

- **`generateText(prompt, instructions, deterministic)`** (native) — the free-text
  door: caller instructions in the REAL instructions slot, no scaffold, no guided
  struct, greedy sampling when `deterministic` (same facts ⇒ same words). JS wrapper
  `generateOnDeviceText` rides the global `serializeFm` queue and degrades to the
  `askOnDevice` shape on binaries older than the function (hot-swapped JS is safe,
  but the fix itself NEEDS a new binary). Narrative/free-text work must NEVER go
  through `askOnDevice` — that one is only for numbered-context Q&A.
- **Output hygiene** (`src/utils/aiText.ts`, vitest-covered): chat replies pass
  `stripModelDecorations` (fences/markdown/quotes/newlines); the stats card passes
  `sanitizeNarrative`, which REJECTS deflections, scaffold echoes ("FACTS", "as an
  AI"), JSON residue, fragments, and any number ≥10 not grounded in the facts blob
  (±0.5 or 5% — rounding allowed, invention not). A rejection returns null and the
  tier falls through; heuristic cards always render.
- **PCC narrations** pass INSTRUCTIONS via `pccAsk`'s instructions slot instead of
  inlining them under the generic "expense assistant" persona.
- **Narrative cache is persistent** (`insights_narrative_cache_v1`, FIFO 32,
  facts-hash keyed) so unchanged data shows the SAME narrative across relaunches —
  and NULL results are never cached: `modelNotReady` right after boot used to pin
  "no narrative" for the whole session.

## Server bits deployed

`firestore.rules` group-update whitelist now includes `budgets` (and `moneyInChat` from
doc 21). Deployed 2026-07-18.

## Verified on sim

Group stats (all sections, live insight cards from real data), personal dashboard
(cross-group + budgets + PCC row reporting "simulator"), June digest card auto-posting
into the linked chat on open, expense/settlement cards from the user's own organic use.

## Not built yet

Settle-timing nudge posts (needs the doc-21 cloud-function bot), digest share-out images,
weekly digest verification. The AI-chat hook shipped as the insights-chat thread framework
— see [doc 23](23_insights_chat_threads.md).
