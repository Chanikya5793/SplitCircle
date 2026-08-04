# Claude Usage Report — SplitCircle

**Window:** last 30 days (2026-07-12 → 2026-08-02) · **Generated:** 2026-08-02

## Executive summary

| KPI | Value |
|---|---|
| Sessions | **30** |
| Prompts (turns) | **4,100** |
| Distinct tasks | **25** (auto-titled) |
| Projects | **1** — `SplitCircle` |
| Surfaces covered | Claude Code CLI only (see *Coverage*) |
| Measured active time | **85.8 h** |
| Wall-clock time spanned | 627.0 h |
| Files touched | **615** |
| Token volume | **12.38 B** |
| **Estimated hours saved** | **171.6 h** *(estimate — see Method)* |

Roughly 86 hours of hands-on engineering time across 30 sessions produced work on
615 distinct files, concentrated almost entirely on one product: the SplitCircle /
ManaSplit iOS app. The dominant themes were multi-device message sync reliability,
on-device AI + Siri integration, and large-diff review/remediation work.

## What we use Claude for

| Theme | Sessions | What it covers |
|---|---:|---|
| Multi-device sync & messaging reliability | 6 | iCloud/linked-device chat sync, nearby-mesh and cloud-relay offline delivery, cross-device message repair |
| Feature development | 4 | Currency conversion for groups, recurring bills, Photos-style search UI, this usage-report tooling |
| Tooling, ops & environment | 4 | Remote control, cross-account session access, orphaned Cloud Function removal, a security/OSINT exercise |
| On-device AI & Siri / App Intents | 4 | App Intents planning + implementation, on-device AI pipeline, stats-narrative reliability |
| Debugging & fixes | 4 | Chat reaction removal/sync, flaky `parseTimeframe` test, iOS Simulator attach, keyboard overlap |
| Code review & audits | 3 | Two 50k-line branch diffs with test authoring, chat-section anomaly cross-check |
| Remediation-plan execution | 2 | Working ticket queues (TCKT-6 onward) from a prior audit |
| Refactoring & UI polish | 2 | Shake-to-hide menu redesign, stats layout/density cleanup |

*(Two sessions carried no auto-generated title and are excluded from the theme counts.)*

## Time saved

- **Measured active time: 85.8 h.** Active time counts only gaps of ≤ 5 minutes
  between events, so idle/away stretches are excluded (wall-clock across the same
  sessions was 627 h — 86 h is the conservative figure).
- **Estimated saved: 85.8 h × (3 − 1) = 171.6 h.**
- The 3× multiplier is an **assumption**, not a measurement: it asserts the same
  output would have taken three times as long unaided. Savings are reported in
  **hours only** — no monetary value is computed anywhere in this report.

## Activity

### Token volume (measured)

| Type | Tokens | Share |
|---|---:|---:|
| Cache read | 12,119,262,725 | 97.9% |
| Cache write | 231,525,658 | 1.9% |
| Output | 28,094,205 | 0.2% |
| Input | 545,117 | 0.004% |
| **Total** | **12,379,427,705** | |

Cache reads are ~98% of volume — nearly all context was served from cache rather
than re-sent, which is the expected shape for long sessions on a large codebase.

### Top tools (16,637 calls total)

| Tool | Calls |
|---|---:|
| Bash | 7,580 |
| Edit | 2,973 |
| Read | 1,803 |
| computer-use · screenshot | 546 |
| TaskUpdate | 485 |
| computer-use · computer_batch | 478 |
| computer-use · left_click | 446 |
| Write | 411 |
| *Other (49 tools)* | 1,915 |

The long tail includes iOS Simulator control/build (66), browser automation (~300),
web search/fetch (74), and subagent/workflow orchestration (54).

### Model mix (assistant turns)

`claude-sonnet-5` 12,018 · `claude-opus-5` 10,321 · `claude-fable-5` 5,116 ·
`claude-opus-4-8` 2,732 · `claude-haiku-4-5` 25 · `claude-sonnet-4-6` 26.

### Per-project rollup

| Project | Sessions | Prompts | Active h | Saved h (est.) |
|---|---:|---:|---:|---:|
| SplitCircle | 30 | 4,100 | 85.8 | 171.6 |

### Per-surface rollup

| Surface | Sessions | Active h | Saved h (est.) |
|---|---:|---:|---:|
| Claude Code CLI | 30 | 85.8 | 171.6 |

## Coverage

- **Found:** `~/.claude/projects` (Claude Code CLI).
- **Not present on this machine:** Claude Desktop Code-tab sessions
  (`…/Claude-3p/claude-code-sessions`) and Claude Cowork sessions
  (`…/Claude-3p/local-agent-mode-sessions`) — neither directory exists, so no
  Desktop-Code or Cowork usage is reflected here.
- **Never available:** Claude Desktop **Chat tab** conversations are stored
  server-side only. There is no local transcript and no personal export API, so
  they can never appear in this report.

## Assumptions & method

Reproduced verbatim from the parser:

```json
{
  "window_days": 30,
  "time_multiplier": 3.0,
  "hours_saved_formula": "active_hours * (multiplier - 1)",
  "active_gap_threshold_sec": 300,
  "savings_reported_as": "HOURS ONLY — no monetary value anywhere in this report",
  "cost_note": "monetary cost is intentionally NOT computed or reported",
  "cowork_note": "Cowork numbers are best-effort (undocumented schema)",
  "desktop_chat_note": "Desktop Chat-tab conversations are server-side only and are NOT included"
}
```

- **Measured facts:** sessions, prompts, tokens by type, wall/active time, tool
  counts, files touched, model mix. Subagent transcripts are folded into their
  parent session for tokens/tools/files (not time, which would double-count).
- **Estimate:** hours saved only.
- Sessions are windowed by start time; a session that began before 2026-07-12 is
  excluded even if it continued into the window.
