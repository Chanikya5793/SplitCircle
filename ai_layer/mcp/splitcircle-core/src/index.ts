/**
 * index.ts — splitcircle-core MCP server entry point (Cloud Run).
 *
 * Transport: Streamable HTTP (2025-06-18 spec) — the current remote-MCP standard
 * that supersedes the older HTTP+SSE transport. Each request is authenticated by
 * verifying the caller's Firebase ID token (Authorization: Bearer <token>); the
 * derived uid is baked into a per-request server instance.
 *
 * Run locally over stdio for Claude Desktop with: `node dist/index.js --stdio`
 * (uses DEV_UID for a local, unauthenticated session — never enable in prod).
 */

import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';
import { FirestoreDataAccess } from './lib/firestore.js';
import { verifyToken, AuthError } from './auth/middleware.js';

const dataAccess = new FirestoreDataAccess();

async function runStdio(): Promise<void> {
  const uid = process.env.DEV_UID;
  if (!uid) throw new Error('stdio mode requires DEV_UID (local development only)');
  const server = buildServer({ uid, data: dataAccess });
  await server.connect(new StdioServerTransport());
  // eslint-disable-next-line no-console
  console.error(`splitcircle-core (stdio) ready for dev uid=${uid}`);
}

async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

  // Stateless Streamable HTTP: a fresh server+transport per request, scoped to the
  // authenticated uid. Stateless mode is simple and scales well on Cloud Run.
  app.post('/mcp', async (req: Request, res: Response) => {
    let uid: string;
    try {
      uid = await verifyToken(req.get('Authorization'));
    } catch (err) {
      const status = err instanceof AuthError ? 401 : 500;
      res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }

    const server = buildServer({ uid, data: dataAccess });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`splitcircle-core MCP listening on :${port}`);
  });
}

const main = process.argv.includes('--stdio') ? runStdio : runHttp;
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
