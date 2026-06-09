/**
 * vertex_client.ts — Query-side Vertex AI + Gemini calls for the RAG service.
 *
 * Self-contained (this service deploys to Cloud Run independently of the
 * ingest-side embedding Function): embeds the query, runs Vector Search
 * `findNeighbors`, and generates the grounded answer with Gemini — all over the
 * REST API with ADC tokens (google-auth-library) so no heavy SDK is pinned.
 *
 * The response mappers are split out as PURE functions so they can be unit-tested
 * without live GCP (Critical Rule #7).
 */

import { GoogleAuth } from 'google-auth-library';

const PROJECT = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT || '';
const REGION = process.env.GCP_REGION || 'us-central1';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-005';
const GEN_MODEL = process.env.GENERATION_MODEL || 'gemini-2.5-flash';
const INDEX_ENDPOINT_ID = process.env.VECTOR_INDEX_ENDPOINT_ID || '';
const DEPLOYED_INDEX_ID = process.env.VECTOR_DEPLOYED_INDEX_ID || '';
// For a public index endpoint this is its publicEndpointDomainName; defaults to
// the regional aiplatform host for private/PSC setups.
const ENDPOINT_HOST = process.env.VECTOR_ENDPOINT_HOST || `${REGION}-aiplatform.googleapis.com`;

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

export interface NeighborResult { datapointId: string; distance: number }
export interface QueryRestrict { namespace: string; allowList: string[] }

async function vertexFetch(url: string, body: object): Promise<any> {
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Vertex error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/** Restricts that scope a query to the authenticated user (+ optional group). */
export function buildQueryRestricts(userId: string, groupId?: string): QueryRestrict[] {
  const restricts: QueryRestrict[] = [{ namespace: 'user', allowList: [userId] }];
  if (groupId) restricts.push({ namespace: 'group', allowList: [groupId] });
  return restricts;
}

/** Map a findNeighbors response to a flat, ranked neighbor list. */
export function mapNeighborsResponse(json: any): NeighborResult[] {
  const neighbors = json?.nearestNeighbors?.[0]?.neighbors ?? [];
  return neighbors
    .map((n: any) => ({
      datapointId: n?.datapoint?.datapointId ?? '',
      distance: typeof n?.distance === 'number' ? n.distance : 0,
    }))
    .filter((n: NeighborResult) => n.datapointId);
}

/** Map a Gemini generateContent response to text + token usage. */
export function mapGenerateResponse(json: any): { text: string; promptTokens?: number; candidateTokens?: number } {
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p: any) => p?.text ?? '').join('').trim();
  return {
    text,
    promptTokens: json?.usageMetadata?.promptTokenCount,
    candidateTokens: json?.usageMetadata?.candidatesTokenCount,
  };
}

// ── Live calls ────────────────────────────────────────────────────────────────

/** Embed a query string (RETRIEVAL_QUERY task type — asymmetric search). */
export async function embedQuery(text: string): Promise<number[]> {
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models/${EMBEDDING_MODEL}:predict`;
  const data = await vertexFetch(url, { instances: [{ task_type: 'RETRIEVAL_QUERY', content: text }] });
  const values: number[] | undefined = data?.predictions?.[0]?.embeddings?.values;
  if (!values || values.length === 0) throw new Error('No embedding returned');
  return values;
}

/** Vector Search findNeighbors, scoped by the caller's restricts. */
export async function findNeighbors(
  vector: number[],
  opts: { userId: string; groupId?: string; topK: number },
): Promise<NeighborResult[]> {
  if (!INDEX_ENDPOINT_ID || !DEPLOYED_INDEX_ID) {
    throw new Error('VECTOR_INDEX_ENDPOINT_ID / VECTOR_DEPLOYED_INDEX_ID not configured');
  }
  const url = `https://${ENDPOINT_HOST}/v1/projects/${PROJECT}/locations/${REGION}/indexEndpoints/${INDEX_ENDPOINT_ID}:findNeighbors`;
  const data = await vertexFetch(url, {
    deployedIndexId: DEPLOYED_INDEX_ID,
    returnFullDatapoint: false,
    queries: [{
      neighborCount: opts.topK,
      datapoint: { featureVector: vector, restricts: buildQueryRestricts(opts.userId, opts.groupId) },
    }],
  });
  return mapNeighborsResponse(data);
}

/** Grounded generation with Gemini (cost rule #4). */
export async function generate(
  system: string,
  user: string,
): Promise<{ text: string; promptTokens?: number; candidateTokens?: number }> {
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models/${GEN_MODEL}:generateContent`;
  const data = await vertexFetch(url, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  });
  return mapGenerateResponse(data);
}
