# SplitCircle Chatbot — Pipeline v2 Roadmap (LLM utilization fix)

> Companion to [`16_chatbot_handoff.md`](16_chatbot_handoff.md). That doc describes
> the *stateful conversation manager* that shipped. This doc diagnoses **why the
> live chatbot still feels broken** (device screenshots, June 2026), corrects the
> toolchain assumptions, folds in current WWDC26 / iOS 27 research, and lays out a
> phased plan to make the on-device model actually earn its place.

---

## 1. Diagnosis — what's broken and why (mapped to the screenshots)

The core principle from doc 16 is right and stays: **the LLM must never do arithmetic;
numbers come from the deterministic engine.** The breakage is *not* the math path — it's
the **routing/understanding layer** and the fact that **the on-device model is wired in as a
last-resort fallback with no guardrails**, so the moment a message escapes the deterministic
regexes it hits a model that confidently fabricates a plan.

| # | Screenshot symptom | Root cause (file) | Category |
|---|---|---|---|
| 1 | `"Hello"` → dumped a 9-line **settle-up plan** | Greeting isn't caught → `answerExpenseQuery` returns `NOT_HANDLED` → `answerExpenseSmart` → `planExpenseQuery("Hello")` → model hallucinates `intent: settle_up` → `planToQuestion` → "show our settle-up". `coercePlan` happily accepts any intent; there is no abstain. ([onDeviceAiService.ts:84](../../src/services/onDeviceAiService.ts), [SplitCircleAIModule.swift:383](../../modules/splitcircle-ai/ios/SplitCircleAIModule.swift)) | LLM has no "unknown/abstain" discipline |
| 2 | `"Clear the chat"` → `"3206.02 USD"` | No command vocabulary for chat-control / meta. Falls through to the LLM → spend plan → a number. ([assistantChat.ts:218](../../src/utils/assistantChat.ts)) | Missing intent + greedy fallback |
| 3 | `"Aprils total?"` / `"What about April?"` → **all-time total** or a hallucinated `"this month / General"` | `parseTimeframe` only knows relative words (this/last month/week/year, today) — **no explicit month names**. `OnDeviceQueryPlan.timeframe` enum has the same gap. "April" silently drops to all-time, or the model invents `this_month`. ([expenseAnalytics.ts `parseTimeframe`](../../src/utils/expenseAnalytics.ts), [expensePlan.ts:29](../../src/utils/expensePlan.ts)) | Timeframe coverage gap |
| 4 | `"What about the month before that?"` → inconsistent / wrong | **Questions are stateless.** `answerQuestion` always returns `state: {}`, so relative follow-ups have nothing to anchor to. No "last query" memory, and no relative-month arithmetic. ([assistantService.ts:395](../../src/services/assistantService.ts)) | No conversational memory on the Q&A path |
| 5 | Tapping a member chip (`"Six"`, `"Soumya_k"`) → generic spend answer | After an earlier cancel cleared state, a bare name classifies as `question` → escapes deterministic → LLM forces a spend plan. The chips were participant chips but the flow had already been torn down. | Cascade of #1–#4 |
| 6 | `"asd"` (a valid participant) → `"Add this expense? Cancelled."` | On session restore the screen **deliberately wipes** `pending` and `lastProposed`: `stateRef.current = { ...saved.state, pending: undefined, lastProposed: undefined }`. Any reload mid-flow kills the in-progress draft and retires the confirm card. ([AiChatScreen.tsx:132](../../src/screens/ai/AiChatScreen.tsx)) | Persistence drops conversation state |

### The structural problem (one sentence)

> The pipeline is **"deterministic-first, model-as-fallback."** The model's only structured
> job (`planExpenseQuery`) is a thin pass with **no abstain, no conversation transcript, and a
> too-narrow canonical vocabulary** — so every message the regexes miss lands on a model that
> can't say "I don't know" and instead invents an answer.

And the single biggest *underutilization*: **every model call spins up a brand-new
`LanguageModelSession`** ([askOnDevice / planExpenseQuery](../../modules/splitcircle-ai/ios/SplitCircleAIModule.swift)).
Foundation Models gives you a **multi-turn `Transcript`** for free — we throw it away on every
turn, so the model literally never sees what was said one message ago. That's why follow-ups
("what about April", "the month before that", "split it with them") fall apart.

---

## 2. Toolchain reality

We build with **Xcode-beta.app = Xcode 27.0 (Build 27A5194q)**, which ships the **iOS 27.0 SDK**.
State on this Mac:

```
/Applications/Xcode-beta.app → Xcode 27.0 (27A5194q), SDK: iphoneos27.0   ← USE THIS
/Library/Developer/CommandLineTools → 26.5 (what `xcode-select -p` points at by default)
Sim runtimes installed: iOS 26.3, iOS 26.5, iOS 27.0 (24A5355p)
```

What this means:

- ✅ **iOS 27-only API compiles today** — `PrivateCloudComputeLanguageModel`, `.image()` input,
  Dynamic Profiles, the Evaluations framework, the 8192-token context — are all available against
  the iOS 27 SDK in Xcode-beta. PCC and image input are **no longer blocked on the SDK.**
- ⚠️ **Point the toolchain at the beta** for local builds: `sudo xcode-select -s
  /Applications/Xcode-beta.app/Contents/Developer` (or set `DEVELOPER_DIR` per-build). The default
  `xcode-select` currently resolves to CommandLineTools / 26.5.
- ⚠️ **EAS cloud builds are the real gate, not the SDK.** `eas.json` pins
  `macos-tahoe-26.4-xcode-26.4`, which has **no iOS 27 SDK** — any `#if available`/iOS-27 symbol will
  fail to compile in the cloud until EAS offers an Xcode 27 image (or you build `--local` /
  archive from Xcode-beta directly). Track this before shipping Phase C.
- ✅ **Runtime gating still required:** wrap iOS-27 API in `if #available(iOS 27.0, *)` so the binary
  still runs on iOS 26 devices (on-device FM stays the iOS-26 baseline).
- ➡️ **Conclusion:** Phase A (pipeline/prompt/transcript) is still the right *first* move because it
  fixes the visible bugs and is low-risk — but Phases B and C are now **compile-unblocked**; their
  only remaining gates are the **EAS image** (B/C) and **PCC enrollment** (C).

---

## 3. Research — Foundation Models, iOS 26 → iOS 27 / WWDC26

Verified against WWDC26 sessions 241 (what's new), 242 (agentic), 319 (PCC), and Apple docs.

### Available **today** (iOS 26 SDK, buildable on Xcode 26.5) — and underused

- **Multi-turn `Transcript`.** A `LanguageModelSession` keeps the full prompt/response history;
  reuse the *same* session across turns for real continuity. **We create a fresh one each call.**
- **Instructions vs. prompt.** Session `instructions` (the system prompt) are cached/optimized and
  meant to carry persona + rules; per-turn `prompt` carries the user message. Our instructions are
  one terse paragraph.
- **Guided generation** (`@Generable` + `@Guide`) — already used well for the receipt/plan structs.
- **Tool calling** — the model can call Swift tools. We *deliberately avoid* this on the write path
  (JS confirms every mutation) — keep that safety choice. Tools are still useful read-side.
- **`GenerationOptions`** (temperature/sampling) and **`prewarm()`** — not used; prewarm cuts first-token latency.
- **`contextSize`**: 4096 tokens on iOS 26 (already read via `getOnDeviceContextSize`).

### New in **iOS 27 / WWDC26** (needs Xcode 27 SDK → later phase)

- **`PrivateCloudComputeLanguageModel`** — same `LanguageModelSession(model:)` API, **32K context**,
  `ContextOptions(reasoningLevel: .light/.moderate/.deep)`, `model.isAvailable`, `model.quotaUsage`.
  **The WWDC26 gating is softer than doc 16 §8 said:** **no API key, no auth, no token cost** (uses
  the user's iCloud account; iCloud+ raises the daily quota). Still: **Apple-Intelligence devices
  only, requires internet, < 2M lifetime account downloads, and you must apply/enroll on the
  developer site.** The "App Store Small Business Program" line in doc 16 appears **outdated** —
  re-verify the exact enrollment + entitlement string against the shipping Xcode 27 SDK.
- **On-device context grows to 8192 tokens** on iOS 27 (newer devices) — more grounded expenses per answer.
- **Image input** via a `.image()` content block on the same session (no separate endpoint) — directly
  feeds crumpled receipt photos (supersedes the Phase 4 "direct-image receipt" item in doc 12).
- **Evaluations framework** — a new Swift framework to *measure* a Foundation Models feature. Ideal for
  regression-testing the router (see Phase A.6).
- **Dynamic Profiles** — first-class multi-agent workflow primitive (probably overkill for us).
- **MLX backend / open-sourcing later in summer 2026** — not needed.

**Sources:** [WWDC26 319 — PCC](https://developer.apple.com/videos/play/wwdc2026/319/),
[WWDC26 241 — what's new](https://developer.apple.com/videos/play/wwdc2026/241/),
[WWDC26 242 — agentic](https://developer.apple.com/videos/play/wwdc2026/242/),
[Xcode 27 / iOS 27 timeline](https://andrew.ooo/answers/wwdc-2026-developer-tools-xcode-swift-foundation-models-june-2026/).

---

## 4. The redesign — invert the relationship

Keep the non-negotiable (LLM ≠ arithmetic). **Change the model from a last-resort fallback into the
front-door understander**, with a single stateful session and strict structured output. Numbers still
come only from the deterministic engine.

```
                 ┌─────────────────────────────────────────────┐
   user turn ───▶│  On-device router (ONE persistent session)   │
                 │  @Generable RouterDecision {                 │
                 │    intent, confidence, abstain,              │
                 │    slots{amount,title,category,participants},│
                 │    queryPlan{intent,scope,category,member,   │
                 │              metric, timeframe(+month/year,  │
                 │              relativeShift)},                │
                 │    chitchatReply?  }   ← sees full Transcript │
                 └───────────────┬─────────────────────────────┘
            abstain / low-conf    │ structured, grounded
            or chit-chat ─────────┘
                 │                            ┌──────────────────────────┐
   greeting/help/meta ──────────────────────▶│ deterministic responders │
   "clear the chat" handled in JS             │ (exact numbers + cites)  │
                                              └──────────────────────────┘
```

Two rules make it safe:
1. **The model classifies and fills slots; it never emits final numbers.** Every `queryPlan` is
   executed by `answerExpenseQuery`; every write is a `ProposedAction` the user confirms.
2. **The model must be allowed to abstain.** Add `abstain: Bool` + `confidence` to the struct and a
   strong instruction: *"If the message is a greeting, small talk, or not about this group's money,
   set abstain=true."* On abstain → friendly canned reply or help, **never** a fabricated plan.

---

## 5. Roadmap

### Phase A0 — Native compile + runtime spike (de-risk before the rewrite) ⬅ START HERE

A throwaway, **feature-flagged** spike on branch `spike/fm-ios27`. Goal: prove the unknown
Foundation Models / iOS 27 symbols **compile against Xcode-beta's iOS 27 SDK** and behave on a real
device, *before* committing to the Phase A→C wiring. Each probe is a small guarded addition to
[`SplitCircleAIModule.swift`](../../modules/splitcircle-ai/ios/SplitCircleAIModule.swift) behind
`#if canImport(FoundationModels)` + `#available`; we keep only what's proven.

| Probe | What it proves | API era | Where validated |
|---|---|---|---|
| **S1 — baseline build** | Existing project builds clean on Xcode-beta 27 (`DEVELOPER_DIR=/Applications/Xcode-beta.app/...`, fresh `pod install`). | — | local build |
| **S2 — persistent session** | A module-level `[groupId: LanguageModelSession]` cache + `prewarm()` + `resetSession()` reused across `askOnDevice` calls; transcript continuity ("…and last month?" follows context). | iOS 26 | device |
| **S3 — RouterDecision @Generable** | New router struct (`intent`/`confidence`/`abstain`/`slots`/`queryPlan`) + a `routeMessage()` async fn with the system prompt as session `instructions`; sane structured output. | iOS 26 | device |
| **S4 — contextSize** | `SystemLanguageModel.default.contextSize` → **8192 on iOS 27**, 4096 on 26. | iOS 27 | device |
| **S5 — PCC (biggest unknown)** | `PrivateCloudComputeLanguageModel()`, `LanguageModelSession(model:)`, `respond(to:generating:contextOptions: ContextOptions(reasoningLevel:))`, `model.isAvailable`, `model.quotaUsage` all **compile**; capture the exact **entitlement string** from the SDK header. | iOS 27 | compile (runtime gated on entitlement) |
| **S6 — deferred** | `.image()` input + Evaluations framework — note, skip in first spike. | iOS 27 | — |

**Validation matrix (important):**
- **Compile** = the real win on Xcode-beta; everything above must build green locally.
- **Simulator (iOS 27):** app runs, but Apple Intelligence / FM typically reports **unavailable on the
  simulator** — so model *responses* can't be validated there. Sim is for compile + non-AI runtime only.
- **Device (iPhone 17 Pro):** required to validate S2/S3/S4 actual responses. **S5/PCC runtime** stays
  blocked until the PCC entitlement is granted — compile-only is the expected outcome for the spike.

**Decision gate:** APIs that compile + behave → lock into Phase A/B/C as written. Anything that fails
to compile or signatures differ from doc 16 §8 / §3 here → revise the plan before the big rewrite.

**Spike risks:** sim FM unavailability (need the physical device); EAS image lacks the iOS 27 SDK, so
spike builds are **local-only**; PCC entitlement not yet granted (compile-only validation of S5).

**Decisions locked (2026-06-16):** validate on the **physical iPhone 17 Pro** (FM responses for
S2–S4); **include the PCC compile probe S5** in this first spike (runtime stays gated on enrollment).

#### Spike log

- **S1 / baseline — ✅ PASS (2026-06-16).** App + the `SplitCircleAI` Foundation Models module compile
  clean on **Xcode 27.0 (27A5194q) / iOS 27.0 SDK** for the iPhone 17 Pro simulator (`** BUILD
  SUCCEEDED **`, only a benign `@unchecked Sendable` warning). **One required fix:** the iOS 27 SDK
  rejects deployment targets < 15.0, and three pod resource-bundle sub-targets (`SDWebImage` 9.0,
  `RNCAsyncStorage` 13.4, `RNSVG` 12.4) shipped stale floors. Fixed with a `post_install` loop in
  [`ios/Podfile`](../../ios/Podfile) flooring every pod target at the app's 15.1. **Carry-overs:**
  (a) this Podfile fix must also land in whatever Xcode-27 EAS image we adopt (Phase B.1); (b) run
  `pod install` with `LANG=en_US.UTF-8` (CocoaPods 1.16.2 + Ruby 4 throws an encoding error without
  it); (c) point the toolchain at the beta via `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer`.

- **S2 / S3 / S5 — ✅ COMPILE PASS (2026-06-16).** All three probes build clean against the iOS 27
  SDK (`** BUILD SUCCEEDED **`). Added to
  [`SplitCircleAIModule.swift`](../../modules/splitcircle-ai/ios/SplitCircleAIModule.swift) (guarded,
  additive — existing functions untouched) with JS wrappers in
  [`modules/splitcircle-ai/index.ts`](../../modules/splitcircle-ai/index.ts):
  - **S2** `askOnDeviceStateful(sessionId,…)` + `resetOnDeviceSession(sessionId)` over an
    `FMSessionStore` cache of persistent `LanguageModelSession`s (`prewarm()`ed). Compiles; the
    `nonisolated(unsafe)` global store needs proper locking before shipping (a session serves one
    request at a time).
  - **S3** `routeMessage(sessionId,text,members,isoDate)` → `OnDeviceRouterDecision` @Generable with
    `intent`/`confidence`/`abstain`/`chitchatReply` + a **nested** `OnDeviceQueryPlan` (proves nested
    guided generation compiles). Richer `routerInstructions(…)` system prompt with the abstain rule.
  - **S5** `pccProbe(question)`: `PrivateCloudComputeLanguageModel()`, `.availability`
    (`.available`/`.unavailable(.deviceNotEligible|.systemNotReady)`), `LanguageModelSession(model:)`,
    `respond(to:contextOptions: ContextOptions(reasoningLevel: .light))` all compile.
- **API findings (verified against the Xcode-beta iOS 27 swiftinterface — correct doc 16 §8 guesses):**
  - PCC init is **no-arg** `PrivateCloudComputeLanguageModel()`; plugs into `LanguageModelSession(model:)`.
  - `ContextOptions(includeSchemaInPrompt:reasoningLevel:)`; `ReasoningLevel = .light/.moderate/.deep/.custom(String)`.
    `respond` takes `contextOptions:` (+ `options: GenerationOptions`, `metadata:`).
  - **PCC `contextSize` is throwing + isolation-bound** (`try await model.contextSize`) — *unlike*
    `SystemLanguageModel.contextSize`, which is a plain sync `Int`. Don't assume they're the same accessor.
  - **PCC availability enum** is `deviceNotEligible | systemNotReady` (not the SystemLanguageModel set);
    `model.isAvailable: Bool` is the quick check; `model.quotaUsage` exists for limits.
  - **Entitlement string is NOT embedded in the SDK/framework** — it's a portal capability granted on
    PCC enrollment. Capture the exact key from Certificates & Identifiers when the application is
    approved (Phase C.1), not from a header.
- **Verification status:** TS app code clean (`tsc` — only pre-existing `vitest` test-file noise);
  `npm run test:unit` not runnable locally (`vitest` not installed) but no tested pure logic changed.
  **Pending:** on-device runtime of S2/S3/S4 on the iPhone 17 Pro; S5 runtime stays gated on entitlement.

### Phase A — Pipeline + prompt overhaul (iOS 26 SDK, buildable now)

Everything here compiles on the current Xcode 26.5 and is mostly TypeScript + a modest Swift change.

- **A.1 — Persistent session & transcript (Swift).** Hold one `LanguageModelSession` per group
  (keyed, lazily created, `prewarm()`ed) instead of `let session = LanguageModelSession {…}` per call.
  Expose `resetSession(groupId)` for "clear chat". This alone restores multi-turn continuity.
  *(askOnDevice / planExpenseQuery in [SplitCircleAIModule.swift](../../modules/splitcircle-ai/ios/SplitCircleAIModule.swift))*
- **A.2 — Richer instructions (system prompt).** Replace the one-liner with a structured persona +
  rules block: who it is, the fixed category list, "abstain on non-money / greetings", "copy member
  names exactly", "never compute numbers — return a plan", current date for relative timeframes,
  and 2–3 few-shot plan examples. Pass current date in (the model has no clock).
- **A.3 — `RouterDecision` @Generable + abstain.** Fold `planExpenseQuery`'s plan into a single
  router struct with `intent`, `confidence`, `abstain`, `chitchatReply`. JS routes on
  `abstain`/`confidence` thresholds; low confidence → ask a clarifying question, not a guess.
- **A.4 — Timeframe coverage (deterministic).** Extend `parseTimeframe` + the plan timeframe to
  handle **explicit month names** ("April", "April 2025"), **quarters/years**, and **relative shifts**
  ("the month before that", "earlier than that") computed against the *previous* turn's timeframe.
  Add unit tests mirroring the exact failing screenshots (`Aprils total?`, `month before that`).
- **A.5 — Conversational memory on the Q&A path.** Carry a `lastQuery { intent, scope, category,
  timeframe }` in `ConversationState` so `answerQuestion` can resolve "what about April?" /
  "the month before that" / "and for food?" by diffing against the last query instead of returning
  `state: {}`. ([assistantService.ts:395](../../src/services/assistantService.ts))
- **A.6 — Meta-command vocabulary.** Recognize chat-control intents ("clear the chat", "start over",
  "what can you do") in the deterministic layer **before** the model, so they never leak into spend.
- **A.7 — Persistence fix.** Stop wiping `pending`/`lastProposed` on restore; instead **retire only
  stale confirm cards older than N minutes**, preserving an in-progress slot-filling draft across
  reloads. ([AiChatScreen.tsx:132](../../src/screens/ai/AiChatScreen.tsx))
- **A.8 — Eval harness.** Build a fixed suite of ~40 real prompts (the screenshots + variations) with
  expected route/answer, runnable as unit tests now; adopt Apple's **Evaluations framework** once on
  Xcode 27. Gate merges on it so the router can't silently regress.

**Exit criteria:** every screenshot symptom #1–#6 passes the eval suite; `npm run test:unit` + `tsc`
clean; device-verified on an iPhone 15 Pro+ and on the **iOS 27.0 simulator**.

### Phase B — iOS 27 SDK adoption (compiles now in Xcode-beta; EAS image is the gate)

- **B.1** Bump the EAS image pin off `xcode-26.4` once an Xcode 27 image is available (or build
  `--local`/archive from Xcode-beta in the meantime). Point local `xcode-select`/`DEVELOPER_DIR` at
  Xcode-beta.
- **B.2** Raise the on-device grounding budget to the **8192-token** window on iOS 27 devices
  (`maxExpensesForContext` already adapts to `contextSize`). Gate `if #available(iOS 27.0, *)`.
- **B.3** **Image input** for receipts via `.image()` — feed the photo directly for crumpled receipts
  (retires doc 12 Phase 4's first item). Gate `if #available(iOS 27.0, *)`.

### Phase C — Private Cloud Compute escalation (compiles now; needs enrollment + EAS image)

- **C.1** Apply for PCC enrollment on the developer site; confirm SplitCircle is **< 2M downloads**
  (it is) and capture the exact entitlement string from the Xcode 27 SDK (it's now in Xcode-beta —
  read the header to confirm the string rather than trusting doc 16 §8).
- **C.2** Add a gated `PrivateCloudComputeLanguageModel` backend behind `if #available(iOS 27)` +
  `model.isAvailable`. **Escalate only** when: on-device `tokenCount` exceeds the window, or the
  router returns low confidence on a genuinely complex multi-step request. Stay on-device otherwise
  (offline, no quota).
- **C.3** Respect `quotaUsage` (warn near limit, surface `limitIncreaseSuggestion`); show a clear
  **"Answered in Private Cloud Compute"** badge for transparency. Numbers *still* come from the
  deterministic engine — PCC only helps *understand* and *phrase*.

---

## 6. Sequencing & risk

- **Order:** A.1 → A.3 → A.2 (session+struct+prompt land together) → A.4/A.5 (timeframe+memory) →
  A.6/A.7 (meta+persistence) → A.8 (evals). Then B, then C.
- **Biggest bang for buck:** A.1 (persistent session) + A.3 (abstain) + A.4 (month timeframes) fix
  the majority of the visible failures and are small, low-risk changes.
- **Constraints unchanged from doc 16 §9:** bare iOS workflow (no `expo prebuild`, `pod install` only),
  relative imports in unit-tested pure files, no `runTransaction` on the add/settle path, **no paid
  external AI APIs**, Swift/UI must be device-verified.
- **Open question for the owner:** pursue PCC enrollment now (lead time) or defer until after Phase A
  ships and is verified? Recommendation: **ship Phase A first**; start the PCC application in parallel
  since enrollment has lead time.
