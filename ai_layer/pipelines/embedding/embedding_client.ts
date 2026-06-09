/**
 * embedding_client.ts — Shared embedding helpers for the TS embedding trigger.
 *
 * Wraps Vertex AI text embeddings and Vector Search streaming upsert. Kept thin
 * and dependency-light so it can be unit tested (buildEmbeddingText is pure).
 *
 * The Vertex calls use the REST API with ADC tokens to avoid pinning a heavy SDK
 * in the Functions runtime; swap for `@google-cloud/aiplatform` if preferred.
 */

import { GoogleAuth } from 'google-auth-library';

const PROJECT = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT || '';
const REGION = process.env.GCP_REGION || 'us-central1';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-005';
const INDEX_ID = process.env.VECTOR_INDEX_ID || '';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

export interface Restrict { namespace: string; allowList: string[] }
export interface NumericRestrict { namespace: string; valueFloat?: number; valueLong?: number }
export interface Datapoint {
  datapointId: string;
  featureVector: number[];
  restricts?: Restrict[];
  numericRestricts?: NumericRestrict[];
}

export interface EmbeddingTextInput {
  title?: string;
  category?: string;
  amount?: number;
  currency?: string;
  notes?: string;
  createdAt?: number;
  participantNames?: string[];
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// 9–15 digits with up to 2 separator chars between them (covers "+1 (415) 555-0199");
// the 9-digit floor keeps dates (8 digits) and amounts out of scope.
const PHONE_RE = /\+?(?:\d[\s\-().]{0,2}){8,14}\d/g;

/**
 * PURE: redact email addresses and phone-number-like sequences from free text.
 * The structured PII fields (email/phone) are never passed in, but user-typed
 * `title`/`notes` can contain them — scrub before anything leaves for Vertex
 * (Critical Rule #3). Mirrors `redact_pii` in embedding_utils.py.
 */
export function redactPII(text: string): string {
  return text.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]');
}

/**
 * Build the compact, recall-friendly text embedded per expense.
 * PURE + deterministic so it can be unit tested. Structured PII fields
 * (email/phone) are never included, and free text (`title`/`notes`) is run
 * through `redactPII` in case users typed contact details into it.
 */
export function buildEmbeddingText(e: EmbeddingTextInput): string {
  const parts: string[] = [];
  if (e.title) parts.push(redactPII(e.title.trim()));
  if (e.category) parts.push(`category: ${e.category.trim()}`);
  if (typeof e.amount === 'number') parts.push(`amount: ${e.currency ?? ''}${e.amount.toFixed(2)}`.trim());
  if (e.createdAt) parts.push(`date: ${new Date(e.createdAt).toISOString().slice(0, 10)}`);
  if (e.participantNames && e.participantNames.length > 0) {
    parts.push(`with: ${e.participantNames.join(', ')}`);
  }
  if (e.notes && e.notes.trim()) parts.push(`notes: ${redactPII(e.notes.trim())}`);
  return parts.join(' · ');
}

async function vertexFetch(url: string, body: object): Promise<any> {
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  if (!token) throw new Error('No GCP access token available (check ADC / service-account credentials)');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Vertex error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/** Embed a single string → 768-dim vector via Vertex `text-embedding-005`. */
export async function embedText(text: string): Promise<number[]> {
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models/${EMBEDDING_MODEL}:predict`;
  const data = await vertexFetch(url, {
    instances: [{ task_type: 'RETRIEVAL_DOCUMENT', content: text }],
  });
  const values: number[] | undefined = data?.predictions?.[0]?.embeddings?.values;
  if (!values || values.length === 0) throw new Error('No embedding returned');
  return values;
}

/** Embed a query (uses RETRIEVAL_QUERY task type for asymmetric search). */
export async function embedQuery(text: string): Promise<number[]> {
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models/${EMBEDDING_MODEL}:predict`;
  const data = await vertexFetch(url, {
    instances: [{ task_type: 'RETRIEVAL_QUERY', content: text }],
  });
  const values: number[] | undefined = data?.predictions?.[0]?.embeddings?.values;
  if (!values || values.length === 0) throw new Error('No embedding returned');
  return values;
}

/** Streaming upsert of one datapoint into the Vector Search index. */
export async function upsertDatapoint(dp: Datapoint): Promise<void> {
  if (!INDEX_ID) throw new Error('VECTOR_INDEX_ID not configured');
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/indexes/${INDEX_ID}:upsertDatapoints`;
  await vertexFetch(url, {
    datapoints: [{
      datapointId: dp.datapointId,
      featureVector: dp.featureVector,
      restricts: dp.restricts?.map((r) => ({ namespace: r.namespace, allowList: r.allowList })),
      numericRestricts: dp.numericRestricts,
    }],
  });
}
