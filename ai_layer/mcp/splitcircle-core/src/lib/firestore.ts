/**
 * firestore.ts — Firestore-backed DataAccess for splitcircle-core.
 *
 * Reads/writes the embedded-array group model (Phase 1). Membership is enforced
 * on every access via `memberIds`. Writes to `groups/{id}.expenses[]` use an
 * atomic arrayUnion and tolerate the legacy `title`/`description` drift.
 */

import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';
import { randomUUID } from 'node:crypto';
import { type DataAccess, type SearchHit, PermissionError, NotFoundError } from './dataAccess.js';
import type { Expense, Group } from './types.js';

if (getApps().length === 0) initializeApp();

/** Optional injectable RAG search (kept loose to avoid a hard cross-package dep). */
export type RagSearchFn = (
  uid: string, query: string, groupId: string | undefined, limit: number,
) => Promise<SearchHit>;

export class FirestoreDataAccess implements DataAccess {
  private db = getFirestore();
  constructor(private ragSearch?: RagSearchFn) {}

  private normalizeGroup(id: string, data: FirebaseFirestore.DocumentData): Group {
    return {
      groupId: id,
      name: data.name ?? '',
      currency: data.currency ?? 'USD',
      members: Array.isArray(data.members) ? data.members : [],
      memberIds: Array.isArray(data.memberIds) ? data.memberIds : [],
      expenses: (Array.isArray(data.expenses) ? data.expenses : []).map((e: any) => ({
        ...e,
        title: e.title ?? e.description ?? '', // tolerate field drift
      })),
      settlements: Array.isArray(data.settlements) ? data.settlements : [],
      createdBy: data.createdBy ?? '',
      createdAt: data.createdAt ?? 0,
      updatedAt: data.updatedAt ?? 0,
    };
  }

  async getUserGroups(uid: string): Promise<Group[]> {
    const snap = await this.db.collection('groups').where('memberIds', 'array-contains', uid).get();
    return snap.docs.map((d) => this.normalizeGroup(d.id, d.data()));
  }

  async getGroup(uid: string, groupId: string): Promise<Group> {
    const doc = await this.db.collection('groups').doc(groupId).get();
    if (!doc.exists) throw new NotFoundError('Group not found');
    const group = this.normalizeGroup(doc.id, doc.data()!);
    if (!(group.memberIds ?? []).includes(uid)) throw new PermissionError();
    return group;
  }

  async addExpense(uid: string, groupId: string, expense: Expense): Promise<Expense> {
    const ref = this.db.collection('groups').doc(groupId);
    return this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new NotFoundError('Group not found');
      const data = doc.data()!;
      if (!(Array.isArray(data.memberIds) ? data.memberIds : []).includes(uid)) {
        throw new PermissionError();
      }
      // Idempotency: if requestId already present, return the existing expense.
      const existing = (Array.isArray(data.expenses) ? data.expenses : [])
        .find((e: any) => expense.requestId && e.requestId === expense.requestId);
      if (existing) return existing as Expense;

      const now = Date.now();
      const finalized: Expense = {
        ...expense,
        expenseId: expense.expenseId || randomUUID(),
        groupId,
        createdAt: expense.createdAt || now,
        updatedAt: now,
      };
      tx.update(ref, {
        expenses: FieldValue.arrayUnion(finalized),
        updatedAt: now,
      });
      return finalized;
    });
  }

  async searchExpenses(uid: string, query: string, groupId: string | undefined, limit: number): Promise<SearchHit> {
    if (this.ragSearch) return this.ragSearch(uid, query, groupId, limit);
    // Fallback: naive substring scan across the user's groups (no RAG configured).
    const groups = groupId ? [await this.getGroup(uid, groupId)] : await this.getUserGroups(uid);
    const q = query.toLowerCase();
    const results = groups
      .flatMap((g) => g.expenses)
      .filter((e) => `${e.title} ${e.category} ${e.notes ?? ''}`.toLowerCase().includes(q))
      .slice(0, limit);
    return { results, answer: `Found ${results.length} expense(s) matching "${query}".` };
  }
}
