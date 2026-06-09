/**
 * middleware.ts — Auth + rate-limit middleware for the MCP server.
 *
 * Bridges SplitCircle's existing Firebase ID tokens into the MCP request flow:
 * the client presents `Authorization: Bearer <Firebase ID token>`, we verify it,
 * and derive the `uid`. Per Critical Rule #2 / Phase 4, the uid ALWAYS comes from
 * the verified token — never from a tool argument.
 *
 * Also provides a simple per-uid token-bucket rate limiter (MCP spec requires
 * servers to rate-limit tool invocations).
 */

import { getFirebaseAuth } from './firebase.js';

export class AuthError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'AuthError';
  }
}

export function getBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const [scheme, token] = authorizationHeader.trim().split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

/** Verify a Firebase ID token → uid. Throws AuthError on any failure. */
export async function verifyToken(authorizationHeader: string | undefined): Promise<string> {
  const token = getBearerToken(authorizationHeader);
  if (!token) throw new AuthError('Missing or malformed Authorization header');
  try {
    const decoded = await getFirebaseAuth().verifyIdToken(token);
    if (!decoded.uid) throw new AuthError('Token has no uid');
    return decoded.uid;
  } catch {
    throw new AuthError('Invalid Firebase ID token');
  }
}

// ── Per-uid token-bucket rate limiter ─────────────────────────────────────────
interface Bucket { tokens: number; updatedAt: number }
const buckets = new Map<string, Bucket>();
const CAPACITY = Number(process.env.RATE_LIMIT_CAPACITY ?? 30); // burst
const REFILL_PER_SEC = Number(process.env.RATE_LIMIT_REFILL ?? 1); // sustained

export class RateLimitError extends Error {
  constructor(message = 'Rate limit exceeded') {
    super(message);
    this.name = 'RateLimitError';
  }
}

/** Consume one token for `uid`; throws RateLimitError when empty. */
export function enforceRateLimit(uid: string, now: number = Date.now()): void {
  const b = buckets.get(uid) ?? { tokens: CAPACITY, updatedAt: now };
  const elapsed = (now - b.updatedAt) / 1000;
  b.tokens = Math.min(CAPACITY, b.tokens + elapsed * REFILL_PER_SEC);
  b.updatedAt = now;
  if (b.tokens < 1) {
    buckets.set(uid, b);
    throw new RateLimitError();
  }
  b.tokens -= 1;
  buckets.set(uid, b);
}

/** Test helper — reset limiter state between tests. */
export function __resetRateLimiter(): void {
  buckets.clear();
}
