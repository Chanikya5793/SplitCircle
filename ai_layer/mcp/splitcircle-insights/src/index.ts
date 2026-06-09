/**
 * index.ts — splitcircle-insights MCP server entry point (Cloud Run).
 * Streamable HTTP transport with per-request Firebase ID-token auth, identical
 * pattern to splitcircle-core. The uid is derived from the verified token.
 */

import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getAuth } from 'firebase-admin/auth';
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { buildServer } from './server.js';
import { BigQueryAnalytics } from './lib/bigquery.js';

if (getApps().length === 0) {
  initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID });
}

const analytics = new BigQueryAnalytics();

function getBearer(h?: string): string | null {
  if (!h) return null;
  const [scheme, token] = h.trim().split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/mcp', async (req: Request, res: Response) => {
  const token = getBearer(req.get('Authorization'));
  if (!token) { res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }); return; }
  let uid: string;
  try {
    uid = (await getAuth().verifyIdToken(token)).uid;
  } catch {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    return;
  }
  const server = buildServer({ uid, analytics });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`splitcircle-insights MCP listening on :${port}`));
