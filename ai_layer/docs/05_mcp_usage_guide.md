# 05 — MCP Usage Guide

How to connect SplitCircle's MCP servers to Claude Desktop (local/stdio) and Claude.ai
(remote/HTTP), and how authentication works.

## Auth model (read this first)

Both servers verify a **Firebase ID token** on every request. The `uid` is taken from the
verified token, never from a tool argument, and each session is bound to that uid — so an
assistant can only ever read/act on the signed-in user's data. Remote deployments sit behind
the 2025-06-18 Streamable HTTP transport; the server is effectively an OAuth resource server
that trusts Firebase-issued tokens.

> Get a token for testing from your app/Firebase client SDK
> (`await getIdToken(auth.currentUser)`), or mint one in a trusted backend with the Admin SDK.

## Claude Desktop (local, stdio)

For local development you can run `splitcircle-core` over stdio. **stdio mode is dev-only**
and uses a fixed `DEV_UID` (no token verification) — never use it in production.

`~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "splitcircle-core": {
      "command": "node",
      "args": ["/abs/path/ai_layer/mcp/splitcircle-core/dist/index.js", "--stdio"],
      "env": {
        "DEV_UID": "<a-real-firebase-uid>",
        "GCP_PROJECT_ID": "my-proj",
        "FIREBASE_PROJECT_ID": "my-proj",
        "GOOGLE_APPLICATION_CREDENTIALS": "/abs/path/sa.json"
      }
    }
  }
}
```
Build first: `cd ai_layer/mcp/splitcircle-core && npm install && npm run build`.

## Claude.ai / remote clients (HTTP)

1. Deploy: `PROJECT_ID=my-proj REGION=us-central1 ./deploy.sh` → note the Cloud Run URL.
2. The MCP endpoint is `https://<service-url>/mcp` (Streamable HTTP).
3. Add it as a remote/custom MCP connector; supply `Authorization: Bearer <Firebase ID token>`.
4. Health check: `GET https://<service-url>/health` → `{ "ok": true }`.

Smoke test with curl (initialize handshake):
```bash
curl -s https://<service-url>/mcp \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-06-18","capabilities":{},
                 "clientInfo":{"name":"curl","version":"1"}}}'
```

## Available capabilities

**splitcircle-core** — tools: `get_expenses`, `get_group_balances`,
`get_settlement_suggestions`, `get_user_groups`, `get_recent_activity`, `search_expenses`,
`add_expense` (write — confirm). Resources: `splitcircle://user/{uid}/expenses`,
`splitcircle://group/{gid}/summary`, `splitcircle://group/{gid}/balances`. Prompts:
`analyze_my_spending`, `settle_up`, `review_expense`.

**splitcircle-insights** — tools: `get_spending_summary`, `compare_spending_periods`,
`find_unusual_expenses`, `ask_about_spending`, `get_group_contribution_analysis`.

## Example asks

- "Use splitcircle to show my groups and where I owe money." → `get_user_groups`
- "How should the Trip group settle up?" → `settle_up` prompt → `get_settlement_suggestions`
- "What did I spend on food last month?" → `get_spending_summary` / `ask_about_spending`
- "Add $42 dinner to Trip, I paid, split equally between me, Sam, Kay." → `add_expense` (confirm)

## Safety

`add_expense` is the only write tool; it is flagged `idempotentHint` + non-destructive, and
clients should require human confirmation before invoking it (MCP spec guidance). All inputs
are zod-validated; group membership is enforced server-side on every call.
