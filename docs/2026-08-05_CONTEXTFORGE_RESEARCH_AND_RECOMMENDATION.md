# ContextForge research and recommendation for ManaSplit

- **Date:** 2026-08-05
- **External project:** [IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge)
- **ContextForge snapshot reviewed:**
  [`7c042d2147d90fa4bcc72c0cf7d6032a6bf0d7bc`](https://github.com/IBM/mcp-context-forge/commit/7c042d2147d90fa4bcc72c0cf7d6032a6bf0d7bc),
  committed 2026-08-04
- **ManaSplit branch reviewed:** `ui-revamp`

## Executive decision

Do **not** embed ContextForge in the React Native app, add it to Firebase Functions,
or deploy it for ManaSplit's current AI stack.

Do adopt a focused subset of its design ideas inside ManaSplit:

1. a declarative contract for every AI tool;
2. one fixed pre/post invocation policy boundary;
3. per-surface capability packs over the existing single tool registry;
4. local, privacy-safe execution traces with real deadlines and cancellation;
5. user-facing AI access/activity disclosure.

This is not a recommendation to adopt MCP. ManaSplit already has the valuable part:
an in-process agentic tool loop over deterministic TypeScript functions. ContextForge's
best contribution is a vocabulary and set of proven patterns for governing that loop.
The proposed work should remain JS-only, local-first, and compatible with the existing
Apple on-device/Foundation Models + Private Cloud Compute (PCC) architecture.

ContextForge becomes a plausible infrastructure option only if ManaSplit later operates
several external, server-side connectors requiring centralized OAuth delegation,
protocol translation, quotas, and auditing. Even then it must never receive Local-tier
messages, call history, media, nearby-mesh payloads, encryption material, or local AI
memory.

## Scope and method

This review used primary sources only:

- a shallow clone of the current ContextForge `main` branch at the commit above;
- its runtime code, configuration, tests, release history, security policy, architecture
  decisions, plugin implementation/docs, cancellation path, observability design, and
  deployment guides;
- the GitHub repository API for current project metadata;
- ManaSplit's binding architecture/AI documents and the live TypeScript implementation.

The review did **not** deploy or benchmark ContextForge. Throughput claims in its docs
are therefore treated as project claims, not independently verified results. Repository
counts below are simple snapshot counts, not quality scores.

## What ContextForge actually is

ContextForge is a centralized control and data plane in front of MCP servers, A2A
agents, and REST/gRPC APIs. It can register and discover upstream systems, translate
protocols, compose subsets into virtual MCP servers, authenticate callers, govern tool
access, run pre/post plugins, impose timeouts and quotas, and emit operational traces.
See its [overview](https://github.com/IBM/mcp-context-forge/blob/main/README.md) and
[architecture](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/index.md).

It is not an AI model and does not inherently improve routing, reasoning, or answer
quality. It improves how independently hosted capabilities are exposed and governed.
ManaSplit would still need its deterministic analytics, router, grounding checks, model
integration, and UI even if ContextForge sat in front of future remote services.

Its current core is a Python 3.11-3.13 FastAPI/SQLAlchemy application. A minimal local
instance can use SQLite; production examples add a container, PostgreSQL, Redis,
reverse proxy/TLS, secrets, migrations, monitoring, and an operational upgrade process.
It is not an embeddable TypeScript library and is not designed for a mobile runtime.
The current package metadata is version 1.0.6, classified as Beta, and licensed under
Apache-2.0. See
[`pyproject.toml`](https://github.com/IBM/mcp-context-forge/blob/main/pyproject.toml).

The reviewed snapshot contained approximately:

- 382 Python files under `mcpgateway/`;
- 714 Python test files and about 6,894 `test_` functions;
- a 7,815-line `tool_service.py` and a 3,945-line `config.py`;
- more than 40 bundled/example plugin directories.

This is a substantial platform, not a small gateway helper.

## Maturity and operational posture

There are strong positive signals:

- 1.0.0 was declared generally available on 2026-05-01; 1.0.6 shipped on
  2026-07-21. The release cadence is active. See the
  [release history](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/releases.md).
- At review time, GitHub reported roughly 4,243 stars and 798 forks, with a push on
  2026-08-04. The project is visibly active. GitHub's `open_issues_count` was 1,195,
  but that API number includes pull requests and must not be interpreted as 1,195 bugs.
  See the [repository API](https://api.github.com/repos/IBM/mcp-context-forge).
- The project has extensive unit, integration, protocol, UI, security, fuzzing, and
  supply-chain automation.
- Authentication, header filtering, SSRF controls, secret encryption, RBAC, output
  bounds, and telemetry redaction receive serious attention.

There are equally important adoption cautions:

1. The project is moving faster than parts of its documentation. For example, the current
   security feature document says bulk import, catalog, and A2A default to safe/off
   values, while the reviewed `config.py` defaults all three to `true`. The Admin UI and
   Admin API do default off. A production deployment must verify code defaults for its
   exact version and explicitly set every unused surface off rather than trusting prose.
2. The package still declares Beta even though the release document calls 1.0.0 GA.
   `SECURITY.md` says to expect minor-version breaking changes, use the latest release,
   and notes there are no backported security fixes or LTS branches. See the
   [security policy](https://github.com/IBM/mcp-context-forge/blob/main/SECURITY.md).
3. Some architecture documents contain historical and target-state material together.
   The Rust runtime is described as both a precedent and deprecated; the roadmap is
   already targeting later MCP protocol generations. Operators must separate shipped,
   deprecated, experimental, and planned paths.
4. ContextForge's own tool-validation document records current differences between
   MCP, REST, and A2A validation paths. A2A lacks one post-invoke validation layer, and
   a successful REST response with a declared schema but no structured payload remains
   lenient in one layer. See
   [Tool Invocation & Output-Schema Validation](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/tool-invocation-and-validation.md).
5. The plugin framework is broad, but not every advertised direction is complete.
   Dependency resolution is planned, the bundled schema guard supports only a JSON
   Schema subset, and the cached-result plugin cannot currently short-circuit execution.

The conclusion is not that ContextForge is poor quality. It is that adopting it creates
a meaningful, fast-moving platform ownership obligation. ManaSplit does not currently
have a problem large enough to justify that obligation.

## Architectural fit

| Dimension | ContextForge | ManaSplit | Implication |
|---|---|---|---|
| Primary job | Federate remote tools, agents, and APIs | Consumer expense/chat/call app | Different product boundary |
| Runtime | Python service, database-backed | Expo/RN client + Node Firebase Functions | Cannot embed; separate service required |
| Tool location | Mostly remote/federated | Deterministic TypeScript functions using current app state | Network gateway adds no value to current calls |
| Data posture | Central governance and telemetry | Local-first; messages/calls permanently local | A remote gateway can weaken a binding privacy boundary |
| Model path | Many external clients/providers | Apple on-device FM + PCC with exact TS calculations | MCP is not required for the existing model loop |
| Writes | General tool invocations under policy | Typed proposals, canonical app writes, explicit confirmation | ManaSplit's narrower design is safer for money mutations |
| Auth | Gateway JWT/SSO/OIDC/proxy model | Firebase Auth and Firestore/RTDB rules | Integration is non-trivial, not drop-in |
| Operations | Container, migration, SQL, optional Redis/cluster | Firebase-managed backend plus LiveKit | Adds another security, cost, and on-call surface |

### Feature-by-feature disposition

| ContextForge capability | ManaSplit decision | Rationale |
|---|---|---|
| MCP/A2A/REST/gRPC federation | Skip now | No current collection of remote agent/tool services |
| REST/OpenAPI-to-tool adaptation | Revisit for external connectors | Useful only after several governed server APIs exist |
| Virtual servers/tool bundles | Adopt the pattern | Becomes local surface-specific capability packs |
| Input/output schemas | Adopt | Strongest safety and regression-prevention improvement |
| Pre/post invocation hooks | Adopt a fixed subset | Central policy order is useful; runtime plugins are not |
| Plugin marketplace/external plugins | Reject | Unreviewed code and mutable capability reach conflict with app privacy |
| RBAC/teams/multitenancy | Do not copy | Firebase rules and group membership already own product authorization |
| OAuth vault/token exchange | Conditional future value | Valuable for multiple external user-authorized services, unnecessary now |
| Tool timeouts/cancellation | Adopt | Makes the existing wall budget enforceable |
| Tool rate/concurrency limits | Defer | Existing hop/request caps and FM serialization are sufficient for local tools |
| Retries/circuit breakers | External reads only, later | Current calculations are local; mutations must not be generically retried |
| Generic tool-result cache | Do not copy now | ManaSplit already has analytics/index and exact-answer caches with domain invalidation |
| OpenTelemetry/distributed traces | Adopt only the trace shape | Remote payload telemetry conflicts with Local-tier privacy |
| Prompt/resource registries | Skip | App-reviewed code is the safer authority for prompts and access policy |
| Admin UI/catalog/import-export | Skip | Adds operator surfaces without a present operational need |
| MCP Apps | Skip | ManaSplit already owns richer native UI and confirmation cards |
| TOON/result compression | Benchmark only if needed | Current tool JSON is compact and row-capped; correctness is more valuable than a new encoding |
| Health checks/service discovery | Revisit for connectors | No remote tool fleet exists today |
| Security/CI practices | Borrow selectively | Secret scanning, dependency review, schema tests, and threat modeling are generally useful |

### Why Firebase authentication is not plug-and-play

ContextForge can trust configured external OIDC access tokens or an authentication proxy,
and it supports sophisticated OAuth/token-exchange flows. Its external API-token path is
documented to accept verified access tokens and reject ID tokens. ManaSplit clients use
Firebase ID tokens. A production integration would therefore need a carefully designed
trusted proxy, custom authentication hook, or token exchange—not merely pointing
ContextForge at Firebase's JWKS. See the
[OAuth design](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/oauth-design.md)
and [proxy-auth guide](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/deployment/proxy-auth.md).

## What ManaSplit already has

ManaSplit's current architecture already implements the core behavior that a generic
gateway would otherwise supply:

- One agentic pipeline for assistant and insights surfaces, with deterministic fast
  paths, structured routing, ask-backs, bounded loop hops, streamed status, grounded
  narration, and typed proposals. See
  [AI pipeline design](../ai_layer/docs/24_agentic_ai_pipeline.md).
- A registry of 21 exact tools spanning ranges, categories, members, merchants,
  balances, settlement plans, budgets, recurring costs, forecasts, anomalies,
  cross-group analysis, entity lookup, chat search, and call statistics. See
  [`aiTools.ts`](../src/utils/aiTools.ts).
- A graph/local data classification. Local chat/call tools are removed from the tool
  catalog when PCC is selected, and executing either pins narration on-device. See
  [`aiPipelineService.ts`](../src/services/aiPipelineService.ts).
- Per-hop and per-turn request caps, request deduplication, caught tool failures, compact
  results, final-number grounding, exact-answer caching, and an app-wide serialized
  Foundation Models queue.
- Typed write proposals with confirmation cards. The model does not directly call
  `GroupContext` mutations.
- Local AI memory with a visible/deletable ledger and local thumbs-down fixtures that
  replay against the real pipeline. See
  [AI flywheel and memory design](../ai_layer/docs/25_ai_flywheel_memory_search.md).
- Engine badges on the insights surface, plus PCC disclosure and a PCC kill switch on
  personal stats.

Replacing this with remote MCP calls would add latency and failure modes while making
the binding Local/Persistent/Transit tier rules harder to prove.

## Gaps exposed by the comparison

The useful question is not "how do we install ContextForge?" It is "which control-plane
properties are missing from our much smaller in-process gateway?"

### 1. Tool contracts are descriptive, not fully enforceable

The current tool definition is effectively:

```ts
{ tier: 'graph' | 'local'; needs: 'group' | 'personal' | 'any'; doc: string; run }
```

`ToolRequest` is one flat structure whose fields are optional for every tool because the
native guided-generation structure cannot express open dictionaries. Individual tool
implementations resolve and validate what they need, but there is no machine-readable
per-tool input contract. Successful tool data is serialized immediately into a JSON
string, so there is no shared output contract or final post-invoke validator.

This is acceptable for 21 internal tools, but it becomes fragile as receipt, Siri,
calendar, connector, or write-related capabilities expand.

### 2. Capability filtering is not surface-aware

`availableTools()` filters by group/personal context, provider presence, and whether
local tools are allowed. It does not take `thread.surface` or a declared surface profile.
The on-device router can therefore receive a broader catalog than a particular surface
needs.

ContextForge's virtual-server composition is relevant here: expose a small coherent
capability bundle to each agent surface while retaining one underlying registry. Its
tool-selection ADR warns when a virtual server grows beyond six tools. That number
should not be copied blindly, but ManaSplit should benchmark smaller menus against the
existing local eval suite. See
[ADR-0012](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/adr/012-dropdown-ui-tool-selection.md).

### 3. There is no single pre/post policy boundary

Privacy filtering happens while building the catalog and while selecting the narration
engine. Dedupe/caps/errors happen inside `executeToolRequests`. Grounding happens after
narration. Write confirmation happens in a separate assistant flow. Each rule is sound,
but the authorization story must be reconstructed across files.

ContextForge's pre/post hook model is the right shape, although its dynamic plugin
framework is excessive for ManaSplit. See its
[security hooks](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/plugins/security-hooks.md).

ManaSplit should use a fixed, typed pipeline whose order cannot be reconfigured at
runtime:

```text
discover for surface
  -> authorize scope + engine + user consent
  -> validate/normalize args
  -> enforce remaining deadline + result budget
  -> execute with cancellation
  -> validate successful output
  -> convert failures to stable error codes
  -> record privacy-safe metadata
  -> serialize the safe result for the model
```

Security/privacy checks should fail closed. Diagnostic recording should fail open.

### 4. The loop budget is not a true tool deadline

The ten-second wall check occurs after awaited tool execution. A slow asynchronous
provider can therefore exceed the loop budget before the code gets a chance to stop.
Most current graph tools are synchronous and fast, so this is primarily a correctness
gap for local providers and future connectors rather than a present performance crisis.

ContextForge assigns request IDs, per-tool timeouts, concurrency limits, and actual task
cancellation. See its
[cancellation API](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/api/cancellation.md).

ManaSplit should propagate an `AbortSignal`/deadline into asynchronous providers and the
native model layer. `Promise.race` alone is insufficient because it abandons a promise
without stopping the underlying work. Retries should remain off for mutations and should
only be considered for future idempotent external reads.

### 5. Existing traces favor eval replay, not operational diagnosis

`TurnTrace` records the facts snapshot, requests/results, selected/actual engine, local
pin, total duration, and thread tail. That is excellent for a thumbs-down replay fixture.
It does not record router/tool/narrator phase timings, per-tool durations, cancellation,
timeout, fallback reason, or tool/prompt contract versions. Live traces are held in an
in-memory ring of 20 and become durable mainly when the user submits negative feedback.

ContextForge's nested trace model—request -> client call -> plugin/tool spans—is useful,
but exporting ManaSplit prompts or tool payloads to OpenTelemetry would conflict with
the local-first product promise. See its
[observability architecture](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/observability-otel.md).

ManaSplit should keep two deliberately different records:

- **Detailed replay fixture:** current opt-in thumbs-down behavior, containing capped
  facts/results/thread and never exported.
- **Metadata activity record:** capped local ring for every turn containing only time,
  surface, engine, human-readable capability labels, privacy classes, duration buckets,
  failure/fallback codes, and contract versions—no question, names, amounts, facts,
  snippets, or results.

### 6. User access disclosure stops at the model badge

The insights overlay does a good job identifying Exact, On-device, or Private Cloud.
It does not explain which capability/data class was used. The Settings area separately
shows the AI index, memory, and eval fixtures, but there is no unified view of what the
assistant is allowed to access.

The ContextForge catalog suggests a consumer feature rather than an admin console:
**AI Access & Activity**.

It should explain in plain language:

- Spending, balances, budgets: available on-device; may use PCC according to the current
  engine policy.
- Chat search: on-device only; user can disable it.
- Call statistics: on-device only; user can disable it.
- AI memory: local ledger with existing category switches and deletion.
- Expense/settlement/budget changes: proposals only; always require confirmation.
- Recent activity: "Used April totals + budget status · On-device," without showing raw
  data in the ledger.

Current behavior should remain the default so this does not silently undo the locked
"everything selected" data-reach decision. New switches add user control; they should
not quietly default existing capabilities off during migration.

### 7. Two disclosure inconsistencies should be fixed before expansion

This review found two issues independent of any future refactor:

1. `AiIndexScreen` says nothing about the user's spending leaves the device for the
   assistant's answers. The index itself is on-device, but the agentic design explicitly
   permits Firestore-tier graph facts/expense lines to use PCC for deep questions, and
   `engine: auto` can select PCC. The copy should describe the index narrowly and link
   to the PCC explanation rather than make an absolute claim.
2. `runAgenticTurn()` returns `source: 'ondevice' | 'pcc'`, and `assistantService` returns
   it as `engineSource`. `AiChatScreen` does not store that value on `ChatMsg` or render
   a model badge. This conflicts with `DESIGN.md`'s mandatory engine-per-message and
   live-engine disclosure. The insights overlay already implements the correct pattern.

These should be treated as a small P0 disclosure repair, not deferred until the larger
capability work.

## Recommended ManaSplit design

### Declarative tool definition

Keep the native guided-generation request flat, but convert it immediately to a typed,
validated internal call:

```ts
type AiDataClass =
  | 'persistent_money'
  | 'local_chat'
  | 'local_calls'
  | 'local_memory';

type AiEffect = 'read' | 'propose_write';
type AiEngine = 'exact' | 'ondevice' | 'pcc';

interface AiToolDefinition<I, O> {
  name: string;
  version: number;
  title: string;
  description: string;
  scopes: readonly ('group' | 'personal')[];
  dataClasses: readonly AiDataClass[];
  effects: readonly AiEffect[];
  engines: readonly AiEngine[];
  input: AiContract<I>;
  output: AiContract<O>;
  timeoutMs: number;
  maxResultBytes: number;
  run(input: I, ctx: AiExecutionContext): Promise<O> | O;
}
```

Do not expose `run`, raw schemas, internal error details, or Firebase objects to the
model. The catalog remains generated from safe descriptions.

### Canonical outcome

ContextForge's documented multi-validator error bug is a useful warning: success and
failure must not be forced through the same output contract.

```ts
type AiToolOutcome<O> =
  | { status: 'ok'; data: O; durationMs: number }
  | {
      status: 'error';
      code: 'invalid_args' | 'forbidden' | 'timeout' | 'cancelled' | 'unavailable' | 'internal';
      retryable: boolean;
      modelMessage: string;
    };
```

Validate `data` only for `status: 'ok'`. Never append raw exception messages to the
model prompt. Preserve a stable safe error so the router can adjust or ask the user.

### Capability packs

Capability packs constrain one brain; they do not create separate pipelines:

| Surface | Initial capability policy |
|---|---|
| Main group assistant | Group money tools; entity lookup; local chat/calls when enabled; typed proposals remain separate and confirmed |
| Group insights | Group analytics tools; budget proposal flow; no chat/call tools unless a future feature explicitly requires them |
| Personal insights | Cross-group aggregate tools only; currencies remain separate |
| Search answer card | Read-only graph/entity tools; no writes; no chat/call provider unless explicitly supplied |
| Siri/App Intents | Small deterministic allowlist; no open-ended mutation without app confirmation |
| Receipt flow | Keep its specialized OCR/FM pipeline separate initially; migrate only if shared policy gives a concrete benefit |

A deterministic prefilter may shortlist tools within a pack, but any limit must be
validated against the existing bad-answer fixture suite and real-device evaluation.
Do not import ContextForge's six-tool warning as an arbitrary product rule.

### Privacy invariants

The following remain non-negotiable:

1. Any selected capability containing `local_chat`, `local_calls`, or other Local-tier
   material forces the entire turn—including narration—on-device.
2. A PCC-pinned turn never receives or even sees Local-tier capability descriptions.
3. Tool activity metadata contains no content, query text, names, amounts, IDs, or
   result payloads.
4. Confirmation cards remain the only AI-initiated path to money mutations.
5. No policy/config update downloaded from a server may silently expand a surface's
   data access or bypass confirmation.
6. ContextForge-style remote plugins or user-installable tools are out of scope.

## Feature value

This work is not architecture for its own sake. It unlocks visible improvements:

- **How this was answered:** a compact disclosure below an AI bubble showing engine and
  friendly capability names.
- **AI Access & Activity:** one coherent Settings screen for index, memory, access
  switches, privacy rules, and a content-free activity ledger.
- **More reliable routing:** smaller surface-appropriate tool menus for Apple's compact
  on-device model.
- **Honest failure UX:** "Chat search timed out; the spending answer still used exact
  expense data" instead of a generic fallback or leaked exception.
- **Faster diagnosis:** determine whether latency came from routing, a local tool, PCC,
  narration, or a grounding retry.
- **Safer future features:** receipt intelligence, recurring-bill/calendar helpers, and
  Siri actions can join an explicit capability system instead of accumulating bespoke
  checks.

## Phased implementation plan

### P0 — disclosure repair

- Carry `engineSource` through `AiChatScreen.ChatMsg`, persistence, and rendering.
- Reuse the insights badge language and live-engine behavior.
- Narrow the absolute `AiIndexScreen` copy and link/route users to PCC disclosure.
- Add focused UI/service tests where practical.

**Exit:** every model answer in both conversation surfaces identifies the actual engine;
on-device index wording no longer contradicts automatic PCC behavior.

### P1 — contracts without behavior change

- Introduce `AiToolDefinition`, canonical outcomes, tool/contract versions, input
  normalization, successful-output validation, safe error codes, and result-size caps.
- Adapt the 21 existing tools without changing catalog text or results.
- Keep the native request struct flat and translate at the JS boundary.
- Add contract tests for every tool, including the rule that error outcomes bypass the
  successful-output schema.

**Exit:** the current evals pass with equivalent answers, and every tool has an
enforceable input/output contract.

### P2 — fixed execution policy and real deadlines

- Add `AiExecutionContext` with surface, engine, consent snapshot, trace ID, deadline,
  and abort signal.
- Move availability/privacy authorization, caps, invoke, validation, and safe error
  conversion behind `invokeAiTool`.
- Add cooperative cancellation to asynchronous chat/call providers.
- Enforce the remaining per-turn deadline before each hop/tool/model call.
- Never retry writes; initially do not retry deterministic local reads either.

**Exit:** one code path proves which data and engine each tool can use, and a timed-out
provider cannot strand the turn indefinitely.

### P3 — surface packs and eval-led shortlisting

- Define capability packs as code-reviewed constants.
- Pass `thread.surface` into discovery and enforce the pack during execution as well as
  catalog generation.
- Experiment with deterministic tool shortlisting behind a local flag.
- Replay all stored fixtures and run real-device evals before changing the default.

**Exit:** each surface receives the minimum useful capabilities without harming the
known-answer suite.

### P4 — AI Access & Activity

- Add chat/call capability switches while preserving current behavior on migration.
- Add a content-free local activity ring, capped by count and age.
- Add "How this was answered" to model messages.
- Fold/link the current AI index, memory, evals, PCC controls, and activity views into a
  coherent Settings information architecture without exposing developer-only detail to
  ordinary users.
- Keep detailed fixtures separate and local-only.

**Exit:** a user can understand and control AI data access, and support can diagnose a
failure without collecting private prompts.

### P5 — version attribution and release gate

- Record pipeline, prompt, capability-pack, and tool-contract versions in detailed
  fixtures and metadata traces.
- Show versions on the developer eval screen.
- Make contract/eval failures a ship preflight gate consistent with the existing AI
  fixture workflow.

**Exit:** every regression can be attributed to the exact AI behavior set that produced
it, and rollback means reverting reviewed code/config—not mutating a remote prompt.

## If external connectors arrive later

Re-evaluate ContextForge only when at least one of these becomes true:

- ManaSplit operates three or more external tool/API integrations with different auth
  and retry policies;
- a supported product feature must expose governed tools to multiple non-ManaSplit AI
  clients;
- per-user OAuth delegation to several upstream services becomes a core requirement;
- a small Firebase Function adapter can no longer provide adequate discovery, policy,
  health checking, and auditability.

Before a pilot, require all of the following:

1. The connector uses only an explicitly approved subset of Persistent-tier data.
2. Local-tier fields are structurally absent before the request reaches the gateway.
3. Firebase identity is adapted through a reviewed token/proxy design; raw Firebase ID
   tokens are not assumed to be drop-in ContextForge access tokens.
4. ContextForge runs in a separate Cloud Run/container environment with its own least-
   privilege service account and secrets—not inside the app and not as a Python shim in
   Firebase Functions.
5. Admin UI/API, A2A, bulk import, catalog, header passthrough, prompt/resources/roots,
   payload capture, and every unused transport are explicitly disabled.
6. The exact deployed version receives a threat-model/config review because defaults and
   docs can drift.
7. PostgreSQL/Redis need, migrations, backups, upgrade cadence, monitoring, and cost have
   named ownership. Redis may be avoidable for a single-instance pilot but must not be
   assumed away for scale/coordination features.
8. A no-financial-data read-only connector proves auth, tenancy, redaction, cancellation,
   and deletion before any money graph is exposed.
9. There is an immediate kill switch and a direct non-gateway fallback or clean feature
   disable path.
10. The team accepts ContextForge's current no-LTS/no-backport security posture.

Do not begin with bank access, message search, calls, expense writes, or a general public
MCP endpoint.

## Ideas explicitly rejected for the current app

- **Shipping an MCP client/server in ManaSplit:** no current product need; expands the
  attack surface around private financial and communication data.
- **Remote plugin marketplace:** incompatible with the app's reviewable, deterministic
  capability boundary.
- **A2A/multi-agent decomposition:** contradicts the current "one brain, both surfaces"
  decision and adds routing complexity without a product payoff.
- **Remote prompt management controlling access:** a remote change must not expand data
  reach or write authority. Code-reviewed app releases remain the authority.
- **Cloud OpenTelemetry containing prompts/results:** operationally attractive but
  inconsistent with local-only messages, calls, memory, and eval fixtures.
- **Generic retries around actions:** dangerous for expense/settlement mutations and
  unnecessary for present deterministic reads.
- **Copying ContextForge's plugin framework:** dynamic discovery, modes, priorities,
  dependencies, and external processes solve enterprise extension problems ManaSplit
  does not have. Use a fixed policy sequence instead.

## Decision matrix

| Option | Decision | Reason |
|---|---|---|
| Embed ContextForge in React Native | Reject | Wrong runtime and product boundary |
| Add it to Firebase Functions | Reject | Python service vs Node 22 functions; needs independent lifecycle/state |
| Deploy it now as a gateway | Reject | No remote tool federation problem justifies the operational/privacy cost |
| Fork or copy its core code | Reject | Different language/scale; concepts transfer better than implementation |
| Adopt tool contracts/policy/trace patterns locally | Accept | Directly strengthens the existing agentic loop |
| Build AI Access & Activity UX | Accept | Concrete trust, support, and disclosure benefit |
| Re-evaluate for future external connectors | Conditional | Useful only after clear federation/OAuth/governance triggers |

## Sources reviewed

### ContextForge

- [Repository README](https://github.com/IBM/mcp-context-forge/blob/main/README.md)
- [Project metadata and dependencies](https://github.com/IBM/mcp-context-forge/blob/main/pyproject.toml)
- [Release history](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/releases.md)
- [Roadmap](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/roadmap.md)
- [Security policy](https://github.com/IBM/mcp-context-forge/blob/main/SECURITY.md)
- [Security features](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/security-features.md)
- [Architecture overview](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/index.md)
- [Plugin framework](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/plugins.md)
- [Plugin security hooks](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/plugins/security-hooks.md)
- [Tool invocation and validation](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/tool-invocation-and-validation.md)
- [OpenTelemetry architecture](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/observability-otel.md)
- [Tool cancellation](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/api/cancellation.md)
- [OAuth design](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/architecture/oauth-design.md)
- [Google Cloud Run deployment guide](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/deployment/google-cloud-run.md)
- [Current configuration implementation](https://github.com/IBM/mcp-context-forge/blob/main/mcpgateway/config.py)
- [Current tool-service implementation](https://github.com/IBM/mcp-context-forge/blob/main/mcpgateway/services/tool_service.py)
- [Apache-2.0 license](https://github.com/IBM/mcp-context-forge/blob/main/LICENSE)

### ManaSplit

- [Binding UI and AI disclosure rules](../DESIGN.md)
- [Agentic AI pipeline](../ai_layer/docs/24_agentic_ai_pipeline.md)
- [AI flywheel, memory, and search](../ai_layer/docs/25_ai_flywheel_memory_search.md)
- [Tool registry](../src/utils/aiTools.ts)
- [Agentic orchestration](../src/services/aiPipelineService.ts)
- [Assistant service and typed proposals](../src/services/assistantService.ts)
- [Turn traces and eval invariants](../src/utils/aiFeedback.ts)
- [Feedback fixture persistence/replay](../src/services/aiFeedbackService.ts)
- [Main AI chat](../src/screens/ai/AiChatScreen.tsx)
- [Insights conversation overlay](../src/components/stats/InsightChatOverlay.tsx)
- [On-device AI transparency screen](../src/screens/settings/AiIndexScreen.tsx)
- [AI memory ledger](../src/screens/settings/AiMemoryScreen.tsx)

## Final recommendation

ContextForge should influence ManaSplit's next AI-hardening iteration, not become part of
its runtime today.

The highest-return sequence is:

1. repair the two disclosure inconsistencies;
2. introduce declarative tool contracts and a canonical outcome;
3. centralize fixed privacy/validation/deadline policies;
4. add surface capability packs and evaluate smaller catalogs;
5. ship AI Access & Activity using content-free local telemetry;
6. add behavior/tool version attribution to the existing eval gate.

That captures the strongest ContextForge lessons while preserving the architecture that
makes ManaSplit distinctive: exact money calculations, user-confirmed writes, Apple-first
AI, and communication data that remains permanently local to the device.
