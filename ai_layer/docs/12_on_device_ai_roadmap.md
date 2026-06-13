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

### Phase 2 — Rich receipt insights + "More info"
- Extend the FM `@Generable` schema to extract merchant address, payment method,
  savings/discounts, tax breakdown, per-item categories, return/warranty window,
  loyalty info, etc. Store a `receiptInsights` blob on the expense.
- Surface a summary + a **"More info" expander on the Expense Details page**.

### Phase 3 — More on-device AI
- On-device auto-categorization (replace keyword `inferCategoryFromText`).
- **Natural-language expense entry** ("$40 dinner with Alice & Bob, split equally")
  → structured expense via `@Generable`.
- "Month in review" / group insights; anomaly flags; chat smart-replies.
- Optionally upgrade Suggested split with an FM rationale.

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
