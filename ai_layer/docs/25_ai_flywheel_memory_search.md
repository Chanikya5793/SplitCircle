# 25 — AI Quality Flywheel, Memory & the Search Surface

Decisions user-locked 2026-07-19 (8 structured answers, second interview round —
"almost great, do better"). Builds ON TOP of the shipped doc-24 pipeline; don't
re-litigate either doc. Build order: **Q1 flywheel → Q2 memory → Q3 search**,
then the parked directions (receipt superpowers; doc-21 money-in-chat, which
also unlocks the deferred `send_nudge` action).

## Decisions (locked)

| Question | Decision |
|---|---|
| Next build | **Quality flywheel first** — turn daily use into the eval suite; closes the doc-24 P6 tail. |
| Feedback UI | **Full capture**: 👍/👎 on assistant bubbles in BOTH chats. 👎 snapshots the whole turn (user text, router decision, tool requests+results, narration, engine, facts hash) locally — never uploaded — plus optional reason chips ("wrong number", "didn't answer", "too shallow"). |
| Eval policy | **Auto-fixture + pre-ship run**: every 👎 instantly becomes a replayable fixture. A dev-only eval screen (Settings → AI) replays the suite against the real on-device model. `ship:ios` warns and asks confirmation when the last run had reds. **The P6 tail (ai_pipeline_v1 flag + legacy fallbacks) drops once the suite passes clean on the physical iPhone.** |
| Replay semantics | Data drifts, so fixtures assert INVARIANTS, not number equality: routing (intent, clarify-or-not, tools chosen, local-pin honored) + narration gates (grounded, non-repeating, non-empty). |
| Memory scope | **All four tiers**: entity fixes (a clarify resolution repeated ~2× stops asking), stated facts & nicknames ("we call Costco runs 'the big shop'"), preferences ("keep answers short"), observed patterns (most-asked topics/ranges, with provenance). |
| Memory & PCC | **USER CHOICE — all memory may ride PCC prompts** (Apple-attested, stateless). The doc-24 P5 pin is UNCHANGED: raw chat/call data still never leaves the device; this decision covers only the distilled memory items. |
| Memory UX | **Full ledger** in Settings: every item verbatim, per-item delete, per-category toggles, master wipe. Patterns show why ("asked about Food 6×"). Storage is Local-tier AsyncStorage — NEVER Firestore. |
| Memory writes | Explicit "remember that …" applies immediately with an in-chat confirmation line (undo = ledger). Entity fixes learn silently from repeated clarify picks. Patterns are computed counters, never model-written. |
| Search surface | **Third AI surface**: on SUBMIT of a question-shaped query (`looksLikeQuestion`) in the native search tab → streamed answer card above results. Personal cross-group scope by default; a named group resolves via `entity_lookup` into group scope. The doc-20 native-tab contract is untouched — this only adds a result row. No as-you-type model calls. |
| Latency polish | `prewarm()` on chat open + search activate (doc-17 noted it unused; still true). Per-turn answer cache keyed `hash(facts) + normalized(question)` per scope. |

## Architecture

```
👎 tap ─▶ aiFeedbackService.capture(turnSnapshot)     [AsyncStorage ring, cap 100]
              └─▶ fixture (auto)  ─▶ Eval screen: replay via runAgenticTurn
                                        └─▶ pass/fail per invariant → status marker
                                              └─▶ ship-ios.sh warns on reds
aiMemoryService (per scope: group / personal / global)
  ├─ items: {id, kind: entityFix|fact|preference|pattern, text, provenance, createdAt}
  ├─ injection: compact MEMORY block (~≤300 tokens) into router+narrator instructions
  ├─ learning: pipeline reports clarify resolutions → entityFix after 2 consistent picks
  └─ ledger UI: Settings → AI → Memory (per-item delete, toggles, wipe)
SearchScreen submit ─▶ looksLikeQuestion ─▶ runAgenticTurn(personal ctx | resolved group)
                                             └─▶ streamed AnswerCard row → tap opens insights chat seeded
```

- New: `src/utils/aiFeedback.ts` + `aiMemory.ts` (pure, vitest-covered),
  `src/services/aiFeedbackService.ts` + `aiMemoryService.ts` (AsyncStorage),
  eval screen + memory ledger screens (dev/Settings), AnswerCard in search.
- `runAgenticTurn` gains: memory injection, clarify-resolution reporting, and a
  replay mode (fixture in → invariant verdicts out, no persistence).
- "remember …" becomes an assistant intent (`memory_add`) in `classifyMessage` —
  BEFORE the question path, guarded like `set_budget`.
- Prewarm: a tiny native `prewarmOnDevice()` (constructs + prewarms one session
  through `serializeFm`) called on chat-open/search-activate; drop if it fights
  the FM serialization law in practice.

## Gotchas carried forward

- Every model call still rides `serializeFm`; the search card must tolerate the
  queue being busy (show the pending state, never double-fire on submit).
- Doc-20 search contract: committed-query semantics, unlabeled search tab, and
  the RNS patch are sacred — the answer card is a RESULT ROW, nothing more.
- Memory is Local-tier storage but its items may ride PCC prompts (explicit
  user decision above). The chat/call TOOL pin from doc-24 P5 is unaffected.
- 👎 snapshots contain prompts (which may embed chat snippets) — they stay
  local-only and are excluded from any future export/share surface.

## Status

- **Q1 BUILT 2026-07-19** (quality flywheel):
  - `src/utils/aiFeedback.ts` — TurnTrace/fixture types, the replay invariants
    (reply-produced, numbers-grounded, no-canned-fallback, clarify-shape,
    local-pin), cache keys. `runAgenticTurn` builds + returns a full trace on
    every reply and answers exact-repeat questions from a per-turn cache
    (facts-hash keyed; local-tier turns and clarifies never cached; replay
    bypasses).
  - `src/services/aiFeedbackService.ts` — trace ring (20) keyed by reply
    message id, 👎 → fixture (AsyncStorage, cap 100; REDUCED capture when the
    ring is gone post-relaunch), sentiments, eval status marker,
    `replayFixture` (original facts + thread tail through the live pipeline →
    invariant verdicts).
  - Thumbs UI in BOTH chats: 👍/👎 under assistant bubbles → reason chips
    (wrong number / didn't answer / too shallow / other) → "Noted — added to
    AI evals".
  - `AiEvalsScreen` (Settings → On-Device AI → AI evals): fixture list,
    Run-all with progress, THEN/NOW reply diff, per-invariant verdicts,
    summary status. Reds banner reminds that the doc-24 P6 tail stays until
    clean.
  - `prewarmOnDevice()` native + wrapper, fired on assistant open + overlay
    open (weights warm before the first turn).
  - `ship-ios.sh` preflight: vitest unit+services are a HARD gate; on-device
    eval confirmation prompts on a TTY, warns headless (device state is
    unreachable from the Mac — the doc's "warn on reds" lands as this prompt;
    `SKIP_AI_EVAL_CHECK=1` skips the prompt, never the tests).
  - Tests: +9 pure (invariants/cache keys) +7 service (capture/replay/skip)
    +4 orchestrator (trace shape, cache hit/bypass, clarify-not-cached);
    `tsc` clean. Native `prewarmOnDevice` rides the next ship (wrapper no-ops
    until then; everything else is hot-swappable JS).
- **Q1 SHIPPED 2026-07-19**: `SplitCircle-production-20260719-213646.ipa` →
  TestFlight (flywheel + native prewarm).
- **Q2 BUILT 2026-07-19** (AI memory):
  - `src/utils/aiMemory.ts` (pure) + `src/services/aiMemoryService.ts`
    (AsyncStorage; scopes global / group:<id> / personal; global toggles).
  - Injection: MEMORY block (≤300 tokens, preference→fix→fact order + one
    pattern hint line) appended to router AND narrator instructions — incl.
    PCC (the locked user decision). Entity fixes ride `ToolCtx.entityFixes`
    and rewrite member args in `executeToolRequests` — a fixed alias resolves
    deterministically, no re-clarify.
  - Learning: clarify answers record picks (alias extracted from the causing
    message vs the offered options); two consistent picks promote a fix.
    Runs BEFORE the answer cache and is awaited — a cached repeat still
    teaches. Patterns: topic/period counters (cap 30, min 3 to surface),
    toggle-respected, never model-written.
  - "remember that …" = `memory_add` intent (amount-guarded so "remember I
    paid Sam 20" stays a settlement); applies immediately, stored GLOBAL,
    works in both chats (insights delegates via WRITE_INTENTS).
  - `AiMemoryScreen` ledger (Settings → On-Device AI → AI memory): four
    sections with per-kind switches, every item verbatim + provenance +
    scope, per-item delete, patterns deletable, "Forget everything".
  - All JS — hot-swappable onto the Q1 binary. Tests: +12 pure +9 service
    +3 pipeline-integration (injection in both instruction sets, two-pick
    promotion through the live pipeline, empty-memory adds nothing);
    `tsc` clean.
- **Q2 SHIPPED 2026-07-19**: `SplitCircle-production-20260719-223748.ipa` →
  TestFlight (memory jsbundle).
- **Q3 BUILT 2026-07-19** (search answer card — closes this doc):
  - Submit-only (native `submit` event + fallback field `onSubmitEditing`);
    `looksLikeQuestion` gates; a sequence counter supersedes stale runs.
  - Scope: query naming a group → that group (compact `buildFactsBlock`
    facts); otherwise personal cross-group (`buildPersonalStats` JSON +
    `personalGroups` for the agentic personal tools).
  - The card streams status → narration inline, shows the engine badge, and
    taps through to the assistant pre-filled (`ROUTES.APP.ASK_AI`). Clarify
    or pipeline-null degrades to the deep-link row (no chip UI in search —
    deliberate). Cancel/deactivate clears the answer with the query; the
    doc-20 native-tab contract is untouched (result row only). Prewarm fires
    on search `activate`.
  - UI-only glue over the tested pipeline — no new unit surface; `tsc` clean,
    all suites green. Hot-swappable JS (next ship carries it).
- **Q3 SHIPPED 2026-07-19**: `SplitCircle-production-20260719-230450.ipa` →
  TestFlight (search answer card + the streaming scroll fix: unconditional
  `onContentSizeChange`→`scrollToEnd` compounded offsets on every streamed
  token — now near-bottom-gated in both AI chats; gotcha added to CLAUDE.md).
- **DOC 25 COMPLETE AND FULLY SHIPPED.** Remaining ideas live in the parked
  list: receipt superpowers, doc-21 money-in-chat (send_nudge), and the doc-24
  P6 tail (drop flag+fallbacks after the on-device eval suite passes clean).
