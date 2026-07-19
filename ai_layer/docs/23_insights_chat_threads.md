# 23 — Insights Chat & the AI Thread Framework

Built 2026-07-17 from the insights-chat brainstorm (all decisions user-locked in
conversation). Companion to [doc 22](22_stats_insights.md) (the stats/insights engine this
chat rides on) and [doc 17](17_chatbot_pipeline_v2.md) (assistant pipeline; its "AI-chat
hook" not-built item is THIS). This doc is the binding contract — don't re-litigate.

## Decisions (locked)

| Question | Decision |
|---|---|
| Entry point | The **AI narrative card only** (Group stats AND Personal stats). Card **morphs into a full-screen chat overlay**. Affordance **hidden entirely** when no model is available (smart-features-must-be-real). |
| Threads | **Fresh-by-default** (rev 2026-07-18): opening the card starts a NEW thread unless the latest was touched < 15 min ago (`shouldResumeThread`) — mid-session continuity without dragging users into yesterday's chat. History (model titles, dated) lives **inside the overlay**; explicit "New" still exists. |
| Engine choice | (rev 2026-07-18) User picks the model in-chat: tap the **title pill** → glass menu → Auto / On-device / Private Cloud (`insights_engine_v1`, app-wide). 'pcc' answers PCC-first (graceful on-device fallback, badge shows truth); 'ondevice' never touches PCC; deterministic routes unaffected. |
| Context choice | (rev 2026-07-18) Same menu picks the **facts range** (Month / 3 months / Year / All) via `factsForRange`; switches are disclosed with an in-thread context chip and the pill subtitle shows `engine · range`. |
| Persistence | **Local-only** (AsyncStorage — the app's Local tier, like messages; NEVER Firestore). **Capped ~20 threads per scope**, oldest pruned, swipe/tap-delete. |
| Stale threads | On resume, **fresh facts are injected; the AI answers from today's data and acknowledges drift** ("since we last talked…"). Disclosed via a **subtle context chip** in the thread. |
| Context budget | On-device window is 4–8K tokens. Overflow policy: **rolling summary** — older turns compact into a model-written digest; recent turns stay verbatim. |
| Numbers | Iron rule kept: **hybrid routing**. Deterministic engine answers money-math (exact, cited); the model narrates/explains/suggests and NEVER computes. |
| Capabilities | **Insights chat is read-only v1** (suggestion chips deep-link to real screens). The migrated Ask AI assistant **keeps its confirm-card writes**. |
| Scope | **Full rollout**: generic thread layer (threads keyed `surface:scope`) shared by insights chat AND the Ask AI assistant. Insights surface ships first; assistant migrates onto the same store. |
| Context scope | **Group-scoped rich facts** (the full statsInsights bundle) for group threads; personal cross-group facts for `insights:personal`. No raw-expense retrieval layer in v1. |
| PCC | Enrollment application starts NOW (lead time); on-device carries chat until granted. Escalation policy stays doc 17 §C.2. |
| Fairness gating | `fairnessAdminsOnly` applies to the AI facts too, not just cards — non-admin facts blobs carry no fairness data. |

## Architecture

```
narrative card tap
   └─▶ InsightChatOverlay (src/components/stats/InsightChatOverlay.tsx)
         ├─ threads:   aiThreadStore.ts  (AsyncStorage `ai_threads_v1:<surface>:<scope>`)
         ├─ turns:     insightsChatService.ts
         │     ├─ deterministic first: answerExpenseLocally (group scope) → exact, cited
         │     └─ else narrative:      askOnDevice(assembled prompt)      → explains/suggests
         └─ pure logic: aiThreads.ts   (assembly, budget, rollup, prune — vitest-covered)
```

- **`src/utils/aiThreads.ts`** — pure, unit-tested: thread/message types, `estimateTokens`
  (chars/4), `assembleInsightsPrompt` (instructions + facts + summary + recent verbatim
  turns + user message, budget-aware), `selectRollup` (which turns to fold into the
  summary), `pruneThreads`, `hashFacts`, `deterministicThreadTitle` fallback.
- **`src/services/aiThreadStore.ts`** — thin AsyncStorage store. One JSON doc per
  `surface:scope` holding its thread list (messages inline — threads are small and
  capped). API: `listThreads` / `latestThread` / `createThread` / `appendMessages` /
  `patchThread` / `deleteThread`.
- **`src/services/insightsChatService.ts`** — orchestration:
  - `openInsightsThread` — resume latest or create; seeds a new thread with the narrative
    as the first assistant message; on resume with a changed facts-hash, appends a
    `role:'context'` chip ("Context updated · <date>") and swaps the live facts.
  - `sendInsightsMessage` — hybrid turn: group scope tries `answerExpenseLocally`
    (deterministic, cited, `source:'deterministic'`); otherwise the narrative model
    answers from the assembled prompt (`source:'ondevice' | 'pcc'`). Personal scope is
    narrative-only (no per-group deterministic engine cross-group — facts numbers are
    final and quotable).
  - Rolling summary: when the assembled prompt would blow the budget, older turns are
    summarized on-device into `thread.summary` and marked `inSummary` (still displayed;
    just excluded from future prompts).
  - Titles: after the first exchange, the model writes a 3–5 word title; fallback is
    `deterministicThreadTitle` (seed insight + date).
- **Question-driven enrichment** (2026-07-18): `questionContext()` in statsInsights —
  when a chat turn names a month, category, member, or merchant, targeted deterministic
  aggregates (month totals, category monthly trail, member paid/share, merchant rows)
  ride into the prompt as an `EXTRA FACTS` block. Capped (3 months / 2 each), pure,
  vitest-covered. The model still only narrates; numbers stay precomputed.
- **Surface is GLASS-FIRST** (2026-07-18, DESIGN.md rule): LiquidBackground canvas,
  GlassView bubbles/chrome, grabber + swipe-down dismissal (JS-driven transforms — the
  entrance and drag share one transform node, so no native/JS driver mixing), and a
  live engine chip in the header mirroring the latest reply's badge.
- **Stateless by design.** Chat calls use `askOnDevice` with a fully-assembled prompt per
  turn — NOT the FMSessionStore native sessions. Rationale: native transcripts are
  in-memory (lost on relaunch), and per-turn assembly is the only way to control the
  budget + inject fresh facts + replay after cold start. The assistant's router keeps its
  native sessions; the two mechanisms coexist.

## Surfaces & keying

| Surface key | Scope | Context | Writes |
|---|---|---|---|
| `insights` | `<groupId>` | `buildStatsFacts` bundle (fairness admin-gated) | read-only |
| `insights` | `personal` | cross-group personal facts | read-only |
| `assistant` | `<groupId>` | doc-17 pipeline (unchanged) | confirm-card writes |

## PCC enrollment checklist (start now — lead time)

1. Apple Developer portal → the PCC / server-side Foundation Models enrollment form
   (WWDC26 session 319 names the program; navigate from Certificates, Identifiers &
   Profiles → Capabilities if the direct link moved).
2. Attest **< 2M lifetime downloads** (true for ManaSplit / ascAppId 6760814898).
3. On approval, the capability appears in the portal — **capture the exact entitlement
   string there** (it is NOT in any SDK header; doc 17 spike confirmed).
   ✅ CAPTURED 2026-07-18 from the regenerated profile: `com.apple.developer.private-cloud-compute`
   (boolean `true`), verified in both the embedded profile and the signed binary of
   build `SplitCircle-production-20260718-031746.ipa`.
4. Add the capability to the app id + regenerate profiles BEFORE touching
   `SplitCircle.entitlements` — same signing trap as the widgets App Group (CLAUDE.md).
5. Replace the spike `pccProbe` with a chat-shaped native fn (persistent session,
   real instructions, `quotaUsage` surfaced) — only worth building once `isAvailable`
   can be true.
6. Escalation policy on arrival: doc 17 §C.2 (context overflow or genuinely complex
   asks; PCC badge on messages; quota warnings).

## Context coverage (audited 2026-07-18)

What the model can ground on per turn: base facts (range totals, top-5 categories,
top-5 trends vs last month, member paid/share, admin-gated fairness, forecast, top-3
anomalies, budgets, savings) + rolling thread summary + recent verbatim turns +
question-driven EXTRA FACTS (named months ≤12 back, categories w/ 6-month trail,
members, merchants). Exact money-math bypasses the model entirely (deterministic
engine over RAW expense history, cited). Known gaps, deliberate for now:
- Relative timeframe phrases ("the month before that") still unresolved — doc 17
  A.4/A.5 remain open on the deterministic side; enrichment needs an explicit name.
- Personal scope: facts-only (no deterministic engine, no enrichment yet).
- Merchant enrichment is exact-substring on titles; fuzzy names won't match.

## Gotchas carried forward

- ALL PCC construction stays behind `Device.isDevice` + serialized probes
  ([doc 22](22_stats_insights.md) — simulator SIGSEGV).
- The overlay animates **transforms only** (fade scrim + scale/translate) — opacity/layout
  animations above native glass kill the material (DESIGN.md kill list).
- Facts are the ONLY numbers source; the narrator instructions forbid arithmetic. The
  deterministic path exists precisely so "how much…" never reaches the model.

## Status

- Built: thread layer · insights overlay on Group/Personal stats · Ask AI persistence on
  the thread store · assistant thread-history UI (header history/new, switch/delete,
  excerpt titles) · digest/insight chat cards deep-link into the insights chat
  (`openInsightsChat` param) · PCC escalation wired in `sendInsightsMessage`
  (overflow → PCC big-window assembly; on-device failure → PCC fallback; inert until
  enrollment — `tryPccPrompt` returns null).
- 2026-07-18: FM concurrency crash fixed — every model call rides the global
  `serializeFm` queue (see doc 22 gotchas / CLAUDE.md); `narrateInsights` dedupes
  identical in-flight requests.
- 2026-07-18: **PCC entitlement granted** (portal capability + regenerated profile, key
  `com.apple.developer.private-cloud-compute` in `SplitCircle.entitlements`). Native
  `pccAsk(question, instructions)` supersedes the spike probe for answers: real
  instructions, quota surfaced, stateless-by-design (prompt assembly stays in JS; the JS
  `serializeFm` queue is the concurrency guard). `pccProbe` remains for diagnostics;
  JS `pccAsk` falls back to it on pre-entitlement binaries. Persistent PCC sessions are
  deliberately deferred until the assistant router rides PCC (transcripts matter there;
  the insights chat is stateless per doc-23 design).
