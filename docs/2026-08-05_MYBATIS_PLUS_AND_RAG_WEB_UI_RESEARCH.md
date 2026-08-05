# MyBatis-Plus and RAG Web UI research for ManaSplit

- **Date:** 2026-08-05
- **Projects reviewed:**
  [baomidou/mybatis-plus](https://github.com/baomidou/mybatis-plus) and
  [rag-web-ui/rag-web-ui](https://github.com/rag-web-ui/rag-web-ui)
- **MyBatis-Plus snapshot:**
  [`bf67d907478c724120bf76292da54abf9e73c2b3`](https://github.com/baomidou/mybatis-plus/commit/bf67d907478c724120bf76292da54abf9e73c2b3),
  committed 2026-08-03
- **RAG Web UI snapshot:**
  [`905fb04669ae6f2a0cb3690d82a547b860e80dd4`](https://github.com/rag-web-ui/rag-web-ui/commit/905fb04669ae6f2a0cb3690d82a547b860e80dd4),
  tagged `v0.8.0`, committed 2026-04-05
- **ManaSplit branch reviewed:** `ui-revamp`

## Executive decision

Do **not** add either project as a ManaSplit dependency or service.

MyBatis-Plus is a mature Java persistence toolkit built specifically around MyBatis and
relational SQL. ManaSplit has no JVM/MyBatis runtime: it is a strict TypeScript React
Native app backed by AsyncStorage/files, Firestore, RTDB, and Node Firebase Functions.
Installing MyBatis-Plus would require introducing a new Java backend and relational
database merely to gain behavior that Firestore transactions, security rules, typed
TypeScript repositories, and a future local SQLite layer can provide directly.

RAG Web UI is an educational/general-purpose knowledge-base product, not a library. Its
deployment is a Next.js frontend plus FastAPI, MySQL, Chroma or Qdrant, MinIO, Nginx, and
an LLM/embedding provider. That duplicates much of ManaSplit's existing AI work, adds a
second identity and storage plane, stores chat messages and retrieved document text on
servers, and conflicts with the app's Apple on-device/PCC and local-first constraints.

The useful outcome is a small set of patterns to implement natively:

1. a fixed mutation-policy pipeline around canonical expense, settlement, and group
   writes;
2. explicit optimistic concurrency and safe-scope guards for edits and destructive
   operations;
3. typed, composable local query specifications if the planned SQLite ledger proceeds;
4. a developer retrieval inspector attached to the existing AI eval surface;
5. tappable source/evidence sheets for assistant, insights, and search answers;
6. a durable, content-hashed ingestion state machine for receipts and any future local
   document import;
7. optionally, a small packaged Help/Policy knowledge base that remains on-device.

These are inspirations, not ports. They should remain TypeScript/Swift, local-first, and
compatible with ManaSplit's existing Firebase and Apple Foundation Models architecture.

## Decision summary

| Project | Adopt? | Best ideas to borrow | Main reason not to adopt |
|---|---|---|---|
| MyBatis-Plus | No | Interceptor ordering, optimistic versions, scoped mutation guards, typed query builders, automatic metadata, pagination contracts | Java/MyBatis/SQL-only; no compatible runtime or database boundary in ManaSplit |
| RAG Web UI | No | Ingestion progress, content hashes, retrieval test UI, source popovers, provider/vector abstractions as design vocabulary | Duplicates the AI layer and adds persistent server copies of chats/documents plus a large Python/SQL/vector-storage stack |

## Scope and method

This review used primary sources:

- shallow clones of both current default branches at the snapshots listed above;
- runtime code, data models, build/deployment configuration, changelogs, tests, CI,
  authentication, document ingestion, retrieval, streaming, and deletion paths;
- the official [MyBatis-Plus documentation](https://baomidou.com/en/) and repository
  pages for current project metadata;
- ManaSplit's binding architecture documents and current TypeScript implementation,
  including the AI pipeline, optional cloud RAG code, local storage, receipt scanning,
  backup/handoff state machines, Firebase Functions, and Firestore rules.

Neither project was deployed or benchmarked. Performance and reliability statements
made by the projects are treated as project claims. Repository counts below are simple
snapshot observations, not quality scores. GitHub popularity numbers are approximate and
time-sensitive.

---

# Part I — MyBatis-Plus

## What it actually is

MyBatis-Plus is an enhancement layer for the Java MyBatis SQL mapper. It supplies a
generic `BaseMapper`, CRUD repositories/services, lambda and conditional query wrappers,
pagination, code generation, ID strategies, logical deletion, automatic field filling,
batch helpers, type handlers, and a chain of database interceptors. Its stated design is
to enhance MyBatis without replacing it. See the
[project overview](https://github.com/baomidou/mybatis-plus) and
[official feature summary](https://baomidou.com/en/).

It is not a general data-modeling system, a Firebase adapter, a mobile database, or a
TypeScript package. Its safety and productivity features operate by generating or
rewriting SQL in a JVM process before MyBatis sends that SQL to a relational database.

The reviewed source reports version `3.5.17` in
[`gradle.properties`](https://github.com/baomidou/mybatis-plus/blob/bf67d907478c724120bf76292da54abf9e73c2b3/gradle.properties),
also reflected in the official site and changelog. The build targets Java 8 bytecode,
uses a Java 21 build toolchain, and supports multiple Spring Boot generations and SQL
parsers. The Apache-2.0 license permits commercial use subject to its terms.

The snapshot contained approximately:

- 957 Java source files;
- 464 Java files under test paths;
- roughly 1,542 JUnit test annotations or conventionally named test methods;
- 42 Kotlin files;
- multiple modules for annotations, core, extension, code generation, Spring integration,
  BOMs, and JSQLParser variants.

GitHub showed roughly 17.4k stars, 4.4k forks, more than 6,100 commits, and active work in
August 2026. Its long history, compatibility surface, test volume, release cadence, and
published Maven artifacts are strong maturity signals.

## The ideas that matter to ManaSplit

### 1. One ordered interception boundary for every mutation

MyBatis-Plus routes database execution through a core interceptor containing ordered
inner interceptors. The official guidance puts transformations such as tenant scoping
before pagination/optimistic locking and safety analysis last. See
[Plugin Core](https://baomidou.com/en/plugins/).

ManaSplit has several strong write paths, but their safeguards are distributed across
`GroupContext`, Firebase Functions, Firestore rules, entity guards, revoke handling,
outboxes, and feature-specific services. The transferable idea is one explicit mutation
pipeline, not SQL interception:

```text
typed command
  -> normalize IDs, money, dates, actor, and scope
  -> validate schema and domain invariants
  -> authorize current membership/role on the trusted side
  -> verify expected revision or base hash
  -> reject unscoped or over-broad mutations
  -> apply the canonical atomic write
  -> emit only required notification/revoke/outbox effects
  -> record privacy-safe operational metadata
```

The order should be fixed and covered by tests. Feature code should not be able to opt out
with a casual annotation equivalent. Any exceptional bypass must be an explicit,
server-owned command with its own tests.

This complements the ContextForge review's recommendation for an AI invocation policy
boundary. The same principle applies at a more important boundary: money mutations.

### 2. Optimistic versions for human-visible conflict handling

MyBatis-Plus's optimistic-lock plugin reads a version, includes it in the update
condition, increments it, and fails if another writer has already changed the record.
See the [optimistic-lock documentation](https://baomidou.com/en/plugins/optimistic-locker/).

Firestore transactions already retry on document conflicts, but automatic retry is not
the same user contract as optimistic editing. A person can open an expense, another
member can change it, and the first person can later submit stale fields. A transaction
can successfully apply that stale intent to the newest document unless the application
also checks a logical revision.

Add a small monotonic `revision` or immutable `contentVersion` to mutable financial
entities when the storage model can support it cleanly. Edit commands should carry
`expectedRevision`. A mismatch should return a typed conflict with the current values so
the UI can say "This expense changed while you were editing" and offer review/reapply.

Do not add a version to every transient RTDB node. The strongest value is for expenses,
settlements, recurring-bill definitions, budgets, and group membership/settings.

The current group document embeds expense arrays, so per-entity revisions may increase
write complexity. This recommendation becomes much cleaner with the normalized local
SQLite ledger proposed in [offline-first research](OFFLINE_FIRST_RESEARCH.md), or with a
future normalized persistent schema. Until then, base hashes on edit payloads are a
lower-impact bridge.

### 3. Block broad writes and deletes by construction

MyBatis-Plus provides a block-attack interceptor for update/delete statements lacking a
meaningful condition. See the
[block-attack documentation](https://baomidou.com/en/plugins/block-attack/).

ManaSplit does not execute ad hoc SQL, but it has equivalent risks:

- account/group cascades that enumerate many entities;
- repair/backfill functions;
- notification and revoke fan-out;
- cleanup/reaper tasks;
- future local database migrations;
- any batch accepting a client-provided list of IDs.

Create shared destructive-operation guards with explicit `scope`, `reason`, `maxItems`,
and dry-run counts. Server batch helpers should reject an empty scope, reject a count over
the declared cap, and require a continuation cursor for larger work. A group deletion may
be intentionally broad; the guard makes that breadth visible and testable instead of
accidental.

For local SQLite, require a typed predicate for `updateMany`/`deleteMany`; no overload
should exist that silently means "all rows." Keep existing bounded RTDB reapers and make
their scope contracts consistent with this pattern.

### 4. Automatic scope injection is useful, but not authorization

The MyBatis-Plus tenant plugin automatically adds a tenant condition to relevant SQL and
insert paths. Its own documentation warns that tenancy is not the same as permission
filtering. See the [multi-tenant plugin](https://baomidou.com/en/plugins/tenant/).

For ManaSplit, `uid`, `groupId`, and chat membership are the analogous scope. Typed
repositories can require a `DataScope` object and automatically include it in local
queries and operation envelopes. This reduces accidental cross-group reads.

It must not replace trusted authorization:

- Firestore rules remain mandatory for client Firestore access;
- Firebase Functions derive `uid` from the verified token, never command arguments;
- group membership/role is re-read for privileged server operations;
- local scope injection protects correctness and privacy on the device but is not a
  server security boundary.

### 5. Typed query specifications fit a future local ledger

MyBatis-Plus's conditional/lambda wrappers make filters composable while keeping field
references typed. ManaSplit already has domain-specific analytics and search helpers;
those are safer than exposing a generic query language to models or UI code.

If the planned SQLite migration proceeds, add a deliberately smaller TypeScript query
specification layer:

```ts
type ExpenseQuery = {
  scope: { userId: string; groupId?: string };
  range?: { from: number; to: number };
  categories?: readonly string[];
  payerIds?: readonly string[];
  participantIds?: readonly string[];
  text?: string;
  cursor?: string;
  limit: number;
};
```

Compile that specification into parameterized SQLite queries inside one repository. Keep
raw SQL private to the persistence module. Clamp limits, use stable ordering plus cursor
pagination, and return domain types rather than rows. AI tools should call approved
domain queries, never build arbitrary predicates.

Do not reproduce MyBatis's full dynamic wrapper API. A smaller discriminated union is
easier to audit under TypeScript strict mode and can encode ManaSplit's privacy scopes.

### 6. Consistent IDs and metadata filling

MyBatis-Plus supports primary-key strategies and automatic field filling. ManaSplit
already creates IDs/timestamps in several places, but a canonical mutation boundary can
standardize:

- UUID strategy and idempotency key;
- `createdAt`, `updatedAt`, and `createdBy`/`updatedBy` where appropriate;
- logical revision/base hash;
- schema version;
- sync origin (`local`, `cloud`, `nearby`, `restore`) as local operational metadata.

Do not expose these fields for models or clients to invent. The trusted canonical write
path fills them.

### 7. Logical deletion should be used narrowly

MyBatis-Plus can turn deletes into updates and automatically filter deleted rows. See
[Logical Delete Support](https://baomidou.com/en/guides/logic-delete/).

ManaSplit should **not** broadly adopt soft deletion. It would conflict with account
deletion, user expectations, storage minimization, and the binding rule that transit data
must be removed. Messages, call signaling/history, media, AI local memory, and account
data must follow their existing deletion requirements.

The useful subset is a short-lived sync tombstone when another device must learn that a
previously cached expense or settlement was deleted. Tombstones need a narrow schema,
expiry/acknowledgement rule, and reaper. They are transport for deletion, not indefinite
retention of the deleted content.

## What not to copy from MyBatis-Plus

| Capability | ManaSplit disposition | Reason |
|---|---|---|
| Java/Spring starter | Reject | No JVM service exists; adds an unjustified platform |
| Generic `BaseMapper` CRUD everywhere | Reject | Financial writes need domain commands and invariants, not table-shaped CRUD |
| Active Record entities | Reject | Couples domain objects to storage and makes local/cloud reconciliation harder |
| SQL parser/interceptor implementation | Reject | Firestore, RTDB, AsyncStorage, and SQLite adapters need native controls |
| Database code generation | Mostly reject | Generated CRUD would expose storage shape and bypass product rules |
| Dynamic table names/sharding | Reject now | No relational multi-tenant table fleet exists |
| Global logical delete | Reject | Conflicts with privacy, erasure, and ephemeral transit guarantees |
| SQL performance/illegal-SQL analyzers | Do not port | Use query plans/benchmarks for local SQLite and Firebase-specific monitoring |
| Client-selected tenant/scope | Reject | Trusted identity and membership must derive from verified state |

## MyBatis-Plus maturity and cautions

MyBatis-Plus is mature enough for its intended Java/MyBatis ecosystem. That does not
make its plugins automatic security boundaries. The official security guidance notes
that allowing frontend-provided SQL fragments can create injection risks and recommends
backend mapping/validation; the project has also deprecated or planned removal of some
analysis plugins after implementation limitations. See
[Preventing Security Vulnerabilities](https://baomidou.com/en/reference/about-cve/)
and the reviewed
[`CHANGELOG.md`](https://github.com/baomidou/mybatis-plus/blob/bf67d907478c724120bf76292da54abf9e73c2b3/CHANGELOG.md).

The lesson for ManaSplit is to borrow invariants and boundary design, not to assume a
generic framework can replace domain authorization, confirmation, tests, or data-model
review.

---

# Part II — RAG Web UI

## What it actually is

RAG Web UI is a self-hosted knowledge-base question-answering application. Users create
accounts and knowledge bases, upload PDF/DOCX/Markdown/text files, preview chunks,
process embeddings, create chats associated with knowledge bases, retrieve relevant
chunks, stream an LLM answer, and inspect positional citations. It also exposes an API
key-protected OpenAPI surface.

The deployment described in its
[`README.md`](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/README.md)
requires Docker Compose and recommends 8 GB or more RAM. Its main services are:

| Layer | Technology | Persistent content |
|---|---|---|
| Web UI | Next.js 14, React 18, Tailwind/shadcn, Vercel AI SDK | Browser JWT in `localStorage` |
| API | Python FastAPI + LangChain | Orchestration, auth, ingestion, streaming |
| Relational store | MySQL + SQLAlchemy/Alembic | Users, raw API keys, knowledge-base metadata, chats, messages, tasks, chunk records |
| Vector store | Chroma by default or Qdrant | Document chunk embeddings and text/metadata |
| Object store | MinIO | Original uploaded documents and temporary uploads |
| Model providers | OpenAI, DeepSeek, MiniMax, Ollama; several embedding providers | Prompts/context leave the deployment for cloud providers when selected |
| Edge | Nginx | HTTP reverse proxy; sample configuration listens without TLS |

It is Apache-2.0 licensed. The reviewed default branch had 83 commits, roughly 3,000
GitHub stars and 350 forks, 55 backend Python files, 44 frontend source files, and three
test files across backend/frontend. This is a useful working reference application, but
it is a much younger and smaller project than MyBatis-Plus.

The head is tagged `v0.8.0`, while the API's hard-coded application version remains
`0.1.0` in
[`config.py`](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/core/config.py).
That is a small example of release metadata drift operators would need to own.

## How its RAG pipeline works

### Ingestion

1. The API reads each upload fully into memory and computes SHA-256.
2. It deduplicates by filename plus content hash within a knowledge base.
3. The original is placed in a temporary MinIO key.
4. Users can preview adjustable fixed-size/overlap chunks.
5. A `ProcessingTask` moves through pending/processing/completed/failed states.
6. The worker extracts text, recursively splits it, embeds chunks, and writes a vector
   collection named `kb_<id>`.
7. Chunk hashes and metadata are recorded in MySQL, and unchanged chunks can be reused.

See
[`knowledge_base.py`](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/api/api_v1/knowledge_base.py),
[`document_processor.py`](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/services/document_processor.py),
and the
[`knowledge.py` models](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/models/knowledge.py).

The README calls processing distributed, and a helper says it adds work to a queue. The
reviewed implementation actually uses FastAPI background tasks plus in-process
`asyncio.create_task`; there is no durable external work queue. Process/container failure
can therefore strand a pending task. Treat the current state machine as a useful UX
pattern, not a production-grade job system.

### Retrieval and answer generation

1. A chat is created only after its selected knowledge bases are checked against the
   current user.
2. The service rewrites follow-up questions using chat history.
3. It opens a vector store for each selected knowledge base, but currently uses only the
   **first** store for retrieval.
4. LangChain retrieves its default number of chunks.
5. A prompt asks the model to answer from context, use positional `[citation:n]` markers,
   stay concise, and disclose missing information.
6. Retrieved chunk text and metadata are base64-encoded into the stream, concatenated
   with the answer, and stored in the MySQL message row.
7. The web UI decodes that context and provides citation popovers showing source text,
   knowledge-base name, filename, and metadata.

See
[`chat_service.py`](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/services/chat_service.py),
[`chat.py`](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/api/api_v1/chat.py),
and the frontend
[`Answer` component](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/frontend/src/components/chat/answer.tsx).

The included "test retrieval" endpoint is particularly useful as product tooling: a
signed-in owner can submit a query and `top_k`, then inspect every retrieved chunk,
metadata object, and score before involving the generator.

## What ManaSplit already does better for its domain

ManaSplit is not starting from an empty RAG stack:

- The current agentic pipeline routes a question to exact, deterministic TypeScript
  tools, enforces hop/request budgets, grounds final numbers, returns typed write
  proposals, and can pin sensitive local tools on-device. See
  [Agentic AI Pipeline](../ai_layer/docs/24_agentic_ai_pipeline.md).
- Twenty-one domain tools cover totals, range comparisons, categories, members,
  merchants, balances, settle plans, budgets, recurring expenses, forecasts, anomalies,
  cross-group analysis, chat search, and call statistics.
- Exact expense answers already return structured sources, confidence, and citations;
  the optional cloud RAG implementation retrieves by authenticated user/group scope,
  rehydrates authoritative expenses, filters them again, estimates confidence, and has a
  citation-faithfulness release gate. See
  [`rag_service.ts`](../ai_layer/services/rag/rag_service.ts) and
  [AI validation](../ai_layer/docs/10_validation.md).
- The assistant/insights/search surfaces already share a stateless model loop, feedback
  fixtures, local AI memory, engine routing, and submit-only search answers. See
  [AI Quality Flywheel](../ai_layer/docs/25_ai_flywheel_memory_search.md).
- Receipt capture already uses on-device VisionKit and a local learning service instead
  of sending images through a general document platform.
- Existing backup and nearby-handoff services already use bounded chunks, hashes,
  resumable checkpoints, validation, and explicit incomplete states.

For financial questions, an expense is already a structured record. Turning it into a
generic 1,000-character chunk and retrieving it by semantic similarity is usually less
reliable than exact range/category/member tools. RAG should complement deterministic
queries for fuzzy discovery and unstructured documents; it must not perform arithmetic
or become the authority for balances.

## Useful RAG Web UI patterns to adopt

### 1. Add a retrieval inspector to the AI eval surface

RAG Web UI separates retrieval testing from answer generation. ManaSplit's dev-only AI
eval screen should gain a "Retrieval inspector" mode that shows, for one query:

- resolved scope, time range, entities, and engine eligibility;
- router decision and offered/selected tool capability pack;
- exact tool rows and fuzzy-search candidates before narration;
- rank/score and why each candidate was included or excluded;
- source freshness/hash and whether it came from structured graph or Local tier;
- final grounding verdict, cited source IDs, and latency per stage.

The inspector must default to local redaction: no message text, call data, receipt text,
or prompts in shared logs. Full content is visible only on the device in a developer
screen. Export should be metadata-only unless an explicit local fixture workflow already
permits the content.

This is a higher-value improvement than adding another vector database because it makes
current retrieval errors observable and reproducible.

### 2. Unify source drill-down across all AI surfaces

The RAG Web UI citation popover provides a good interaction: the claim remains readable,
while a tap reveals the actual evidence and document identity.

ManaSplit should define one native `AiEvidenceSheet` used by assistant, insights, and
search. Depending on source type it can show:

- expense title, amount, date, payer, group, and a link to the expense;
- aggregate source range and the exact rows that contributed;
- receipt thumbnail and OCR line, when available and authorized;
- local chat/call evidence only on-device, with a clear Local badge;
- engine source and "calculated by ManaSplit" versus "worded by AI" disclosure.

The sheet should consume typed source objects, not citation markers parsed from model
text. The narrator may cite stable handles, but JavaScript validates and resolves them.
This strengthens the binding DESIGN.md disclosure rule and helps users verify money
answers.

### 3. Standardize durable ingestion jobs

RAG Web UI's content hash, preview step, incremental chunks, and visible task states are
useful for receipts, statement import, backup restore, and future help-content indexing.
ManaSplit already implements parts of this pattern in several services; consolidate the
contract rather than adding the Python worker:

```ts
type IngestionJob = {
  id: string;
  kind: 'receipt' | 'statement' | 'help-index' | 'restore';
  ownerScope: string;
  inputHash: string;
  schemaVersion: number;
  state: 'queued' | 'extracting' | 'review' | 'indexing' | 'done' | 'failed' | 'cancelled';
  completedUnits: number;
  totalUnits: number;
  checkpoint?: string;
  safeErrorCode?: string;
  updatedAt: number;
};
```

Requirements:

- persist before starting work and checkpoint after durable writes;
- resume idempotently after app/process death;
- validate size/type/count before allocation;
- deduplicate by input hash plus parser/schema version;
- make cancellation real and clean partial derived data;
- bind every job to an owner/group scope;
- delete derived chunks when the source is deleted;
- never log extracted document text;
- surface review for uncertain OCR instead of silently committing expenses.

### 4. Use a packaged Help/Policy knowledge base as the first document-RAG candidate

The safest valuable knowledge-base feature is not uploading personal documents to a new
server. It is answering "How do I split by shares?", "What does settle up do?", or
"Why is my call unavailable?" from reviewed app documentation.

Ship a compact versioned help corpus with the app, index it locally (or use deterministic
section search), and let the on-device Foundation Model word an answer with tappable
section citations. This corpus contains no personal data, can be regression-tested, works
offline, and reduces support friction. A remote vector service is unnecessary at this
scale.

The help corpus must be product-reviewed content, not raw internal operational docs that
could reveal secrets, abuse controls, or implementation details.

### 5. Consider local personal-document import only after the receipt pipeline is solid

A future feature could import a travel itinerary, rental agreement, or bank statement and
attach it to a group. It should be an explicit, separately consented product capability:

- parse and store originals locally by default;
- use on-device embeddings/search where available;
- never mix one group's chunks with another scope;
- show storage size, indexed status, and a complete delete action;
- never use document text for training, analytics, or unrelated personalization;
- require a visible confirmation before any PCC prompt includes an excerpt;
- keep deterministic parsers authoritative for amounts/dates imported as expenses.

Do not build this merely because a generic RAG UI demonstrates uploads. Validate user
demand and threat-model shared-device/group access first.

## Security and production-readiness findings in RAG Web UI

The project is useful as an educational reference, but the reviewed snapshot should not
be deployed unchanged for financial or private user data.

### Authentication and secret handling

- Configuration defaults include `your-secret-key-here`, `minioadmin`, predictable
  database credentials, and a seven-day JWT lifetime (`10080` minutes). Examples are
  normal for local setup, but the application does not fail closed when defaults remain.
- Password input has no explicit minimum length/strength constraints in its Pydantic
  schema, and registration is open.
- API keys are stored in plaintext, queried by plaintext, returned in every key-list
  response, and included in info logs on creation/update/deletion. A production system
  should show a key once, store a keyed hash, redact logs, and support rotation.
- Browser bearer tokens are stored in `localStorage`, increasing the impact of any XSS.

See
[`security.py`](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/core/security.py),
[`api_key.py`](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/services/api_key.py),
and frontend
[`api.ts`](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/frontend/src/lib/api.ts).

### Cross-user and destructive-operation concerns

- The authenticated `/cleanup` route queries and deletes **all** expired temporary
  uploads without filtering to the current user. Any signed-in user can therefore trigger
  global cleanup. Expiry may make the data eligible for deletion, but the missing
  ownership/operator boundary is still unsafe.
- Knowledge-base deletion attempts object/vector cleanup first, collects errors, then
  deletes database records even when external cleanup failed. That can leave orphaned
  source files or vector collections containing user text.
- Several endpoints return raw exception strings in HTTP 500 responses, which can expose
  internal service details.

Deletion across MySQL, object storage, and a vector database is a distributed operation;
it needs an idempotent deletion ledger/reaper with verification, not best-effort calls in
one request.

### Upload and resource controls

- Nginx allows 100 MB request bodies, and the API reads each uploaded file fully into
  memory before hashing it.
- The upload route does not itself enforce a per-user quota, file count, extension/MIME
  allowlist, decompression/parse budget, or normalized object name before storage.
- User-selected preview `chunk_size`, `chunk_overlap`, and retrieval `top_k` need strict
  server bounds to prevent resource abuse.
- In-process `asyncio` tasks are not durable jobs and have no cross-worker coordination,
  retry ledger, cancellation, or lease.

ManaSplit already has careful size/count/hash validation in its nearby attachment and
backup code; any ingestion feature should reuse that posture.

### Privacy and observability

- LangChain verbose and debug modes are enabled globally in the chat service. Depending
  on library/provider behavior, retrieved text, prompts, and model exchanges may enter
  logs.
- Full user and assistant messages are stored in MySQL. Assistant rows also contain a
  base64 copy of retrieved context, duplicating document excerpts beyond the vector and
  object stores.
- Cloud chat and embedding providers receive user queries and document chunks when
  selected. "Self-hosted UI" does not mean private inference unless local providers are
  configured and network egress is controlled.

These behaviors directly conflict with ManaSplit's rule that messages and calls never
live in Firestore or another persistent server chat store, and with its preference for
on-device/PCC execution.

### Correctness and evaluation gaps

- Multiple knowledge bases can be attached to a chat, but retrieval uses only the first
  vector store.
- Citation correctness is prompted, not post-validated. Positional markers can be
  missing, out of range, or attached to unsupported claims.
- There is no prompt-injection policy separating untrusted document instructions from
  system instructions.
- The repository's backend tests focus mainly on one model-provider factory; the one
  frontend test covers answer rendering. CI boots the Compose stack and checks health,
  but does not run an end-to-end retrieval/authorization/deletion quality suite.
- The tutorial explicitly describes the project as an introductory full-flow example and
  lists hybrid retrieval, reranking, and longer conversation memory as future learning
  directions. See the
  [project tutorial](https://github.com/rag-web-ui/rag-web-ui/blob/main/docs/tutorial/README.md).

ManaSplit's existing exact-tool tests, fake-model orchestration, local thumbs-down replay,
and RAG citation-faithfulness gate are a stronger starting point for the expense domain.

## What not to copy from RAG Web UI

| Capability | ManaSplit disposition | Reason |
|---|---|---|
| Entire Docker Compose stack | Reject | Adds Python, Next, MySQL, vector DB, MinIO, Nginx, patching, backup, monitoring, and on-call load |
| Separate username/password/JWT auth | Reject | Firebase Auth is already canonical; a second identity plane creates account-linking and deletion risk |
| Persistent server AI chat history | Reject | AI/chat history is Local tier; server persistence weakens privacy architecture |
| Raw API-key database | Reject | ManaSplit clients should never need a shared RAG secret or long-lived user API key |
| Generic cloud model-provider menu | Reject | Current product rule is Apple on-device/PCC, with truthful engine disclosure |
| Generic 1,000/200 character chunking for expenses | Reject | Structured financial records and exact queries are more reliable |
| Chroma/Qdrant now | Reject | Existing tool/search path has no demonstrated vector-database bottleneck |
| MinIO document store | Reject | Existing local files/Firebase Storage/CloudKit boundaries already have product-specific ownership |
| LangChain orchestration | Reject | Existing TypeScript agent loop is smaller, typed, tested, and privacy-aware |
| Model-generated citation markers as authority | Reject | Typed sources must be resolved and validated in code |
| In-process "queue" | Reject | Use durable local/background job checkpoints or managed server queues |

---

# Combined recommendation and roadmap

## P0 — Safety and truthful evidence

1. Implement a shared typed mutation envelope and ordered policy function for the highest
   risk financial writes. Start with expense edit/delete and settlement creation/reversal.
2. Add `expectedRevision` or a base hash to edit flows and a typed conflict response.
3. Add a shared guard for destructive/batch server operations: explicit scope, dry-run
   count, maximum, continuation, idempotency key, and safe audit metadata.
4. Complete the AI disclosure repairs identified in the ContextForge review: render the
   assistant's `engineSource` and remove absolute settings copy that is false when PCC can
   run.
5. Define typed `AiEvidence` objects and a common evidence sheet; do not parse model text
   into authority.

## P1 — Observability and ingestion reliability

1. Add retrieval inspection to the dev-only AI eval screen using the existing `TurnTrace`.
2. Show source handles, tool timing, rank/filter reasons, grounding checks, and engine
   selection locally.
3. Define the durable ingestion job contract and adapt receipt processing first.
4. Reuse existing backup/handoff checkpoint and validation patterns rather than inventing
   another queue.
5. Add deletion-verification tests proving source, derived index, cache, and thumbnail are
   all gone after receipt/document deletion.

## P2 — Local query and help improvements

1. If the normalized SQLite ledger work begins, create a small typed repository/query
   specification layer with mandatory scope, stable cursor pagination, and bounded limits.
2. Keep domain commands separate from generic persistence CRUD.
3. Build a packaged, versioned Help/Policy corpus and deterministic local retrieval.
4. Use on-device generation for wording and typed section citations for evidence.

## P3 — Optional document intelligence

Only after receipt ingestion, deletion verification, AI disclosure, and eval visibility
are solid:

1. validate demand for local statement/itinerary import;
2. threat-model group sharing, device loss, backup, and PCC excerpt consent;
3. benchmark Core Spotlight/local FTS/vector options against a deterministic baseline;
4. add semantic embeddings only if measured retrieval quality justifies their storage,
   binary size, and lifecycle cost;
5. keep exact parsers and user confirmation authoritative for money writes.

## Acceptance criteria

The borrowed ideas are successful when:

- stale concurrent edits fail visibly instead of silently overwriting newer intent;
- no batch/destructive operation can run without an explicit bounded scope;
- every AI number can open a typed evidence view or is clearly labeled as uncited
  narrative;
- a failed/killed receipt ingestion resumes without duplicates or orphaned derived data;
- deleting a source removes its file, index entries, cache, and UI references;
- retrieval errors can be reproduced locally from the eval screen without uploading
  private traces;
- help answers work offline and cite reviewed app content;
- no new Java/Python service, relational server, vector server, or second auth system is
  required for P0-P2.

## Final disposition

MyBatis-Plus is the stronger engineering project, but it solves a persistence problem in
a runtime ManaSplit does not use. Its enduring value here is conceptual: make scope,
concurrency, metadata, pagination, and destructive-write protection automatic at one
boundary.

RAG Web UI is a clear full-stack RAG teaching/reference implementation. It demonstrates
useful ingestion and evidence UX, but ManaSplit's existing domain tools and AI pipeline
are safer and more capable for financial questions. Adopting the service would be a
regression in architecture, privacy, and operational simplicity.

The right move is to implement the six focused native patterns from this report, starting
with mutation safety and evidence visibility. Revisit external RAG infrastructure only
if ManaSplit becomes a general multi-document knowledge product, which is not its current
mission.

## Primary sources

### MyBatis-Plus

- [Repository](https://github.com/baomidou/mybatis-plus)
- [Reviewed commit](https://github.com/baomidou/mybatis-plus/commit/bf67d907478c724120bf76292da54abf9e73c2b3)
- [Official overview and current version](https://baomidou.com/en/)
- [Plugin core and ordering](https://baomidou.com/en/plugins/)
- [Optimistic locking](https://baomidou.com/en/plugins/optimistic-locker/)
- [Multi-tenant scoping](https://baomidou.com/en/plugins/tenant/)
- [Block broad update/delete](https://baomidou.com/en/plugins/block-attack/)
- [Logical deletion](https://baomidou.com/en/guides/logic-delete/)
- [Security guidance](https://baomidou.com/en/reference/about-cve/)
- [Reviewed changelog](https://github.com/baomidou/mybatis-plus/blob/bf67d907478c724120bf76292da54abf9e73c2b3/CHANGELOG.md)
- [Apache-2.0 license](https://github.com/baomidou/mybatis-plus/blob/bf67d907478c724120bf76292da54abf9e73c2b3/LICENSE)

### RAG Web UI

- [Repository](https://github.com/rag-web-ui/rag-web-ui)
- [Reviewed commit/tag](https://github.com/rag-web-ui/rag-web-ui/commit/905fb04669ae6f2a0cb3690d82a547b860e80dd4)
- [README and deployment architecture](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/README.md)
- [Runtime configuration](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/core/config.py)
- [Authentication](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/core/security.py)
- [Knowledge-base API and ingestion tasks](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/api/api_v1/knowledge_base.py)
- [Document processor](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/services/document_processor.py)
- [Retrieval and generation](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/backend/app/services/chat_service.py)
- [Citation UI](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/frontend/src/components/chat/answer.tsx)
- [Tutorial and stated scope](https://github.com/rag-web-ui/rag-web-ui/blob/main/docs/tutorial/README.md)
- [Apache-2.0 license](https://github.com/rag-web-ui/rag-web-ui/blob/905fb04669ae6f2a0cb3690d82a547b860e80dd4/LICENSE)

### ManaSplit

- [Binding architecture](../AGENTS.md)
- [Binding UI and AI disclosure rules](../DESIGN.md)
- [Offline-first research](OFFLINE_FIRST_RESEARCH.md)
- [AI architecture](../ai_layer/docs/04_architecture_design.md)
- [AI validation](../ai_layer/docs/10_validation.md)
- [Agentic AI pipeline](../ai_layer/docs/24_agentic_ai_pipeline.md)
- [AI flywheel, memory, and search](../ai_layer/docs/25_ai_flywheel_memory_search.md)
- [Prior ContextForge evaluation](2026-08-05_CONTEXTFORGE_RESEARCH_AND_RECOMMENDATION.md)
