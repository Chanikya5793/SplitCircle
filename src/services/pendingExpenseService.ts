/**
 * pendingExpenseService.ts — drains expenses AND settlements that a HEADLESS
 * Siri/Shortcuts intent created without opening the app.
 *
 * The native intents (modules/splitcircle-ai/ios/SplitCircleIntents.swift) run in the
 * app process but never boot React Native, so they can't write to Firestore/AsyncStorage
 * directly. They append compact records to two keys in `UserDefaults.standard`
 * (`SplitCirclePendingExpenses`, `SplitCirclePendingSettlements`) via
 * SplitCircleSharedStore. Those intents share the standard defaults domain with the JS
 * runtime, so react-native `Settings` reads the same bytes here. On mount, on every
 * foreground, and whenever groups load, we materialize each record into a real
 * expense/settlement through the SAME `GroupContext.addExpense` / `settleUp` the UI uses
 * — both idempotent by `requestId` and durable via the offline outbox, so replays never
 * double-write.
 *
 * The split MATH is done here by the app's real `computeParticipantsFromSplitMetadata`
 * engine (not reimplemented natively) so a Siri-entered percentage/shares/roulette split
 * matches exactly what the in-app editor would produce. A record whose group isn't
 * loaded yet is kept for the next pass. iOS-only; best-effort (never throws into React).
 */

import { useCallback, useEffect, useRef } from 'react';
import { AppState, Platform, Settings } from 'react-native';
import { useGroups } from '@/context/GroupContext';
import { computeSplit } from '@/utils/split';
import { computeParticipantsFromSplitMetadata, toParticipantShares } from '@/utils/expenseSplit';
import { resolveDisplayName } from '@/utils/identity';
import type { Participant } from '@/components/BillSplit/types';
import type { ExpenseSplitMetadata, Group, SplitType } from '@/models';

const EXPENSES_KEY = 'SplitCirclePendingExpenses';
const SETTLEMENTS_KEY = 'SplitCirclePendingSettlements';

/** One queued headless expense (contract with SplitCircleIntents.swift). */
export interface QueuedExpense {
  requestId: string;
  groupId: string;
  title: string;
  amount: number;
  category?: string;
  paidByUserId: string;
  participantUserIds: string[];
  splitMethod: string; // ExpenseSplitMethod id
  values?: Record<string, number>; // per-person numbers for non-equal methods
  rouletteLoserId?: string; // gamified: Siri-picked member who covers the bill
  createdAt: number;
}

/** One queued headless settlement. */
export interface QueuedSettlement {
  requestId: string;
  groupId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  createdAt: number;
}

function readQueue<T>(key: string): T[] {
  if (Platform.OS !== 'ios') return [];
  try {
    const raw = Settings.get(key);
    if (typeof raw !== 'string' || !raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as T[]) : [];
  } catch {
    return [];
  }
}

function writeQueue<T>(key: string, items: T[]): void {
  if (Platform.OS !== 'ios') return;
  try {
    Settings.set({ [key]: items.length ? JSON.stringify(items) : '' });
  } catch {
    // best-effort
  }
}

function methodToSplitType(method: string): SplitType {
  if (method === 'equal') return 'equal';
  if (method === 'percentage') return 'percentage';
  if (method === 'shares') return 'shares';
  return 'custom';
}

/**
 * Turn a queued expense into the exact `addExpense` payload the in-app editor would,
 * running the app's real split engine for whatever method Siri chose. Returns null if
 * the split produced no shares (shouldn't happen once members are known).
 */
function materializeExpense(rec: QueuedExpense, group: Group) {
  const method = rec.splitMethod || 'equal';
  const known = rec.participantUserIds.filter((id) => group.members.some((m) => m.userId === id));
  const memberIds = known.length ? known : group.members.map((m) => m.userId);
  const valueOf = (uid: string) => rec.values?.[uid] ?? 0;

  // Equal is the common fast path — bypass the engine.
  if (method === 'equal') {
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
    return { shares, splitType: 'equal' as SplitType, splitMetadata };
  }

  // Build the engine's Participant[] with per-person values in the right field.
  const participants: Participant[] = group.members.map((m) => {
    const included = memberIds.includes(m.userId);
    const v = valueOf(m.userId);
    return {
      id: m.userId,
      name: resolveDisplayName(m, 'Someone'),
      included,
      exactAmount: method === 'exact' ? v : 0,
      percentage: method === 'percentage' ? v : 0,
      shares: method === 'shares' ? (v || (included ? 1 : 0)) : 0,
      adjustment: method === 'adjustment' ? v : 0,
      incomeWeight: method === 'income' ? v : 0,
      daysStayed: method === 'timeBased' ? v : 0,
      partsConsumed: method === 'consumption' ? v : 0,
      rouletteWeight: 0,
      historicalPaid: 0,
      computedAmount: 0,
    };
  });

  const totalParts = participants.reduce((sum, p) => sum + p.partsConsumed, 0);
  const splitMetadata: ExpenseSplitMetadata = {
    version: 1,
    method: method as ExpenseSplitMetadata['method'],
    participantConfig: participants.map((p) => ({
      userId: p.id,
      included: p.included,
      exactAmount: p.exactAmount,
      percentage: p.percentage,
      shares: p.shares,
      adjustment: p.adjustment,
      incomeWeight: p.incomeWeight,
      daysStayed: p.daysStayed,
      partsConsumed: p.partsConsumed,
    })),
    ...(method === 'consumption' ? { totalParts } : {}),
    ...(method === 'timeBased' ? { timeSplitVariant: 'dynamic' as const } : {}),
    ...(method === 'gamified' && rec.rouletteLoserId ? { rouletteLoserId: rec.rouletteLoserId } : {}),
  };

  const computed = computeParticipantsFromSplitMetadata(rec.amount, participants, splitMetadata);
  const shares = toParticipantShares(computed);
  if (!shares.length) return null;

  // Backfill each config row's computedAmount so the stored metadata matches the shares.
  const computedMap = new Map(computed.map((c) => [c.id, c.computedAmount]));
  splitMetadata.participantConfig = splitMetadata.participantConfig.map((pc) => ({
    ...pc,
    computedAmount: computedMap.get(pc.userId) ?? 0,
  }));

  return { shares, splitType: methodToSplitType(method), splitMetadata };
}

/**
 * Wires headless expense + settlement draining for the lifetime of the signed-in nav
 * tree. Mount once (see PendingExpenseHandler in AppNavigator).
 */
export function usePendingExpenseFlush(): void {
  const { groups, addExpense, settleUp } = useGroups();
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const running = useRef(false);

  const flush = useCallback(async () => {
    if (running.current) return;
    const pendingExpenses = readQueue<QueuedExpense>(EXPENSES_KEY);
    const pendingSettlements = readQueue<QueuedSettlement>(SETTLEMENTS_KEY);
    if (!pendingExpenses.length && !pendingSettlements.length) return;
    running.current = true;
    try {
      // ── Expenses ──
      // Track which requestIds actually got handled (added, or genuinely
      // nothing-to-add) rather than building the "keep" array from this
      // pass's stale initial read. A headless Siri/Shortcuts intent can
      // append a brand-new record to the SAME UserDefaults key natively
      // while an `await addExpense(...)` below is still in flight; writing
      // back a "keep" list computed purely from the record we started with
      // would silently drop that new arrival. Re-reading fresh right before
      // the write and filtering out only the ids we actually processed
      // means it survives instead.
      const processedExpenseIds = new Set<string>();
      for (const rec of pendingExpenses) {
        const group = groupsRef.current.find((g) => g.groupId === rec.groupId);
        if (!group) continue; // group not loaded yet — retry next pass
        try {
          if (!group.members.some((m) => m.userId === rec.paidByUserId)) {
            // The Siri/Shortcuts-supplied payer left the group between the
            // intent firing and the app foregrounding. Silently reattributing
            // to an arbitrary member (previously group.members[0]) would
            // misassign real money with no way to detect it after the fact —
            // drop the record instead and log it so it's at least
            // discoverable, rather than posting a confidently wrong expense.
            console.warn(
              `pendingExpenseService: dropping queued expense ${rec.requestId} — payer ${rec.paidByUserId} is no longer a member of group ${rec.groupId}`,
            );
            processedExpenseIds.add(rec.requestId);
            continue;
          }
          const built = materializeExpense(rec, group);
          if (built) {
            await addExpense(
              rec.groupId,
              {
                groupId: rec.groupId,
                title: rec.title || 'Expense',
                category: rec.category || 'General',
                amount: rec.amount,
                paidBy: rec.paidByUserId,
                splitType: built.splitType,
                participants: built.shares,
                splitMetadata: built.splitMetadata,
                settled: false,
                notes: '',
              },
              undefined,
              undefined,
              rec.requestId,
            );
          }
          // Either materialized + added, or genuinely nothing to add — both done.
          processedExpenseIds.add(rec.requestId);
        } catch {
          // transient failure — leave queued, retry later
        }
      }
      if (processedExpenseIds.size > 0) {
        const freshExpenses = readQueue<QueuedExpense>(EXPENSES_KEY);
        writeQueue(
          EXPENSES_KEY,
          freshExpenses.filter((rec) => !processedExpenseIds.has(rec.requestId)),
        );
      }

      // ── Settlements ── (same fresh-read-before-write fix as above)
      const processedSettlementIds = new Set<string>();
      for (const rec of pendingSettlements) {
        const group = groupsRef.current.find((g) => g.groupId === rec.groupId);
        if (!group) continue;
        try {
          await settleUp(
            rec.groupId,
            { fromUserId: rec.fromUserId, toUserId: rec.toUserId, amount: rec.amount },
            rec.requestId,
          );
          processedSettlementIds.add(rec.requestId);
        } catch {
          // transient failure — leave queued, retry later
        }
      }
      if (processedSettlementIds.size > 0) {
        const freshSettlements = readQueue<QueuedSettlement>(SETTLEMENTS_KEY);
        writeQueue(
          SETTLEMENTS_KEY,
          freshSettlements.filter((rec) => !processedSettlementIds.has(rec.requestId)),
        );
      }
    } finally {
      running.current = false;
    }
  }, [addExpense, settleUp]);

  // Drain on foreground (an intent may have just queued one) ...
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void flush();
    });
    return () => sub.remove();
  }, [flush]);

  // ... and whenever groups (re)load, so a queued item commits as soon as its group is
  // available. Cheap when both queues are empty.
  useEffect(() => {
    void flush();
  }, [groups, flush]);
}
