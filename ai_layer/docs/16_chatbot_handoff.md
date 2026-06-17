# SplitCircle AI Chatbot — Handoff Brief

## 1. Product vision

The "Ask AI" chatbot (group-scoped) should be a **full-fledged conversational assistant** that can do everything a user can do in the app — answer questions about spending/balances *and* take actions (add expense, settle up, edit/delete, navigate) — every write confirmed by the user first. It must feel  **smart and reliable** : keep conversation continuity, ask clarifying questions when info is missing, offer tappable option chips, and  **never hallucinate numbers** . It must work **offline** and use **only on-device Apple Intelligence** (no paid external APIs), escalating to **Private Cloud Compute** for genuinely complex requests once that's viable.

## 2. Core architectural principle (non-negotiable)

**LLMs must NOT do arithmetic, aggregation, or filtering.** All numbers come from a deterministic engine; the on-device model is used only to *understand phrasing* and (future)  *phrase answers* . This was the root-cause fix for the original "AI is wrong 99% of the time" problem. Pipeline =  **understand → retrieve (exact, cited) → optional compose** .

## 3. User decisions already made (do not re-litigate)

* **All app functions** exposed through chat, rolled out in waves,  **confirm before any write** .
* **Keyboard dictation** for voice now (the iOS keyboard mic); a dedicated `SFSpeechRecognizer` button is deferred (needs `NSSpeechRecognitionUsageDescription` + audio-session coexistence with WebRTC/CallKit).
* **Missing info → always ask back with choice chips** (e.g. [Everyone] [Just me]).
* **Chat memory → persist per group** (survives navigation + app restart).
* **On-device only** ; for complex requests, **escalate to Apple's Private Cloud Compute** (WWDC 2026 framework) —  *researched, not shippable yet (see §8)* .

## 4. Current architecture (what exists now, shipped to `main`)

**Conversation manager** — [`src/services/assistantService.ts`](https://github.com/Chanikya5793/SplitCircle/blob/main/src/services/assistantService.ts)

* `processAssistantTurn(message, group, currentUserId, state: ConversationState): Promise<AssistantTurn>`.
* `ConversationState = { pending?: {intent:'add_expense'|'settle_up', draft}, lastProposed?: ProposedAction }` carried across turns (replaced the old brittle `priorContext` string-merge that caused intent contamination).
* Turn pipeline: **(1)** modify a pending proposal → **(2)** continue slot-filling (unless user switched intent) → **(3)** fresh classify → route.
* **Slot-filling** : add-expense collects amount → "what for?" → "who's it split between?" (with choice chips). settle-up asks "who?" with member chips.
* **Proposal modification** : after a confirm card, `detectExpenseModification` turns "split with everyone / only me / me and Ram / make it 50 / category to Food / paid by Sam" into edits (re-splits equally).
* `AssistantTurn = { reply, sources?, action?, choices?: string[], state }`.
* `ProposedAction` union: add_expense / settle_up / delete_expense / edit_expense / delete_settlement / navigate. The UI executes only on Confirm.

**Pure NLU helpers** — [`src/utils/assistantChat.ts`](https://github.com/Chanikya5793/SplitCircle/blob/main/src/utils/assistantChat.ts) (no RN imports, unit-tested)

* `classifyMessage` (intents + guards: help, "show settle-ups"→question, intent priority).
* `parseParticipants` (everyone / just me / "me and Ram"; matches a name's **alphabetic core** so "ram"→"Ram12", "soumya"→"Soumya_k").
* `extractExpenseTitle`, `detectExpenseModification`, `parseSettlement`, `parseExpenseEdit`, `matchExpenseByText`, `matchSettlement`, `detectNavTarget`, `findMember`, `parseAmount`.

**Deterministic answer engine** (numbers, exact + cited)

* [`src/utils/expenseQuery.ts`](https://github.com/Chanikya5793/SplitCircle/blob/main/src/utils/expenseQuery.ts) — `answerExpenseQuery` (spend/balance/pairwise/settle-up/biggest/count/avg/leaderboard/breakdown/summary/trend/help). `ASSISTANT_CAPABILITIES`.
* [`src/utils/expenseAnalytics.ts`](https://github.com/Chanikya5793/SplitCircle/blob/main/src/utils/expenseAnalytics.ts) — memoized analytics index (`getGroupAnalytics`), `pairwiseNet`, timeframe parsing; reuses `debtMinimizer`.
* [`src/utils/expensePlan.ts`](https://github.com/Chanikya5793/SplitCircle/blob/main/src/utils/expensePlan.ts) — `planToQuestion(plan)` maps a structured plan to a canonical question.

**RAG glue** — [`src/services/onDeviceAiService.ts`](https://github.com/Chanikya5793/SplitCircle/blob/main/src/services/onDeviceAiService.ts)

* `answerExpenseLocally` (deterministic fast path), `answerExpenseSmart` (FM `planExpenseQuery` → `planToQuestion` → `answerExpenseQuery`, exact + cited), `askExpenseAiOnDevice` (grounded FM fallback).

**Native module** — [`modules/splitcircle-ai/ios/SplitCircleAIModule.swift`](https://github.com/Chanikya5793/SplitCircle/blob/main/modules/splitcircle-ai/ios/SplitCircleAIModule.swift) (Foundation Models, iOS 26+; `@Generable`; guarded by `#if canImport(FoundationModels)` + `@available(iOS 26.0,*)`): `planExpenseQuery`, `parseExpenseFromText`, `suggestExpenseCategory`, `parseReceiptStructured`, `askOnDevice`, `getOnDeviceAiAvailability`, `getOnDeviceContextSize`, `redactPII`, `donateAskActivity`. JS wrappers in [`modules/splitcircle-ai/index.ts`](https://github.com/Chanikya5793/SplitCircle/blob/main/modules/splitcircle-ai/index.ts).

**Category inference** — [`src/utils/categoryMatch.ts`](https://github.com/Chanikya5793/SplitCircle/blob/main/src/utils/categoryMatch.ts): `categorizeText` (keyword→category, e.g. gas→Transport, rent→Utilities) + `coerceCategory`.

**UI** — [`src/screens/ai/AiChatScreen.tsx`](https://github.com/Chanikya5793/SplitCircle/blob/main/src/screens/ai/AiChatScreen.tsx)

* Carries `ConversationState` in `stateRef`; renders choice chips; tappable citation cards → ExpenseDetails; confirm/cancel cards (red for destructive); keyboard-avoiding; liquid-glass background.
* **Persistence** — [`src/services/chatSession.ts`](https://github.com/Chanikya5793/SplitCircle/blob/main/src/services/chatSession.ts) (`loadChatSession`/`saveChatSession`/`clearChatSession`, AsyncStorage key `chat_session_v1_${groupId}`, capped 60 msgs).

## 5. What's done (merged to `main`, NOT device-verified yet)

Stateful conversation manager, slot-filling, choice chips, proposal modification, intent switching, name-core matching, help fix, "show settle-ups" fix, deterministic+offline add/settle path, per-group persistence, tappable citations. **174 unit tests green, tsc clean.** Latest build: `https://expo.dev/artifacts/eas/hsdxr7IsOaF2_ki9e1DTKhqY6U2vMc-LU5rAWNQphSQ.ipa`. Awaiting on-device verification.

## 6. The bugs this replaced (from device screenshots)

Intent contamination ("add an expense"→"who to settle with?"), no memory of proposals ("split with everyone" dumped a settle-up plan), weak help ("I am your expense assistant"), name-match failures (Ram12→split 1 way), "show settle-ups" firing the settle action. All fixed deterministically.

## 7. Known gaps / next steps (priority order)

1. **Device-verify** the current build (esp. slot-filling + modification flows).
2. **Multi-select participant chips** — current chips are single-select presets; "pick several specific people" still requires typing. Consider a multi-select UI.
3. **FM compose** (P1.4b) — optional natural phrasing over the *exact* facts; must verify number fidelity on device.
4. **PCC escalation** for complex requests (§8).
5. **Richer entity memory** — pronoun resolution ("delete that", "split it with them") using `lastProposed`/recent entities.
6. Voice (dedicated mic), month-in-review summary screen.

## 8. Private Cloud Compute — researched, blocked (see [`ai_layer/docs/15_conversational_assistant.md`](https://github.com/Chanikya5793/SplitCircle/blob/main/ai_layer/docs/15_conversational_assistant.md))

* API: `PrivateCloudComputeLanguageModel()` → same `LanguageModelSession(model:)`; `ContextOptions(reasoningLevel: .light/.moderate/.deep)`; 32K context; `model.isAvailable` + `model.quotaUsage`.
* Escalate when prompt exceeds on-device context (`contextSize` + `tokenCount`) or needs multi-step reasoning.
* **Not shippable now:** iOS 27-only (Xcode 27 SDK) **and** requires a PCC entitlement + App Store Small Business Program +  **<2M lifetime account downloads** . Gate behind `if #available(iOS 27)`; verify exact entitlement string against the SDK.

## 9. Hard constraints (these have bitten us)

* **Bare iOS workflow** — `ios/` is committed; **never** `expo prebuild`; `pod install` only. RN 0.83 / Expo SDK 55.
* **EAS** : `production` profile, **image pinned** `macos-tahoe-26.4-xcode-26.4` in `eas.json` (Xcode <26.4 fails to compile `contextSize`). Build: `eas build --platform ios --profile production --non-interactive` (account `chanikya6163`).
* **vitest** : `@/` *value* imports break tests → use **relative imports** in tested pure files; type-only `@/` imports are fine. Test config: `vitest.unit.config.ts` (globs `src/utils/__tests__/**`, `modules/splitcircle-ai/src/__tests__/**`). Run `npm run test:unit`.
* **Firestore on RN is memory-cache-only** (no IndexedDB) — offline reads come from AsyncStorage caches (`groupCache`, `profileCache`), offline writes from a durable outbox (`services/outbox` + `utils/outboxApply`). Don't reintroduce `runTransaction` on the add/settle path (fails offline).
* **No paid external AI APIs** (Gemini fully removed); on-device Foundation Models only.

## 10. Verification commands

`npm run test:unit` (pure logic) + `npx tsc --noEmit` (app). Swift/native + UI must be confirmed on a real Apple-Intelligence device (iPhone 15 Pro+; user has iPhone 17 Pro). Branch convention: develop on `claude/test-coverage-analysis-myt3c1`, PR → `main`.
