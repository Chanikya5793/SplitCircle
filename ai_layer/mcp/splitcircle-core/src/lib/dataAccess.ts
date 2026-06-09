/**
 * dataAccess.ts — Data access abstraction for splitcircle-core tools.
 *
 * Tools depend on this interface, NOT on Firestore directly, so every tool is
 * unit-testable with an in-memory fake (Critical Rule #7). The Firestore-backed
 * implementation lives in firestore.ts.
 *
 * SECURITY: all reads/writes are scoped by the authenticated `uid`. Membership is
 * enforced here (and again by Firestore rules) — a tool can never reach a group
 * the caller doesn't belong to.
 */

import type { Expense, Group } from './types.js';

export interface SearchHit { results: Expense[]; answer: string }

export interface DataAccess {
  /** Groups the user belongs to. */
  getUserGroups(uid: string): Promise<Group[]>;
  /** A single group IFF the user is a member; otherwise throws PermissionError. */
  getGroup(uid: string, groupId: string): Promise<Group>;
  /** Append an expense to a group's embedded array (idempotent via requestId). */
  addExpense(uid: string, groupId: string, expense: Expense): Promise<Expense>;
  /** RAG-backed semantic search over the user's expenses. */
  searchExpenses(uid: string, query: string, groupId: string | undefined, limit: number): Promise<SearchHit>;
}

export class PermissionError extends Error {
  constructor(message = 'Not a member of this group') {
    super(message);
    this.name = 'PermissionError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}
