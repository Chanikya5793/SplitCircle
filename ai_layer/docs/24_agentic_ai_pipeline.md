# 24 — Agentic AI Pipeline ("One Brain")

Decisions user-locked 2026-07-19 (in-conversation, 8 structured choices). This doc is the
binding contract for the rebuild of BOTH AI surfaces — don't re-litigate. Companions:
[doc 17](17_chatbot_pipeline_v2.md) (diagnosis it inherits; its Phase A never shipped past
the compile spike), [doc 22](22_stats_insights.md) (deterministic stats engine the tools
wrap), [doc 23](23_insights_chat_threads.md) (thread store — kept as-is).

## 1. Diagnosis (why the AI feels lazy — verified in code 2026-07-19)

1. **One-shot context packing.** The model only ever sees a fixed pre-packed facts blob;
   `questionContext` enrichment fires only on literal name matches (merchants
   exact-substring). No retrieval loop — if the pack lacks the answer, the model is
   *instructed* to deflect ("that's everything notable",
   [insightsChatService.ts:222](../../src/services/insightsChatService.ts)).
2. **Brevity hard-coded.** "1-3 short, friendly sentences. No lists" in the insights
   instructions — depth is forbidden by prompt.
3. **Assistant never got doc 17 Phase A.** Live path is still regex →
   stateless `planExpenseQuery` → one-shot `askOnDevice` Q&A persona
   ([assistantService.ts:396-403](../../src/services/assistantService.ts)). The spike
   router (`routeMessage`, `FMSessionStore`) has **zero callers in src/**.
4. **No clarify path.** Ambiguity → guess or deflect; nothing can ask the user back.
5. **PCC minimum-effort.** `.light` reasoning hard-coded, overflow-only escalation,
   32K window idle despite the granted entitlement.

## 2. Decisions (locked)

| Question | Decision |
|---|---|
| Data access | **JS agentic loop.** Model emits structured tool requests; the deterministic TS engine executes them exactly; results append; loop until final. Same mechanics on-device and PCC; every hop rides `serializeFm`; fully vitest-able with a scripted fake model. (Native FM Tools rejected: data lives in JS; SQLite index holds only aggregate blobs; new native concurrency surface next to the Hermes-SIGSEGV history.) |
| Scope | **One brain, both surfaces.** Router + loop + narrator built once; Ask AI and insights chat become surface configs (context provider + allowed tools + allowed writes). Kills the pipeline fork permanently. |
| Ask-backs | **Chips + assumption fallback.** Genuinely ambiguous → short question with ≤4 tappable option chips. Mildly ambiguous → answer anyway with the assumption stated + one-tap switch ("Assumed April 2026 — see 2025?"). |
| Streaming | **Full streaming.** Token-stream the narration into the bubble (FM `streamResponse` → native events) + deterministic status lines during the loop ("Pulling April…"). |
| Data reach | **Everything selected**: full money graph (expenses, settlements, balances, budgets, recurring, merchants, forecast/anomalies/savings; group + personal cross-group), chat messages, search-index entities, call-history metadata. |
| Privacy tier rule | **Local-tier data never leaves the device** (maps 1:1 onto the app's storage DNA): chat messages + call history are AsyncStorage/local-tier → their tools are ON-DEVICE-ONLY and pin the whole turn to the on-device engine. Firestore-tier money data (already server-side) may go to PCC. |
| PCC role | **Depth engine.** Auto-escalate on router-judged complexity (multi-hop / comparison / "why" asks), not just overflow. Reasoning `.moderate` for complex, `.deep` for explicit deep-analysis asks. Raw expense lines may ride to PCC (Apple-attested, stateless). Engine badge stays truthful; user pref pill still overrides; quota surfaced. |
| Writes | **Expand behind confirm cards** on both surfaces: add expense, settle-up draft, create/edit budget, send nudge/reminder (doc-21 bot infra). Model proposes typed payloads; JS validates against canonical members/categories; user taps the card; the model NEVER writes directly. Supersedes doc 23's read-only-v1 for insights chat. |
| Latency | **Up to ~10s when deep** (3–4 hops), streamed status so it never feels frozen. Simple asks stay instant via the deterministic fast path. |
| Verbosity | Replace the 1-3-sentence cap with **adaptive length**: direct questions short; "why/analyze/compare" may run multiple short paragraphs and simple dash-lines. `stripModelDecorations` relaxes accordingly (still strips markdown headers/JSON/preamble). |
| Iron rules kept | LLM never does arithmetic (numbers only from tool results / facts); model output never rendered verbatim (aiText validation); smart-features-must-be-real gating; no paid external AI APIs — Apple FM (on-device + PCC) only. |

## 3. Architecture

```
user turn
 └▶ aiPipelineService.runTurn(surfaceConfig, thread, text)
     ├ 0) deterministic guards (kept): smalltalk, meta-commands, wantsFreshInsight cards
     ├ 1) fast path (kept): answerExpenseLocally — regex → exact cited answer, instant
     ├ 2) ROUTER (on-device FM, always): @Generable TurnDecision
     │      intent(answer|clarify|abstain) · confidence · assumption · complexity
     │      clarify{question, options ≤4} · requests[ToolRequest]
     │      → abstain: canned help  → clarify: chip bubble, turn ends
     ├ 3) ENGINE PICK: local-tier tool needed → on-device (pinned)
     │      else pref pill override, else complexity: simple/moderate → on-device,
     │      deep → PCC(.moderate|.deep). Whole turn runs on ONE engine (fallback on error).
     ├ 4) DATA LOOP (≤4 hops on-device, ≤3 on PCC, ~10s wall cap):
     │      execute requests via aiTools registry (pure TS, exact numbers)
     │      → TOOL RESULTS block grows → @Generable LoopStep{requests|done}
     │      → status line per hop streamed to UI (derived from tool names, not model text)
     ├ 5) NARRATOR: streamed free-text call (generateTextStreamed / pccAskStreamed)
     │      grounded in facts + tool results + thread memory; aiText-validated;
     │      anti-repeat guard kept
     └ 6) PROPOSALS: typed write payloads → JS validation → confirm cards
```

Stateless-by-design everywhere (doc 23 rationale wins app-wide): every model call is
fully assembled JS-side — replayable after cold start, budget-controlled, fresh facts
injectable, identical over PCC. The native `FMSessionStore` spike is superseded (P6 kill).

## 4. Tool registry (`src/utils/aiTools.ts`, pure)

Each tool: `name`, `tier: 'graph' | 'local'`, flat-nullable args, `run(args, ToolCtx)` →
`{ label, json }` (rows capped, numbers pre-formatted — the model quotes, never computes).
`ToolCtx` carries group/personal data + injected providers (message/call/search) so the
utils module stays pure and vitest-able.

| Tool | Tier | Serves |
|---|---|---|
| `range_totals(from,to)` | graph | totals, count, per-member paid/share for any range |
| `month_summary(month)` | graph | one month: total, categories, top expenses, vs-prev |
| `compare_ranges(a,b)` | graph | side-by-side deltas (the "why did X change" workhorse) |
| `category_breakdown(range,member?)` | graph | category totals, share-of-spend |
| `category_trail(category,months)` | graph | monthly series for one category |
| `member_stats(member,range)` | graph | paid/share/balance/top categories for one member |
| `merchant_stats(merchant,range)` | graph | fuzzy merchant match → visits, total, trend |
| `top_expenses(range,n,category?)` | graph | biggest line items |
| `search_expenses(query,range?)` | graph | fuzzy title/notes search over raw expenses |
| `balances()` / `settle_plan()` | graph | current balances, minimal settle-up transfers |
| `budgets()` / `budget_status(category)` | graph | budget lines vs actuals (doc 22) |
| `recurring()` | graph | detected recurring patterns |
| `forecast()` / `anomalies()` | graph | doc-22 forecast + anomaly rows |
| `personal_overview(range)` / `group_compare()` | graph | personal scope: cross-group ledger |
| `entity_lookup(name)` | graph | search-index fuzzy resolve → canonical member/group/merchant |
| `chat_search(query,range?)` | **local** | money-context snippets from `localMessageStorage` |
| `call_stats(member?,range?)` | **local** | count/duration/last-call from `localCallStorage` |

Implementation reuses `expenseQuery`, `expenseAnalytics`, `statsInsights` (the
`questionContext` machinery generalizes into tools), `searchService`. Local-tier rule is a
one-line predicate: any `tier:'local'` request → engine pinned on-device; when the turn is
already on PCC, local tools are omitted from the offered tool list (the router knows).

## 5. Native additions (`SplitCircleAIModule.swift`)

- `routeTurn(instructions, prompt)` → `TurnDecision` @Generable (flat-nullable
  `ToolRequest` fields — guided generation doesn't do open dicts). Router always
  on-device; availability gating for the whole feature stays on-device availability
  (PCC needs Apple-Intelligence hardware anyway — no new device floor).
- `LoopStep` @Generable for hops 2+.
- `generateTextStreamed(requestId, prompt, instructions)` + `pccAskStreamed(...)` →
  `onFmChunk {requestId, delta, done, quota?}` events (FM snapshots are cumulative —
  diff to deltas in Swift). `cancelFmStream(requestId)` via Task cancellation.
- **Concurrency:** streams still ride `serializeFm` — the queue promise resolves only on
  the `done` event; one in-flight model call app-wide remains the law (Hermes SIGSEGV).
- PCC calls gain `ContextOptions(reasoningLevel:)` parameter (`.light/.moderate/.deep`)
  instead of the hard-coded `.light`.

## 6. Clarify / assumption UX

- New thread message `role:'clarify'` with `options: string[]` → GlassView chip row;
  tapping sends the resolved text as a user turn carrying a `resolvedFrom` marker (the
  router is told — never re-clarify a resolved turn). Free-text reply also works.
- `assumption` on an answer renders as a subtle caption line under the bubble with a
  one-tap switch chip when the alternative is enumerable (year, member, range).
- Rules in the router instructions: clarify ONLY when the answer would materially differ
  (two members match; month without year where both exist; ambiguous scope) — cap one
  clarify per turn, never chain-interrogate.

## 7. Evals (mandatory, gate merges)

- vitest: ~60 router fixtures (all six doc-17 screenshot failures + ambiguity/clarify
  cases + local-tier pinning cases), tool unit tests, full-loop orchestration tests with
  a scripted fake model (deterministic — no device needed).
- Dev-only on-device eval screen: run the fixture list against the real model, pass/fail
  table (Apple Evaluations framework adoption later).

## 8. Phasing (each independently shippable)

- **P1 — Core loop, both surfaces (flagged).** `aiTools` graph tier + `aiLoop` assembly +
  `aiPipelineService` + `routeTurn`/`LoopStep` native + clarify/assumption UI + adaptive
  verbosity. No streaming yet (complete answers). Fake-model tests green.
- **P2 — Streaming.** Native streamed fns + chunk events + status lines + cancel.
- **P3 — PCC depth engine.** Complexity routing, `.moderate/.deep`, quota in the pill
  menu, truthful badges.
- **P4 — Writes.** Proposal validation + confirm cards in insights chat (assistant's
  cards generalized), settle/budget/nudge actions.
- **P5 — Sensitive tools.** `chat_search`, `call_stats`, `entity_lookup`, local-tier
  engine pinning.
- **P6 — Kill legacy + harden.** Retire `planExpenseQuery`/`answerExpenseSmart`/
  `askOnDevice` Q&A door/spike `routeMessage`+`askOnDeviceStateful`+`FMSessionStore`
  once eval parity is proven; Apple Evaluations framework; delete the flag.

## 9. Gotchas carried forward

- ALL model calls through `serializeFm`; PCC never constructed on simulator
  (`Device.isDevice` — doc 22 SIGSEGV); narrative text through `aiText` validation;
  `compiler(>=6.4)` + `#available(iOS 27)` guards on PCC symbols (EAS image!).
- Thread store (doc 23) unchanged: fresh-by-default, ~20-thread cap, rolling summary,
  facts-drift chips. The loop's TOOL RESULTS are per-turn and NOT persisted into the
  prompt history verbatim — the rolling summary absorbs conclusions.
- Confirm-card writes keep the no-`runTransaction` add/settle path rules.

## 10. Status

- **P1 BUILT 2026-07-19** (this session): `src/utils/aiTools.ts` (16 graph tools + period/
  member/merchant resolvers, ambiguity-as-data), `src/utils/aiLoop.ts` (coercers,
  instructions, budget-aware assembly), native `routeTurn`/`agentLoopStep`
  (@Generable structs, stateless, greedy) + JS wrappers + `isAgenticNativeAvailable`
  capability gate, `src/services/aiPipelineService.ts` (runAgenticTurn: router → loop
  ≤3 steps/10s → grounded narration with retry gate; `ai_pipeline_v1` flag default ON),
  both surfaces wired (insights `sendInsightsMessage` step 1b; assistant
  `processAssistantTurn` agentic bag), clarify chips + assumption captions in
  InsightChatOverlay + AiChatScreen, `stripChatDecorations` (paragraphs + dash lines
  survive), personal scope gets cross-group tools via `personalGroups`.
  Clarify resolution is inferred (last thread message role `clarify`) — no caller
  plumbing. Tests: 43 unit (tools+loop, incl. doc-17 #3 "Aprils total?" regression) +
  12 fake-model orchestration (services config gained the `@` alias); `tsc` clean.
- **Needs a real build** (`npm run ship:ios`) before the router runs on device — the
  native fns are invisible to the jsbundle hot-swap (CLAUDE.md gotcha); until then the
  capability gate keeps both surfaces on the legacy path automatically.
- **P1 SHIPPED 2026-07-19**: `SplitCircle-production-20260719-021608.ipa` delivered to
  App Store Connect (TestFlight) — the agentic router is live in that binary.
- **P2 BUILT 2026-07-19** (streaming): native `generateTextStreamed(requestId, prompt,
  instructions)` — `streamResponse` cumulative snapshots diffed to deltas, emitted as
  `onFmChunk {requestId, delta, done}` events (verified against the iOS 27
  swiftinterface: `ResponseStream<String>` yields `Snapshot.content: String`; iOS 26
  baseline) — + `cancelFmStream` (lock-guarded cancel registry). JS wrapper
  `generateOnDeviceTextStreamed` (requestId event filtering, serializeFm holds until
  the done event, non-streamed fallback on pre-P2 binaries). Orchestrator streams the
  FIRST narration draft only (a gate-failed retry is never re-streamed); both surfaces
  render a live pending bubble: status line ("Pulling April 2026…") → streaming text →
  replaced by the authoritative reply. PCC narration stays complete-answer until P3.
  Tests: +3 streamed-path orchestration tests (90 services total); `tsc` clean.
  NEEDS the next `npm run ship:ios` before streaming runs on device — until then the
  wrapper's fallback keeps P2 JS fully functional on the P1 binary.
- **P2 SHIPPED 2026-07-19**: `SplitCircle-production-20260719-093159.ipa` → TestFlight
  (streaming binary; also proves the P2 Swift compiles).
- **P3 BUILT 2026-07-19** (PCC depth engine): native `pccAskDeep(question,
  instructions, reasoningLevel)` — verified `ContextOptions.ReasoningLevel`
  `.light/.moderate/.deep` and structured `QuotaUsage` (`isLimitReached`,
  `resetDate`) against the iOS 27 swiftinterface; old `pccAsk` untouched (binary
  compat, wrapper prefers the deep door). Routing: router-judged `deep` turns go
  **PCC-first at `.moderate`** (`.deep` on explicit analyze/deep-dive asks) with a
  "Thinking deeper in Private Cloud…" status line; overflow escalation and the
  user pref pin unchanged; on-device fallback keeps badges honest.
  `tryPccPrompt` gained the reasoning param + records structured quota;
  the engine menu's Private Cloud row shows "Daily quota reached · resets <date>"
  when applicable. PCC narration stays complete-answer (no PCC streaming yet —
  revisit if network latency annoys). Tests: +5 depth-routing (95 services);
  `tsc` clean. P3 native rides the NEXT ship; until then the wrapper falls back
  to `.light` `pccAsk` on the P2 binary.

- **P3 SHIPPED 2026-07-19**: `SplitCircle-production-20260719-100614.ipa` → TestFlight
  (depth-engine binary).
- **P4 BUILT 2026-07-19** (writes expansion — supersedes doc 23 read-only-v1):
  - New `set_budget` action end to end: pure `parseBudgetCommand` +
    `classifyMessage` intent (ordered BEFORE edit/add so "set the Food budget
    to 300" can't misclassify; question-shaped budget talk stays a question),
    `handleSetBudget` confirm card (create/update/remove, shows the old value),
    applied via the existing `updateGroupBudgets` in BOTH surfaces.
  - **Insights chat writes**: action-shaped messages (and in-progress flows)
    delegate to `processAssistantTurn` — same slot-filling, same
    `ProposedAction`, model never writes. Assistant `ConversationState` rides
    `thread.meta.assistantState`; replies carry `payload {action, state}`;
    the overlay renders confirm cards (Not now/Confirm → GroupContext
    mutators, mirroring AiChatScreen) + quick-reply chips for slot-filling
    asks. `resolveInsightsAction` flips card state + appends the confirmation.
  - **Stale-card sweep** on thread resume (doc 17 A.7): pending cards older
    than 10 min retire; fresh mid-flow drafts survive.
  - **`send_nudge` DEFERRED**: the doc-21 bot-message infra doesn't exist yet —
    build it there first, then add the action type here.
  - All JS-only — works on the shipped P3 binary via jsbundle hot-swap.
    Tests: +9 pure (budget commands) +5 services (delegation, resolution,
    stale sweep; `expo-sqlite` mock added to the services harness); `tsc` clean.

- **P5 BUILT 2026-07-19** (sensitive tools + the privacy pin):
  - `chat_search` (local tier — snippets from `localMessageStorage`, chatId
    resolved from ChatContext by both surfaces), `call_stats` (local tier —
    `localCallStorage` aggregates), `entity_lookup` (graph tier — pure fuzzy
    resolve over members/groups/merchants). Local tools work through injected
    async providers so aiTools stays pure; `executeToolRequests` is now async.
  - **Local-tier rule ENFORCED**: engine pref 'pcc' removes local tools from
    the router's catalog entirely; on 'auto', executing one sets `usedLocal`
    and the turn NEVER narrates on PCC (even deep/overflow) — chat/call data
    cannot leave the device. Pinned by orchestrator tests.
- **P6 EXECUTED 2026-07-19** (legacy kill — the safe subset):
  - DELETED: `answerExpenseSmart` + `coercePlan` + `planExpenseQuery`
    (JS wrapper, native fn, `OnDeviceQueryPlan` struct) — the doc-17
    root-cause chain; the entire §A0 spike (`routeMessage`,
    `askOnDeviceStateful`, `resetOnDeviceSession`, `FMSessionStore`,
    `OnDeviceRouterDecision`, spike `routerInstructions`); `expensePlan.ts`
    (+ its tests) — orphaned by the chain's death. Zero references remain.
  - **KEPT deliberately (the P6 tail)**: the `ai_pipeline_v1` flag and the
    last-resort fallbacks (`askExpenseAiOnDevice` grounded one-shot; the
    insights legacy narrative path) — they are the safety net for old binaries
    and the kill-switch until the pipeline is verified on the physical device.
    Remove them + adopt the Apple Evaluations framework once on-device eval
    passes; that is the remaining P6 work.
  - Native deletions ride the next ship (deleted fns simply stop existing;
    current binaries keep them unused).
- **FULL STACK SHIPPED 2026-07-19**: `SplitCircle-production-20260719-105230.ipa`
  → TestFlight. Everything in this doc is in that binary: router, streaming,
  `pccAskDeep` depth engine, writes, local-tier tools + pin, legacy excised
  (clean compile = the P6 deletion proof). Next: on-device shakedown → close
  the P6 tail (drop the flag + fallbacks, adopt the Evaluations framework).

## 11. Open items

- Collect the user's worst real answers as eval fixtures (invited; doc-17 screenshots
  seed the suite meanwhile).
- PCC hop latency measurement on-device (network per hop) → may tune PCC hop cap.
- Budget/nudge write payloads need final shape when P4 starts (doc 21 bot infra).
