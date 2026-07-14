/**
 * pendingExpenseService.ts — drains expenses that a HEADLESS Siri/Shortcuts intent
 * created without opening the app.
 *
 * The native `AddExpenseIntent` (modules/splitcircle-ai/ios/SplitCircleIntents.swift)
 * runs in the app process but never spins up React Native, so it can't write to
 * Firestore/AsyncStorage directly. Instead it appends a compact record to the
 * `SplitCirclePendingExpenses` key in `UserDefaults.standard` (via
 * SplitCircleSharedStore.enqueuePendingExpense). Because those intents share the
 * standard defaults domain with the JS runtime, react-native `Settings` reads the
 * same bytes here. On mount, on every foreground, and whenever groups load, we
 * materialize each record into a real equal-split expense through the SAME
 * `GroupContext.addExpense` path the UI uses — which is idempotent by `requestId`
 * and durable via the offline outbox, so replays never double-add.
 *
 * A record whose group isn't loaded yet is kept for the next pass. iOS-only;
 * best-effort (never throws into React).
 */

import { useCallback, useEffect, useRef } from 'react';
import { AppState, Platform, Settings } from 'react-native';
import { useGroups } from '@/context/GroupContext';
import { computeSplit } from '@/utils/split';
import type { ExpenseSplitMetadata } from '@/models';

const PENDING_KEY = 'SplitCirclePendingExpenses';

/** One queued headless expense (contract with SplitCircleIntents.swift). */
export interface QueuedExpense {
  requestId: string;
  groupId: string;
  title: string;
  amount: number;
  category?: string;
  paidByUserId: string;
  participantUserIds: string[];
  splitMethod: string; // currently always 'equal' (only fully-specified case)
  createdAt: number;
}

function readPending(): QueuedExpense[] {
  if (Platform.OS !== 'ios') return [];
  try {
    const raw = Settings.get(PENDING_KEY);
    if (typeof raw !== 'string' || !raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as QueuedExpense[]) : [];
  } catch {
    return [];
  }
}

function writePending(items: QueuedExpense[]): void {
  if (Platform.OS !== 'ios') return;
  try {
    Settings.set({ [PENDING_KEY]: items.length ? JSON.stringify(items) : '' });
  } catch {
    // best-effort
  }
}

/**
 * Wires headless-expense draining for the lifetime of the signed-in nav tree.
 * Mount once (see PendingExpenseHandler in AppNavigator).
 */
export function usePendingExpenseFlush(): void {
  const { groups, addExpense } = useGroups();
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const running = useRef(false);

  const flush = useCallback(async () => {
    if (running.current) return;
    const pending = readPending();
    if (!pending.length) return;
    running.current = true;
    try {
      const remaining: QueuedExpense[] = [];
      for (const rec of pending) {
        const group = groupsRef.current.find((g) => g.groupId === rec.groupId);
        if (!group) {
          remaining.push(rec); // group not loaded yet — retry on next pass
          continue;
        }
        try {
          // Keep only ids still in the group; fall back to everyone.
          const known = rec.participantUserIds.filter((id) =>
            group.members.some((m) => m.userId === id),
          );
          const memberIds = known.length ? known : group.members.map((m) => m.userId);
          const shares = computeSplit(rec.amount, 'equal', memberIds);
          const shareOf = (uid: string) => shares.find((s) => s.userId === uid)?.share ?? 0;
          const splitMetadata: ExpenseSplitMetadata = {
            version: 1,
            method: 'equal',
            participantConfig: group.members.map((m) => ({
              userId: m.userId,
              included: memberIds.includes(m.userId),
              exactAmount: shareOf(m.userId),
              computedAmount: shareOf(m.userId),
            })),
          };
          const paidBy = group.members.some((m) => m.userId === rec.paidByUserId)
            ? rec.paidByUserId
            : group.members[0]?.userId ?? rec.paidByUserId;

          await addExpense(
            rec.groupId,
            {
              groupId: rec.groupId,
              title: rec.title || 'Expense',
              category: rec.category || 'General',
              amount: rec.amount,
              paidBy,
              splitType: 'equal',
              participants: shares,
              splitMetadata,
              settled: false,
              notes: '',
            },
            undefined,
            undefined,
            rec.requestId,
          );
        } catch {
          remaining.push(rec); // transient failure — retry later
        }
      }
      writePending(remaining);
    } finally {
      running.current = false;
    }
  }, [addExpense]);

  // Drain on foreground (an intent may have just queued one) ...
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void flush();
    });
    return () => sub.remove();
  }, [flush]);

  // ... and whenever groups (re)load, so a queued item commits as soon as its
  // group is available. Cheap when the queue is empty.
  useEffect(() => {
    void flush();
  }, [groups, flush]);
}
