/**
 * smartSplitRecommender.ts — On-device "split like last time" (AI layer MODEL-05).
 *
 * Pure port of `ai_layer/models/smart_split/recommender.ts` plus an adapter from
 * the app's Expense model, so the Add-Expense flow can suggest the method + share
 * pattern this set of people usually uses — offline, instant, no backend call.
 * Keep the logic in sync with the server copy (it powers the same suggestion via
 * MCP); both are pure and covered by unit tests.
 */

import type { Expense } from '../models/expense';

export interface SplitParticipant {
  userId: string;
  share: number;
}

export interface PastSplit {
  method?: string;
  category?: string;
  participants: SplitParticipant[];
}

export interface SplitContext {
  participants: string[];
  amount: number;
  category?: string;
}

export interface SplitRecommendation {
  method: string;
  participants: SplitParticipant[];
  basis: 'history' | 'equal';
  confidence: number;
  matchedOn?: 'category' | 'participants';
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/** Equal split of `amount` across `userIds`, summing to exactly `amount`. */
export function equalSplit(userIds: string[], amount: number): SplitParticipant[] {
  const n = userIds.length;
  if (n === 0) return [];
  const base = cents(amount / n);
  const parts = userIds.map((userId) => ({ userId, share: base }));
  const drift = cents(amount - base * n);
  parts[n - 1].share = cents(parts[n - 1].share + drift);
  return parts;
}

function sameParticipantSet(ctx: string[], past: SplitParticipant[]): boolean {
  const a = new Set(ctx);
  const b = new Set(past.map((p) => p.userId));
  if (a.size !== b.size) return false;
  for (const u of a) if (!b.has(u)) return false;
  return true;
}

function mostFrequent(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

function scaledFromHistory(pool: PastSplit[], userIds: string[], amount: number): SplitParticipant[] {
  const ratioSum = new Map<string, number>();
  let counted = 0;
  for (const p of pool) {
    const total = p.participants.reduce((s, x) => s + (x.share || 0), 0);
    if (total <= 0) continue;
    for (const x of p.participants) ratioSum.set(x.userId, (ratioSum.get(x.userId) ?? 0) + x.share / total);
    counted += 1;
  }
  if (counted === 0) return equalSplit(userIds, amount);

  const avgRatio = userIds.map((u) => (ratioSum.get(u) ?? 0) / counted);
  const norm = avgRatio.reduce((s, r) => s + r, 0) || 1;
  const parts = userIds.map((userId, i) => ({ userId, share: cents((avgRatio[i] / norm) * amount) }));
  const drift = cents(amount - parts.reduce((s, p) => s + p.share, 0));
  if (parts.length > 0) parts[parts.length - 1].share = cents(parts[parts.length - 1].share + drift);
  return parts;
}

/**
 * Recommend a split for `ctx` from `history`. Prefers same-category history,
 * falls back to any same-participant-set history, finally to an equal split.
 */
export function recommendSplit(ctx: SplitContext, history: PastSplit[]): SplitRecommendation {
  const userIds = Array.from(new Set(ctx.participants));
  if (userIds.length === 0) {
    return { method: 'equal', participants: [], basis: 'equal', confidence: 0 };
  }

  const sameSet = history.filter((h) => sameParticipantSet(userIds, h.participants));
  const sameCat = ctx.category ? sameSet.filter((h) => h.category === ctx.category) : [];
  const pool = sameCat.length > 0 ? sameCat : sameSet;
  const matchedOn = sameCat.length > 0 ? 'category' : 'participants';

  if (pool.length === 0) {
    return { method: 'equal', participants: equalSplit(userIds, ctx.amount), basis: 'equal', confidence: 0.2 };
  }

  const method = mostFrequent(pool.map((p) => p.method ?? 'equal')) ?? 'equal';
  const methodAgreement = pool.filter((p) => (p.method ?? 'equal') === method).length / pool.length;
  const confidence = Math.min(0.95, 0.4 + 0.1 * pool.length) * methodAgreement;

  return {
    method,
    participants: scaledFromHistory(pool, userIds, ctx.amount),
    basis: 'history',
    confidence: cents(confidence),
    matchedOn,
  };
}

/**
 * Adapter: app `Expense[]` (a group's embedded array) → split history. Uses the
 * final per-user amounts in `participants[].share` and the rich
 * `splitMetadata.method` when present (falling back to legacy `splitType`).
 */
export function buildSplitHistory(expenses: readonly Expense[]): PastSplit[] {
  return (expenses ?? [])
    .filter((e) => Array.isArray(e?.participants) && e.participants.length > 0)
    .map((e) => ({
      method: e.splitMetadata?.method ?? e.splitType,
      category: e.category,
      participants: e.participants.map((p) => ({ userId: p.userId, share: Number(p.share) || 0 })),
    }));
}
