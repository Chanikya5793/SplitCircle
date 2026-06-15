# On-Device AI Roadmap — receipts, Ask AI, and beyond

> Goal: maximise **on-device** AI (Apple Foundation Models + Vision) so SplitCircle
> pays **no per-call AI bill** and user data **never leaves the phone**, while
> keeping graceful fallbacks for non-eligible devices.
>
> Decisions locked with the product owner (2026-06-13):
> 1. **Sequencing:** full roadmap, phased (Phase 0 → 1 → 2 → 3).
> 2. **Gemini:** remove it. Eligible iPhones use Foundation Models; non-eligible
>    devices (older iPhones, Android) fall back to the on-device VisionKit parser
>    only. **Zero AI bill.**
> 3. **"Learns as we scan":** lightweight on-device learning + few-shot prompting
>    (extend `receiptLearningService`). **No custom LoRA adapters** (offline,
>    version-locked, retrain every OS update — deferred to Phase 4 / optional).
> 4. **Ask AI button bug:** fix shipped immediately as a standalone PR (Phase 0).

---

## Current state (June 2026, build 0.0.23)

| Feature | What powers it today |
|---|---|
| **Suggested split** (Add Expense) | `src/utils/smartSplitRecommender.ts` — pure on-device **heuristic** (most-frequent past method + scaled historical share ratios). No ML/LLM, no network. |
| **Ask AI** (group Q&A) | **On-device Apple Foundation Models** (`modules/splitcircle-ai`, `src/services/onDeviceAiService.ts`). Auto-uses AFM Core Advanced on iPhone Air / 17 Pro. **Was invisible** due to a header-override bug (fixed in Phase 0). |
| **Receipt scan** | Two-stage: (1) **VisionKit** native OCR + hand-written parser (on-device); (2) **Gemini 2.5 Flash** (cloud, `functions/src/parseReceiptWithLLM.ts`) for the structured parse when "Use AI for receipts" is ON (**default ON → active API bill**). Plus `receiptLearningService` per-merchant local corrections. |

---

## Research findings (what's possible on-device)

- **Vision `RecognizeDocumentsRequest`** (iOS 26, on-device): returns a hierarchical
  document — **tables (rows/columns)**, lists, paragraphs, and detected data
  (dates, phone, email, URLs). Receipts are tables, so this is a major upgrade
  over today's raw-text + regex parsing. Runs fully on-device.
- **Foundation Models** (iOS 26): on-device LLM with `@Generable` structured
  output and tool calling. Turns Vision's structured text into clean items /
  merchant / date / totals / category / rich insights — **replaces Gemini**.
- **Foundation Models image input** (multimodal): **iOS 27 / fall 2026** (beta
  now). Lets us feed the receipt photo directly — best for crumpled receipts.
  Not shippable on stable yet → Phase 4.
- **Custom LoRA adapters**: trained **offline** (Python toolkit), shipped as
  `.fmadapter` via Background Assets. **One adapter per OS model version** —
  hard-coded `baseModelSignature`, must retrain on every iOS model update or it
  refuses to load. **No continuous/on-device training.** Deferred.

Sources: Apple WWDC25 "Read documents using the Vision framework" (272), WWDC26
"What's new in the Foundation Models framework" (241), Apple Foundation Models
Adapter Training Toolkit docs + developer-forum notes on version locking.

---

## Target architecture — the on-device "Receipt Brain"

```
Camera / VNDocumentCamera
   ↓ (on-device)
Vision RecognizeDocumentsRequest  → structured text + tables + key fields
   ↓ (on-device, eligible devices)
Foundation Models @Generable      → { items[], merchant, date, subtotal, tax,
                                       tip, total, category, insights{...} }
   ↓
receiptLearningService overlay    → per-merchant corrections + few-shot examples
   ↓
Review UI (existing ReceiptScannerSheet)
```

- **Eligible (Apple Intelligence) devices:** Vision → Foundation Models. Free, private.
- **Non-eligible (older iPhone / Android):** Vision/VisionKit native parser only
  (today's path minus the Gemini call). Simpler, still on-device, **no bill**.
- **iOS 27+ (later):** optionally attach the receipt image directly to the model
  for crumpled/garbled receipts.

---

## Phases

### Phase 0 — Quick wins ✅ (this PR)
- Fix the Ask AI header-override bug (`GroupDetailsScreen` now shows **both** the
  Ask AI 🤖 and the info button); remove the dead navigator-level `headerRight`.
- This roadmap doc.

### Phase 1 — On-device Receipt Brain (remove Gemini) ✅ (shipped, code)
- Native module: Foundation Models `@Generable` receipt parser
  (`parseReceiptStructured` → `OnDeviceReceipt`) gated by availability.
- `ReceiptScannerSheet`: prefers the on-device FM parse on eligible devices;
  falls back to the VisionKit native parser otherwise. **Gemini path deleted**
  (`parseStructuredReceiptWithAI` + `EXPO_PUBLIC_GEMINI_PROXY_ENDPOINT` client;
  `parseReceiptWithLLM` Cloud Function removed). **Action for owner:** delete the
  `GEMINI_API_KEY` secret + the function from Firebase, and drop the env var from
  EAS — `firebase functions:secrets:destroy GEMINI_API_KEY`.
- `receiptLearningService.getReceiptNameHints` feeds learned corrections back as
  **few-shot examples** in the FM prompt so accuracy improves with use.
- Hygiene: `functions/lib` (compiled output, rebuilt by the predeploy hook) is
  now gitignored instead of committed.
- **Deferred to Phase 1b / 2:** upgrading the OCR step itself to Vision
  `RecognizeDocumentsRequest` (table-aware) inside the VisionKit native module —
  a separate native change requiring device verification.

### Phase 2 — Rich receipt insights + "More info" ✅ (shipped, code)
- FM `@Generable OnDeviceReceiptInsights` extracts merchant address, phone,
  payment method, savings/discounts, and return policy alongside the line items.
- Stored on `Expense.receipt.insights` (`ReceiptInsights`); `addExpense` /
  `updateExpense` now **merge** receipt metadata on image upload so insights
  survive. Captured through `ReceiptScannerResult` → `AddExpenseScreen`.
- Surfaced via a collapsible **"More info" section on the Expense Details page**
  (`buildReceiptInsightRows`, pure + unit-tested).
- **Deferred:** per-item categories, tax breakdown, loyalty/warranty — additive
  later if wanted.

### Phase 3 — More on-device AI (in progress)
Owner picked the full set + a voice assistant; building safest-first across a few PRs.

- **PR 1 ✅ (shipped, code) — "smarter Add Expense":**
  - On-device **smart categorization** (`suggestExpenseCategory` @Generable +
    `coerceCategory` + `onDeviceCategoryService`), wired into the receipt confirm
    flow with the keyword matcher as fallback.
  - Pure **duplicate / unusually-large anomaly warnings**
    (`utils/expenseAnomaly`, fully tested) surfaced as a banner in Add Expense.
- **PR 2 ✅ (shipped, code) — Natural-language expense entry:** native
  `parseExpenseFromText` (@Generable `OnDeviceParsedExpense`) +
  `utils/expenseNlParse` (name→id resolution, category coercion, amount/ date
  validation, pure + tested) + `onDeviceExpenseNlService`. A "Type it in plain
  English" box at the top of Add Expense prefills title/amount/category/
  participants/payer/split. Eligible devices only.
- **Next:**
  - **Voice assistant** — on-device speech (Speech framework) → NL entry / Ask AI
    (needs mic + speech Info.plist keys; highest native effort).
  - **Spending insights / month-in-review** — on-device narrative summary screen.
  - Optional: chat smart-replies; FM rationale on Suggested split.

### Phase 3.5 — Deterministic analytics engine (ACCURACY FIX) ✅ (shipped, code)
Device testing of Ask AI showed it was wrong ~99% of the time: it asked the small
on-device LLM to **filter + add up** raw expense rows, which LLMs provably can't do
(answers didn't match cited sources; "settlements" dumped expenses; "summarize"
overflowed the context). Root cause: we made the model do arithmetic.

Fix (research-backed — route math to a deterministic engine, use the LLM only for
language):
- `src/utils/expenseAnalytics.ts` — pure on-device "index": exact per-category /
  per-user / per-month totals + balances, reusing the app's canonical
  `debtMinimizer` so AI numbers match the Balances/Settle-up UI.
- `src/utils/expenseQuery.ts` — deterministic answerer for the common questions
  (category spend, balance/owe, settle-up, biggest, total, count, summary,
  with timeframe parsing). Returns exact numbers + real sources; `handled:false`
  for open-ended questions.
- `onDeviceAiService.answerExpenseLocally` is tried **first** in `AskAiScreen` →
  exact answers that need **no model**, so they're correct, instant, and work on
  **every device** (not just Apple Intelligence). The LLM is the fallback for
  open-ended questions only, now **grounded with a verified-totals facts block**.
- Overflow fix: bumped the context budget (70 tok/line, 1400 reserve) so
  "summarize" no longer exceeds the window; summaries are also answered
  deterministically.
- Regression tests mirror the exact failing screenshots.
- **Expanded** (follow-ups shipped): per-member queries ("how much did Bob spend
  on food"), "who paid/spent the most", average expense; **pairwise balances**
  ("how much do I owe Bob" via exact `pairwiseNet`), "what did I pay for", recent
  expenses; and a **memoized analytics index** (`getGroupAnalytics`, cached by a
  cheap change-signature) — the reusable on-device "index" the cache goal called
  for.
- **Deprioritized:** disk-persisting the index — low value, since the source
  expenses must already be in memory (live `GroupContext`) before we can answer,
  making a recompute of the pure index effectively free.
- **Also shipped:** period **comparison** ("this month vs last month", "am I
  spending more than last week", optional category + per-member), monthly
  **trend**, all-member **balances overview**, **spending-by-category breakdown**,
  per-member **spending leaderboard**, and a help/capabilities fallback so
  nothing dead-ends. Q&A coverage is now comprehensive (91 unit tests).
- **Next (this track):** optional LLM phrasing of deterministic facts; reuse the
  index in Group Stats / a "month in review" surface.

### Phase 5 — Conversational assistant (chatbot that answers AND acts) — in progress
Evolves the single-shot Ask AI into a multi-turn chatbot.

- **PR 1 ✅ (shipped, code):** `AiChatScreen` (multi-turn thread, action
  confirmation cards, iOS keyboard dictation mic for voice). Orchestrator
  `assistantService.processAssistantTurn` routes each message:
  - **question →** deterministic engine (exact, every device);
  - **add expense →** on-device NL parse → confirm card → `addExpense`;
  - **settle up →** pure `parseSettlement` (+ exact `pairwiseNet` when no amount
    given) → confirm card → `settleUp`;
  - **open-ended →** on-device LLM (grounded).
  Every write is a `ProposedAction` the user must Confirm — the model never
  mutates data directly. Pure core (`utils/assistantChat`) is unit-tested.
- **Architecture:** structured-intent (model parses → JS confirms → executes via
  tested `GroupContext`), not Swift tool-calling — keeps writes in the verified
  layer with a human confirm step.
- **PR 2 ✅ (shipped, code):** **delete expense** (matched by title via
  `matchExpenseByText`, destructive red confirm) and **navigate/open** a screen
  ("open settle up", "show stats" → Settlements/Stats/Bills/Add-Expense/Group-Info).
- **PR 3 ✅ (shipped, code):** **edit expense** (rename / change amount [re-splits
  equally] / change category, via `parseExpenseEdit`, before→after confirm) and
  **delete settlement** (`matchSettlement`, destructive confirm).
- **Next (held until on-device verification):** group management (rename /
  add-remove member / leave / delete group) — destructive, warned; a dedicated
  on-device `SFSpeechRecognizer` mic button (needs `NSSpeechRecognitionUsageDescription`
  + audio-session coexistence with calls).

### Phase 4 — Optional / advanced
- iOS 27 direct-image receipt understanding (crumpled receipts).
- Custom LoRA adapter pipeline (with the version-lock maintenance cost).

---

## Constraints / risks
- Foundation Models needs Apple Intelligence hardware (iPhone 15 Pro+); covered by
  the native fallback for everyone else.
- Builds need **Xcode 26.4+** (already pinned in `eas.json`); `--local` builds need
  local Xcode ≥ 26.4.
- Swift can't be compiled in the cloud sandbox — Phases 1–2 require device testing.
- Token budget: long receipts may need chunking within the model context window
  (`maxExpensesForContext`-style budgeting already exists for Ask AI).
