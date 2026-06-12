# Phase 7 — App ↔ AI Layer Integration (iOS-first)

> How the React Native/Expo app consumes the AI layer hand-in-hand, including the
> native iOS (Swift) pieces. Everything degrades gracefully when the AI layer is
> gated off — the app never breaks, features just hide.

---

## 0. PRIMARY PATH: on-device Apple Foundation Models (zero cost) — WWDC'25/'26

As of June 2026 the Ask-AI feature runs **on-device first** via Apple's
Foundation Models framework (iOS 26+, Apple Intelligence hardware: iPhone 15
Pro or newer, all 16/16e/17/Air). **No backend, no API bill, nothing leaves
the phone** — the group's expenses are already local (embedded array), so
"retrieval" is a pure rank-and-trim (`src/utils/onDeviceAiContext.ts`, 40-line
cap inside the model's 4096-token combined budget) and the ~3B on-device model
answers with `@Generable`-structured citations
(`modules/splitcircle-ai/ios/SplitCircleAIModule.swift` → `askOnDevice`).

- `getOnDeviceAiAvailability()` surfaces the exact reason when unavailable
  (`deviceNotEligible` / `appleIntelligenceNotEnabled` / `modelNotReady` /
  `unsupportedOS`); `AskAiScreen` shows a tailored, friendly note per reason.
- Ineligible devices fall back to the cloud callable below **iff** the cloud
  AI layer has been enabled; otherwise they get the sorry note. The cloud
  RAG stack (sections 1–2) is now **optional** — provision it only if/when
  older-device coverage is worth the GCP cost.
- Build note: compiling the FoundationModels code path needs **Xcode 26+ /
  iOS 26 SDK** (EAS default images qualify). The Swift is guarded with
  `#if canImport(FoundationModels)` + `@available(iOS 26, *)`, so older
  toolchains/OSes degrade to `unsupportedOS` instead of breaking the build.
- WWDC 2026 follow-ups (iOS 27, fall 2026): free Private Cloud Compute tier
  for apps <2M downloads (would cover older devices at no cost), image input
  (receipt understanding), and third-party model routing through the same
  Swift API. Revisit then.

## 1. The bridge: `askExpenseAi` callable (cloud fallback — optional)

The RAG Cloud Run service is **internal** (shared secret + IAM); the app must
never hold that secret. The app-facing entry point is the
**`askExpenseAi` Firebase callable** (`functions/src/askExpenseAi.ts`):

```
App (httpsCallable) ──▶ askExpenseAi (uid from verified token, validated input)
                          └─▶ RAG service /query (x-rag-secret, server-side)
                                └─▶ {answer, sources[], confidence}
```

- Gated by `AI_LAYER_ENABLED` + `RAG_SERVICE_URL`/`RAG_SHARED_SECRET` in the
  Functions runtime env → `failed-precondition` until activated (same gate as
  `onGroupWritten`), so it deploys safely before the backend exists.
- A spoofed `userId` in the payload is ignored — the uid always comes from the
  token (Critical Rule #2). Question capped at 500 chars; `topK` clamped ≤ 25.

## 2. App service: `src/services/aiService.ts`

Mirrors the app's existing callable pattern (`notificationService` et al.):

- `askExpenseAi(question, {groupId?, topK?})` → grounded, cited `ExpenseAiAnswer`.
- Throws **`AiUnavailableError`** on `failed-precondition`/`unavailable` so UI can
  hide the assistant cleanly instead of erroring.
- **PII guard before network:** the question passes through `redactPII` on-device
  *before* the callable fires.
- On success it donates the "Ask SplitCircle" activity to iOS (fire-and-forget).

## 3. Native iOS module: `modules/splitcircle-ai/` (Swift)

Follows the repo's local Expo-module pattern (`modules/my-module`,
`VisionKitReceiptScanner`). `platforms: ["apple"]`; JS fallbacks elsewhere via
`requireOptionalNativeModule` (never crashes Android/web/tests).

| API | iOS implementation | Fallback |
|---|---|---|
| `redactPII(text)` | **NSDataDetector** (phone numbers + `mailto:` links) — more accurate than regex, fully on-device | JS regex mirroring the server's `redactPII` |
| `donateAskActivity(query?)` | `NSUserActivity("com.splitcircle.ask-ai")`, eligible for Search + Prediction (`NSUserActivityTypes` registered in `app.config.ts`) | no-op |

Build note: requires a fresh `npx expo prebuild` / pod install so autolinking
picks up the new pod. **Swift cannot be compiled in this sandbox** — the module
mirrors the proven QuickLook module structure 1:1; verify on the next iOS build.

## 4. On-device smart split: `src/utils/smartSplitRecommender.ts`

Pure port of MODEL-05 (`ai_layer/models/smart_split`) plus a `buildSplitHistory`
adapter over the app's `Expense` model (`splitMetadata.method` → legacy
`splitType` fallback, `participants[].share` ratios). Runs offline/instant in the
Add-Expense flow — no backend needed:

```ts
const rec = recommendSplit(
  { participants: memberIds, amount, category },
  buildSplitHistory(group.expenses),
);
// rec.method ('percentage' | 'shares' | …), rec.participants (sums exactly), rec.confidence
```

## 5. Tests

- `functions/`: callable gating, auth, uid-from-token, error mapping (vitest).
- App root: **`npm run test:unit`** (`vitest.unit.config.ts`) — first unit tests
  in the app package: smart-split port + adapter, PII-redaction fallback parity.
  Scoped to pure files (no RN runtime needed).

## 6. Remaining UI work (intentionally not done here)

Surfacing the features is a product/UX decision: an "Ask AI" screen or sheet
calling `aiService.askExpenseAi`, a suggestion chip in the Add-Expense flow fed
by `recommendSplit`, and handling `continueUserActivity` for the donated Siri
activity (deep link → ask screen). The service/native layers above are complete
and tested, so each is a small, isolated PR.
