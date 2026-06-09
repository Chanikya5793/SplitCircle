/**
 * server.ts — Minimal HTTP entry for the RAG service (Cloud Run).
 *
 * One endpoint, `POST /query`, that runs `runExpenseQuery` and returns the
 * grounded answer + sources. Internal service-to-service auth via a shared secret
 * header (the calling MCP server has already verified the user's Firebase token;
 * in production this hop is additionally locked down by Cloud Run IAM). The body
 * parser + authorizer are PURE so they are unit-tested without a socket.
 */

import http from 'node:http';
import type { RAGQuery } from './rag_service';
import { runExpenseQuery } from './rag_deps';

const SHARED_SECRET = process.env.RAG_SHARED_SECRET || '';
const PORT = Number(process.env.PORT ?? 8081);

export class BadRequest extends Error {}
export class Unauthorized extends Error {}

/** PURE: validate the shared-secret header (fail closed if unconfigured). */
export function authorize(headerSecret: string | undefined): void {
  if (!SHARED_SECRET) throw new Unauthorized('RAG_SHARED_SECRET not configured');
  if (headerSecret !== SHARED_SECRET) throw new Unauthorized('bad secret');
}

/** PURE: parse + validate a /query request body into a RAGQuery. */
export function parseQueryBody(body: any): RAGQuery {
  if (!body || typeof body.query !== 'string' || !body.query.trim()) {
    throw new BadRequest('query is required');
  }
  if (typeof body.userId !== 'string' || !body.userId) {
    throw new BadRequest('userId is required');
  }
  const f = body.filters ?? {};
  const filters: RAGQuery['filters'] = {
    dateRange: f.dateRange && typeof f.dateRange.start === 'number' && typeof f.dateRange.end === 'number'
      ? { start: new Date(f.dateRange.start), end: new Date(f.dateRange.end) }
      : undefined,
    categories: Array.isArray(f.categories) ? f.categories : undefined,
    minAmount: typeof f.minAmount === 'number' ? f.minAmount : undefined,
    maxAmount: typeof f.maxAmount === 'number' ? f.maxAmount : undefined,
  };
  return {
    query: body.query,
    userId: body.userId,
    groupId: typeof body.groupId === 'string' ? body.groupId : undefined,
    filters,
    topK: typeof body.topK === 'number' ? body.topK : undefined,
  };
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res: http.ServerResponse, status: number, payload: object): void {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

export function createRagServer(): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/query') return send(res, 404, { error: 'not found' });

    try {
      authorize(req.headers['x-rag-secret'] as string | undefined);
      const q = parseQueryBody(await readJson(req));
      const result = await runExpenseQuery(q);
      send(res, 200, result);
    } catch (err) {
      if (err instanceof Unauthorized) return send(res, 401, { error: 'unauthorized' });
      if (err instanceof BadRequest) return send(res, 400, { error: err.message });
      // Never leak internals / PII.
      send(res, 500, { error: 'internal error' });
    }
  });
}

// Entry point (skipped when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  createRagServer().listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`splitcircle RAG service listening on :${PORT}`);
  });
}
