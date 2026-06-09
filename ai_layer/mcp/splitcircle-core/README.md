# splitcircle-core MCP Server

Core CRUD + settlement MCP server: lets an AI assistant (Claude Desktop, Claude.ai,
any MCP client) read and act on SplitCircle data on behalf of an authenticated user.

## Tools

| Tool | Kind | Description |
|---|---|---|
| `get_expenses` | read | List the user's expenses (group/category/date filters) |
| `get_group_balances` | read | Per-member net balances (ported app math) |
| `get_settlement_suggestions` | read | Fewest payments to settle (`minimizeDebts`) |
| `get_user_groups` | read | Groups + the user's net balance in each |
| `get_recent_activity` | read | Merged expense/settlement feed |
| `search_expenses` | read | Semantic search via the RAG service |
| `add_expense` | **write** | Create an expense (human-confirm; idempotent via `requestId`) |

**Resources:** `splitcircle://user/{userId}/expenses`, `splitcircle://group/{groupId}/summary`,
`splitcircle://group/{groupId}/balances`.
**Prompts:** `analyze_my_spending`, `settle_up`, `review_expense`.

## Authentication

The server is an OAuth-style resource server that verifies a **Firebase ID token** on every
request (`Authorization: Bearer <token>`). The `uid` is derived from the verified token and
**baked into a per-request server instance** — tools never read a `userId` from arguments, so
a caller can only ever access their own data (Critical Rule #2). Every group access also
re-checks membership (defense in depth).

## Transport

- **Remote (Cloud Run):** Streamable HTTP at `POST /mcp` (2025-06-18 spec; supersedes HTTP+SSE).
- **Local (Claude Desktop):** stdio — `node dist/index.js --stdio` with `DEV_UID` set (dev only).

## Run / Test / Deploy

```bash
npm install
npm test          # unit tests (no GCP needed)
npm run build && npm start          # local HTTP on :8080
PROJECT_ID=my-proj REGION=us-central1 ./deploy.sh   # Cloud Run
```

Environment: see `../../.env.example`. Secrets via Secret Manager / ADC — none in code.

## Sandbox caveat

Unit tests run anywhere. Live verification (real Firebase token, real Firestore, Cloud Run)
requires a GCP project and is described in `../../docs/07_testing_guide.md`.
