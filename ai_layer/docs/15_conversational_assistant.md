# Conversational assistant — stateful pipeline

> Goal: a reliable, accurate chatbot that keeps continuity, asks back when info
> is missing (with tappable choices), and never guesses on the money path.

## What was broken (from device screenshots)
1. **Context contamination** — a string-merge of the prior message kept re-firing
   the previous intent ("I want to add an expense" → "Who do you want to settle
   up with?").
2. **No memory of a proposal** — "split with everyone / only me / me and Ram"
   should edit the just-proposed expense, but dumped a settle-up plan instead.
3. **Weak help** — "what **all** can you do?" missed the help regex → fell to the
   on-device LLM → "I am your expense assistant."
4. **Misclassification** — "show the settle-ups" triggered the settle ACTION;
   "Ram12"/"Soumya_k" weren't matched when the user typed "ram"/"soumya" → splits
   defaulted to 1 way.

## The redesign
- **ConversationState carried across turns** (`assistantService`): replaces the
  brittle `priorContext` string with `{ pending?: {intent, draft}, lastProposed? }`.
- **Slot-filling**: add-expense collects amount → what for → who's it split between
  one step at a time, asking back with **choice chips** ([Everyone] [Just me] +
  member names) when a slot is missing. Settle-up asks "who?" with member chips.
- **Proposal modification**: after a confirm card is shown, `detectExpenseModification`
  turns "split with everyone", "only me", "make it 50", "category to Food",
  "paid by Sam" into edits of the proposal (re-split equally) instead of a new turn.
- **Intent switching**: a clear new action mid-flow abandons the pending flow
  rather than merging into it.
- **Deterministic parsing** (offline, reliable) for the chat add/settle path:
  `parseParticipants` (handles "everyone" / "just me" / "me and Ram" and matches a
  name's alphabetic core, so "ram" matches "Ram12"), `extractExpenseTitle`,
  `categorizeText` (keyword → category, e.g. gas→Transport, rent→Utilities). The
  on-device model is no longer in the add/settle path.
- **Classifier guards**: help (broadened, incl. "what all can you do"), and
  "show/list the settle-ups" routes to the QUESTION (display the plan).
- **Per-group persistence** (`services/chatSession`, AsyncStorage): the thread +
  context survive navigation and app restarts (stale confirm cards are retired on
  restore). Cleared implicitly by overwrites.
- **Answer path unchanged**: deterministic exact + cited → smart RAG (FM
  understands → exact retrieval) → on-device model → reliable nudge.

All pure logic is unit-tested (`assistantConversation.test.ts`, +
`expenseQuery`/`expensePlan`).

## Private Cloud Compute (complex-request escalation) — research verdict
Researched Apple's WWDC 2026 PCC additions to the Foundation Models framework:
- **API:** `PrivateCloudComputeLanguageModel()` conforms to the new `LanguageModel`
  protocol and plugs into the same `LanguageModelSession(model:)`; PCC-only
  `ContextOptions(reasoningLevel: .light/.moderate/.deep)`; 32K context vs 4K/8K
  on-device. Availability via `model.isAvailable` + `model.quotaUsage`.
- **Escalate when:** prompt/context exceeds the on-device window, or the task needs
  multi-step reasoning. Detect via `contextSize` + `tokenCount(for:)`; otherwise
  stay on-device (offline, no quota).
- **⚠️ Not shippable now (gating):**
  - **iOS 27 only** (Xcode 27 SDK); on-device FM is the iOS 26 stable surface.
  - Requires a **Private Cloud Compute entitlement** assigned to the account, AND
    membership in the **App Store Small Business Program**, AND **< 2M lifetime
    downloads** across the whole developer account (no paid tier to exceed it).
  - Requires network; daily per-user quota.
- **Plan:** keep the deterministic + on-device pipeline as the shipping path. Add a
  gated `PrivateCloudComputeLanguageModel` escalation behind `if #available(iOS 27)`
  once we're on the iOS 27 SDK and the entitlement is granted — verify the exact
  entitlement string + `respond(to:generating:contextOptions:)` signature against
  the SDK. (Sources: WWDC26 sessions 319/241/242, Apple FoundationModels docs.)
