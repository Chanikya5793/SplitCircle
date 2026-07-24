import { db } from '@/firebase';
import type { ChatMessage, ChatParticipant, Expense, ExpenseRef, ExpenseSplitMetadata, ExpenseSplitParticipantConfig, Group, GroupMember, MoneyInChatSettings, ParticipantShare, Settlement } from '@/models';
import { resolveMoneyInChat } from '@/models/group';
import { formatCurrency } from '@/utils/currency';
import { monthKey } from '@/utils/expenseAnalytics';
import { aggregateRange, budgetStatus, detectAnomalies, memberBreakdown } from '@/utils/statsInsights';
import { queueMessage } from '@/services/messageQueueService';
import {
    getRecurringBillsForGroup,
    resolveRotationPayer,
    syncRecurringBillsForGroupWithFallback,
} from '@/services/recurringBillService';
import { findHiddenLedgerGroup } from '@/services/hiddenLedgerService';
import { joinGroupByInviteCode } from '@/services/groupJoinService';
import { getRecurrenceSummary } from '@/utils/recurrence';
import { detectRecurringCandidates } from '@/utils/recurringDetection';
import { deleteFile, uploadFile } from '@/services/storageService';
import { loadCachedGroups, persistGroups } from '@/services/groupCache';
import { enqueueOp, loadOutbox, removeOp } from '@/services/outbox';
import { findDuplicateExpense, findDuplicateSettlement } from '@/utils/writeIdempotency';
import { dismissNotificationsForEntity } from '@/utils/notifications';
import { diffRemovedEntities, type GroupEntityIds } from '@/utils/notificationEntityMatch';
import { mergeOutboxIntoGroups, type OutboxOp } from '@/utils/outboxApply';
import NetInfo from '@react-native-community/netinfo';
import {
    arrayUnion,
    collection,
    deleteDoc,
    doc,
    getDocs,
    onSnapshot,
    query,
    runTransaction,
    serverTimestamp,
    setDoc,
    updateDoc,
    where,
    writeBatch,
} from 'firebase/firestore';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useAuth } from './AuthContext';

interface GroupContextValue {
  groups: Group[];
  loading: boolean;
  /** Ids of expenses/settlements written optimistically but not yet acked by
   *  the server (durable outbox). UI shows a SyncBadge for these. */
  pendingSyncIds: Set<string>;
  createGroup: (name: string, currency: string, requestId?: string) => Promise<string>;
  joinGroup: (inviteCode: string, requestId?: string) => Promise<void>;
  addExpense: (groupId: string, expense: Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>, fileUri?: string, fileName?: string, requestId?: string) => Promise<void>;
  updateExpense: (groupId: string, expense: Expense, newFileUri?: string | null, newFileName?: string, requestId?: string) => Promise<void>;
  deleteExpense: (groupId: string, expenseId: string) => Promise<void>;
  settleUp: (groupId: string, settlement: Omit<Settlement, 'settlementId' | 'createdAt' | 'status'>, requestId?: string) => Promise<void>;
  updateSettlement: (groupId: string, settlement: Settlement, requestId?: string) => Promise<void>;
  deleteSettlement: (groupId: string, settlementId: string) => Promise<void>;
  updateGroup: (groupId: string, updates: { name?: string; description?: string; photoURL?: string }) => Promise<void>;
  convertGroupCurrency: (groupId: string, newCurrency: string, rate: number) => Promise<void>;
  /** Admin-gated Money-in-Chat policy update (ai_layer/docs/21). */
  updateMoneyInChat: (groupId: string, settings: MoneyInChatSettings) => Promise<void>;
  /** Admin-gated per-category monthly budgets (ai_layer/docs/22). */
  updateGroupBudgets: (groupId: string, budgets: Record<string, number>) => Promise<void>;
  /** Idempotent "wrapped" digest card post for a completed period. */
  postGroupDigest: (
    groupId: string,
    periodKey: string,
    window: { startMs: number; endMs: number; label: string },
  ) => Promise<void>;
  /**
   * Idempotent recurring-bill card posts (ai_layer/docs/26): syncs generation,
   * then posts one stateful card per relevant occurrence (recently generated,
   * pending variable, upcoming within the T-3 window). `existingMessageIds`
   * lets the caller (chat screen) skip already-present cards — the digest
   * pattern's absence check.
   */
  postRecurringBillCards: (groupId: string, existingMessageIds: Set<string>) => Promise<void>;
  /** 1:1 recurring request accept-cards into a direct chat (doc 26 §1:1). */
  postRecurringRequestCards: (
    friendUserId: string,
    chatId: string,
    participantIds: string[],
    existingMessageIds: Set<string>,
  ) => Promise<void>;
  updateMemberRole: (groupId: string, userId: string, role: 'admin' | 'member') => Promise<void>;
  removeMember: (groupId: string, userId: string) => Promise<void>;
  leaveGroup: (groupId: string) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
}

const GroupContext = createContext<GroupContextValue | undefined>(undefined);

const normalizeTimestamp = (value: unknown): number => {
  if (!value) return Date.now();
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null) {
    const maybeTimestamp = value as { toMillis?: () => number; seconds?: number };
    if (maybeTimestamp.toMillis) {
      return maybeTimestamp.toMillis();
    }
    if (typeof maybeTimestamp.seconds === 'number') {
      return maybeTimestamp.seconds * 1000;
    }
  }
  return Date.now();
};

const stripUndefinedDeep = <T,>(value: T): T => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripUndefinedDeep(entry))
      .filter((entry) => entry !== undefined) as T;
  }

  if (value && typeof value === 'object') {
    const sanitizedEntries = Object.entries(value as Record<string, unknown>)
      .flatMap(([key, entry]) => {
        const sanitizedEntry = stripUndefinedDeep(entry);
        return sanitizedEntry === undefined ? [] : [[key, sanitizedEntry] as const];
      });

    return Object.fromEntries(sanitizedEntries) as T;
  }

  return value;
};

const adaptGroup = (data: Group): Group => {
  const expenses = (data.expenses ?? []).map((expense) => ({
    ...expense,
    createdAt: normalizeTimestamp((expense as Expense).createdAt),
    updatedAt: normalizeTimestamp((expense as Expense).updatedAt),
  }));

  // Calculate balances dynamically. Seed the balance map with BOTH active
  // members and archived members so removed/left users still get a balance
  // entry. Without this, archived users would have zeroed balances even if
  // they still owe or are owed money on historical expenses.
  const memberBalances: Record<string, number> = {};
  (data.members ?? []).forEach((m) => (memberBalances[m.userId] = 0));
  (data.archivedMembers ?? []).forEach((m) => {
    if (memberBalances[m.userId] === undefined) memberBalances[m.userId] = 0;
  });

  expenses.forEach((expense) => {
    const paidAmount = expense.amount;
    memberBalances[expense.paidBy] = (memberBalances[expense.paidBy] ?? 0) + paidAmount;
    expense.participants.forEach((p) => {
      memberBalances[p.userId] = (memberBalances[p.userId] ?? 0) - p.share;
    });
  });

  (data.settlements ?? []).forEach((settlement) => {
    memberBalances[settlement.fromUserId] = (memberBalances[settlement.fromUserId] ?? 0) + settlement.amount;
    memberBalances[settlement.toUserId] = (memberBalances[settlement.toUserId] ?? 0) - settlement.amount;
  });

  return {
    ...data,
    expenses,
    members: (data.members ?? []).map((m) => ({
      ...m,
      balance: memberBalances[m.userId] ?? 0,
    })),
    archivedMembers: (data.archivedMembers ?? []).map((m) => ({
      ...m,
      archived: true,
      balance: memberBalances[m.userId] ?? 0,
    })),
    settlements: (data.settlements ?? []).map((settlement) => ({
      ...settlement,
      createdAt: normalizeTimestamp((settlement as Settlement).createdAt),
    })),
  };
};

const collectGroupEntityIds = (groupList: Group[]): Map<string, GroupEntityIds> => {
  const map = new Map<string, GroupEntityIds>();
  for (const group of groupList) {
    map.set(group.groupId, {
      expenseIds: new Set((group.expenses ?? []).map((e) => e.expenseId)),
      settlementIds: new Set((group.settlements ?? []).map((s) => s.settlementId)),
    });
  }
  return map;
};

/**
 * Compares the previous server snapshot with the current one and withdraws
 * delivered notifications that deep-link to anything that disappeared:
 * whole groups (deleted, or this user removed) and individual
 * expenses/settlements removed from surviving groups. Best-effort.
 */
const dismissNotificationsForRemovedEntities = (
  previous: Map<string, GroupEntityIds>,
  current: Map<string, GroupEntityIds>,
): void => {
  for (const filter of diffRemovedEntities(previous, current)) {
    void dismissNotificationsForEntity(filter);
  }
};

export const GroupProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { user } = useAuth();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  // Server-confirmed entity ids from the previous snapshot. When a group or
  // expense vanishes between snapshots (deleted by someone else), we clear any
  // delivered notifications on THIS device that deep-link to it. null until
  // the first server snapshot arrives — cached/offline data must not trigger
  // dismissals.
  const knownEntityIdsRef = useRef<Map<string, GroupEntityIds> | null>(null);

  // Durable offline write queue. Writes made offline are mirrored to AsyncStorage
  // (services/outbox) so they survive an app-kill, kept visible optimistically,
  // and replayed on launch / reconnect. `pendingOpsRef` mirrors the queue so the
  // snapshot listener can keep not-yet-synced writes from flickering out.
  const pendingOpsRef = useRef<OutboxOp[]>([]);
  const flushingRef = useRef(false);
  const [pendingSyncIds, setPendingSyncIds] = useState<Set<string>>(new Set());

  /** Recompute the reactive id set after any pendingOpsRef mutation. */
  const refreshPendingIds = useCallback(() => {
    const ids = new Set<string>();
    for (const op of pendingOpsRef.current) {
      ids.add(op.kind === 'addExpense' ? op.expense.expenseId : op.settlement.settlementId);
    }
    setPendingSyncIds((prev) => {
      if (prev.size === ids.size && [...ids].every((id) => prev.has(id))) return prev;
      return ids;
    });
  }, []);

  /** Perform the network write for one queued op (idempotent via arrayUnion). */
  const writeOp = useCallback(async (op: OutboxOp): Promise<void> => {
    if (op.kind === 'addExpense') {
      let expense = op.expense;
      if (op.fileUri) {
        try {
          const fileName = op.fileName ?? 'receipt.jpg';
          const url = await uploadFile(op.fileUri, `groups/${op.groupId}/expenses/${op.expense.expenseId}/${fileName}`);
          expense = { ...op.expense, receipt: stripUndefinedDeep({ ...op.expense.receipt, url, fileName }) };
        } catch {
          // Image upload failed (e.g. the local file is gone after a relaunch) —
          // still write the expense so the money data isn't lost.
        }
      }
      await updateDoc(doc(db, 'groups', op.groupId), {
        expenses: arrayUnion(expense),
        updatedAt: serverTimestamp(),
      });
      await setDoc(doc(db, 'expenses', op.expense.expenseId), {
        ...expense,
        groupId: op.groupId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } else {
      await updateDoc(doc(db, 'groups', op.groupId), {
        settlements: arrayUnion(op.settlement),
        updatedAt: serverTimestamp(),
      });
    }
  }, []);

  /**
   * Drain the outbox to the cloud. Single-writer (mutex) so a write is never
   * issued twice concurrently. Only attempts when online — offline, Firestore
   * write promises never resolve, so we keep the ops and retry on reconnect.
   */
  const flushOutbox = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      const net = await NetInfo.fetch();
      if (!(net.isConnected && net.isInternetReachable !== false)) return;
      let guard = 0;
      while (guard++ < 100) {
        const ops = await loadOutbox();
        pendingOpsRef.current = ops;
        refreshPendingIds();
        if (!ops.length) break;
        let progressed = false;
        for (const op of ops) {
          try {
            await writeOp(op);
            await removeOp(op.id);
            pendingOpsRef.current = pendingOpsRef.current.filter((o) => o.id !== op.id);
            refreshPendingIds();
            progressed = true;
          } catch (error) {
            console.warn('Outbox flush deferred for op', op.id, error);
            progressed = false;
            break;
          }
        }
        if (!progressed) break;
      }
    } finally {
      flushingRef.current = false;
    }
  }, [writeOp, refreshPendingIds]);

  useEffect(() => {
    if (!user) {
      setGroups([]);
      setLoading(false);
      pendingOpsRef.current = [];
      knownEntityIdsRef.current = null;
      refreshPendingIds();
      return () => undefined;
    }

    const uid = user.userId;
    let active = true;

    // Hydrate from the on-device cache first so the app shows data instantly and
    // works offline (Firestore JS SDK can't persist on RN). Live data wins below.
    void loadCachedGroups(uid).then((cached) => {
      if (active && cached) {
        setGroups((prev) => (prev.length ? prev : cached));
        setLoading(false);
      }
    });

    // Replay any durable writes left over from a previous (offline) session, and
    // flush again whenever connectivity returns.
    void loadOutbox().then((ops) => {
      if (!active) return;
      pendingOpsRef.current = ops;
      refreshPendingIds();
      void flushOutbox();
    });
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) void flushOutbox();
    });

    const groupsRef = collection(db, 'groups');
    const q = query(groupsRef, where('memberIds', 'array-contains', uid));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const raw = snapshot.docs.map((docSnapshot) => docSnapshot.data() as Group);
        // Keep optimistic (not-yet-acked) writes visible until the server confirms them.
        const payload = mergeOutboxIntoGroups(raw, pendingOpsRef.current).map(adaptGroup);

        // Withdraw delivered notifications for anything deleted since the last
        // server snapshot (group deleted by another member, expense removed,
        // …). Compared against raw server data so optimistic local writes
        // never look like deletions.
        const currentEntityIds = collectGroupEntityIds(raw);
        if (knownEntityIdsRef.current) {
          dismissNotificationsForRemovedEntities(knownEntityIdsRef.current, currentEntityIds);
        }
        knownEntityIdsRef.current = currentEntityIds;

        setGroups(payload);
        setLoading(false);
        void persistGroups(uid, payload); // keep the offline cache fresh
      },
      (error) => {
        // Without this handler a rules rejection (e.g. permission-denied)
        // becomes an uncaught snapshot error and a full-screen dev crash.
        // Cached groups (hydrated above) remain visible.
        console.warn('Groups subscription failed; showing cached data.', error);
        setLoading(false);
      }
    );

    return () => {
      active = false;
      unsubscribe();
      unsubscribeNet();
    };
  }, [user?.userId, flushOutbox, refreshPendingIds]);

  const createGroup = async (name: string, currency: string, requestId?: string) => {
    if (!user) throw new Error('Missing user');
    const groupId = requestId ?? uuid();
    await setDoc(doc(db, 'groups', groupId), {
      groupId,
      requestId: requestId ?? groupId,
      name,
      currency,
      inviteCode: groupId.slice(0, 6).toUpperCase(),
      members: [
        {
          userId: user.userId,
          displayName: user.displayName,
          photoURL: user.photoURL,
          role: 'owner',
          balance: 0,
        },
      ],
      memberIds: [user.userId],
      expenses: [],
      settlements: [],
      createdBy: user.userId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return groupId;
  };

  // Runs entirely server-side (joinGroupByInviteCode Cloud Function) — the
  // invite-code lookup is a where('inviteCode', '==', code) query against
  // groups, whose read rule requires pre-existing membership, which a
  // non-member can never satisfy. Firestore evaluates rules against a
  // query's potential result set, not its actual matches, so it rejects the
  // query outright regardless of data — no client-side rule tweak fixes
  // this. See the CLAUDE.md gotcha on this. The Cloud Function performs the
  // same writes (memberIds/members/archivedMembers, chat participant
  // fan-out, RTDB system message) the old direct client write used to.
  const joinGroup = async (inviteCode: string, requestId?: string) => {
    if (!user) throw new Error('Missing user');
    await joinGroupByInviteCode(inviteCode, requestId);
  };

  const addExpense = async (
    groupId: string,
    expense: Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>,
    fileUri?: string,
    originalFileName?: string,
    requestId?: string,
  ) => {
    const expenseId = requestId ?? expense.requestId ?? uuid();
    const reqId = requestId ?? expense.requestId ?? expenseId;

    // Idempotency without a server read (works offline): if this expense (by id
    // or requestId) is already in local state, it's a retry/double-submit — no-op.
    const localGroup = groups.find((g) => g.groupId === groupId);
    if (findDuplicateExpense(localGroup?.expenses, expenseId, reqId)) {
      return;
    }

    // Use the participants calculated by the UI, which handles rounding correctly.
    const splitShares: ParticipantShare[] = expense.participants;
    const newExpense = stripUndefinedDeep({
      ...expense,
      expenseId,
      requestId: reqId,
      participants: splitShares,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(expense.receipt ? { receipt: stripUndefinedDeep(expense.receipt) } : {}),
    }) as Expense;

    let fileName = originalFileName;
    if (fileUri && !fileName) {
      const extension = fileUri.split('.').pop()?.split('?')[0] || 'jpg';
      fileName = `receipt.${extension}`;
    }

    // Queue durably FIRST so the write survives an app-kill while offline, then
    // reflect it immediately. The actual network write happens in flushOutbox so
    // the UI never blocks on a server ack (offline, write promises never resolve).
    const op: OutboxOp = { id: expenseId, kind: 'addExpense', groupId, expense: newExpense, fileUri, fileName, createdAt: Date.now() };
    await enqueueOp(op);
    pendingOpsRef.current = [...pendingOpsRef.current.filter((o) => o.id !== op.id), op];
    refreshPendingIds();

    setGroups((prev) => {
      const next = mergeOutboxIntoGroups(prev, [op]).map(adaptGroup);
      if (user) void persistGroups(user.userId, next);
      return next;
    });

    void flushOutbox();

    postExpenseCard(localGroup, groupId, newExpense);
    maybePostBudgetAlert(localGroup, groupId, newExpense);
    maybePostAnomalyAlert(localGroup, groupId, newExpense);
  };

  const updateExpense = async (groupId: string, updatedExpense: Expense, newFileUri?: string | null, newFileName?: string, requestId?: string) => {
    try {
      const group = groups.find((g) => g.groupId === groupId);
      if (!group) throw new Error('Group not found');

      let receipt = updatedExpense.receipt;

      if (newFileUri !== undefined) {
        // If explicitly null, delete existing image
        if (newFileUri === null && receipt?.url) {
          // Try to guess path from previous filename or default
          const fileName = receipt.fileName || 'receipt.jpg';
          const path = `groups/${groupId}/expenses/${updatedExpense.expenseId}/${fileName}`;
          await deleteFile(path);
          receipt = undefined;
        } else if (newFileUri) {
          // If there was an old file, and the new filename is different, we should delete the old one
          if (receipt?.fileName && newFileName && receipt.fileName !== newFileName) {
            const oldPath = `groups/${groupId}/expenses/${updatedExpense.expenseId}/${receipt.fileName}`;
            await deleteFile(oldPath);
          }

          let fileName = newFileName;
          if (!fileName) {
            const extension = newFileUri.split('.').pop()?.split('?')[0] || 'jpg';
            fileName = `receipt.${extension}`;
          }

          const path = `groups/${groupId}/expenses/${updatedExpense.expenseId}/${fileName}`;
          const url = await uploadFile(newFileUri, path);
          // Preserve insights/other receipt metadata across the image swap.
          receipt = { ...updatedExpense.receipt, url, fileName };
        }
      }

      const finalExpense = stripUndefinedDeep({
        ...updatedExpense,
        requestId: requestId ?? updatedExpense.requestId ?? updatedExpense.expenseId,
        updatedAt: Date.now(),
      });

      if (receipt) {
        finalExpense.receipt = stripUndefinedDeep(receipt);
      } else {
        // If receipt is undefined/null, ensure it's removed if it existed
        delete finalExpense.receipt;
      }

      const updatedExpenses = group.expenses.map((exp) =>
        exp.expenseId === finalExpense.expenseId ? finalExpense : exp
      );

      const docRef = doc(db, 'groups', groupId);
      await updateDoc(docRef, {
        expenses: updatedExpenses,
        updatedAt: serverTimestamp(),
      });

      await setDoc(doc(db, 'expenses', finalExpense.expenseId), {
        ...finalExpense,
        groupId,
        updatedAt: serverTimestamp(),
      }, { merge: true });

      // Best-effort cleanup of legacy top-level expense docs whose doc ID
      // predates the expenseId-as-doc-ID convention. Its own try/catch for the
      // same reason as deleteExpense's identical block below: the query is
      // unscoped by groupId (it can't be — the whole point is finding docs
      // under a DIFFERENT id), so firestore.rules' per-document
      // `isGroupMemberById(resource.data.groupId)` check can't be statically
      // satisfied for a collection-wide `list`, and Firestore correctly denies
      // it every time. That's expected, not a real failure — it must never
      // surface as "Failed to save expense" after the actual update above
      // (the group doc update + primary expense doc write) already succeeded.
      try {
        const q = query(collection(db, 'expenses'), where('expenseId', '==', finalExpense.expenseId));
        const snapshot = await getDocs(q);
        await Promise.all(snapshot.docs.map(async (docSnap) => {
          if (docSnap.id === finalExpense.expenseId) {
            return;
          }

          await updateDoc(doc(db, 'expenses', docSnap.id), {
            ...finalExpense,
            updatedAt: serverTimestamp(),
          });
        }));
      } catch (legacyCleanupError) {
        console.warn('Legacy expense doc cleanup skipped (non-fatal):', legacyCleanupError);
      }
    } catch (error) {
      console.error('Error updating expense:', error);
      throw error;
    }
  };

  const deleteExpense = async (groupId: string, expenseId: string) => {
    try {
      const group = groups.find((g) => g.groupId === groupId);
      if (!group) throw new Error('Group not found');

      const expenseToDelete = group.expenses.find((exp) => exp.expenseId === expenseId);
      if (expenseToDelete?.receipt?.url) {
        const fileName = expenseToDelete.receipt.fileName || 'receipt.jpg';
        const path = `groups/${groupId}/expenses/${expenseId}/${fileName}`;
        await deleteFile(path);
      }

      const updatedExpenses = group.expenses.filter((exp) => exp.expenseId !== expenseId);

      const docRef = doc(db, 'groups', groupId);
      await updateDoc(docRef, {
        expenses: updatedExpenses,
        updatedAt: serverTimestamp(),
      });

      await deleteDoc(doc(db, 'expenses', expenseId));

      // Withdraw any delivered notification that deep-links to this expense
      // on this device (other members' devices clear via the snapshot diff).
      void dismissNotificationsForEntity({ expenseId });

      // Best-effort cleanup of legacy top-level expense docs whose doc ID
      // predates the expenseId-as-doc-ID convention. This is its own try/catch
      // because the query is unscoped by groupId (it can't be — the whole
      // point is finding docs under a DIFFERENT id), so firestore.rules'
      // per-document `isGroupMemberById(resource.data.groupId)` check can't be
      // statically satisfied for a collection-wide `list`, and Firestore
      // correctly denies it every time. That's expected, not a real failure —
      // it must never surface as "Failed to delete expense" after the actual
      // deletion above (the group update + primary doc delete) already
      // succeeded.
      try {
        const q = query(collection(db, 'expenses'), where('expenseId', '==', expenseId));
        const snapshot = await getDocs(q);
        await Promise.all(snapshot.docs.map(async (docSnap) => {
          if (docSnap.id === expenseId) {
            return;
          }

          await deleteDoc(doc(db, 'expenses', docSnap.id));
        }));
      } catch (legacyCleanupError) {
        console.warn('Legacy expense doc cleanup skipped (non-fatal):', legacyCleanupError);
      }
    } catch (error) {
      console.error('Error deleting expense:', error);
      throw error;
    }
  };


  const settleUp = async (
    groupId: string,
    settlement: Omit<Settlement, 'settlementId' | 'createdAt' | 'status'>,
    requestId?: string,
  ) => {
    const settlementId = requestId ?? settlement.requestId ?? uuid();
    const reqId = requestId ?? settlement.requestId ?? settlementId;

    // Idempotent, offline-capable (same pattern as addExpense): skip if already present.
    const localGroup = groups.find((g) => g.groupId === groupId);
    if (findDuplicateSettlement(localGroup?.settlements, settlementId, reqId)) {
      return;
    }

    const newSettlement = stripUndefinedDeep({
      ...settlement,
      settlementId,
      requestId: reqId,
      createdAt: Date.now(),
      status: 'pending' as const,
    }) as Settlement;

    // Durable queue + optimistic display; the network write happens in flushOutbox.
    const op: OutboxOp = { id: settlementId, kind: 'settleUp', groupId, settlement: newSettlement, createdAt: Date.now() };
    await enqueueOp(op);
    pendingOpsRef.current = [...pendingOpsRef.current.filter((o) => o.id !== op.id), op];
    refreshPendingIds();

    setGroups((prev) => {
      const next = mergeOutboxIntoGroups(prev, [op]).map(adaptGroup);
      if (user) void persistGroups(user.userId, next);
      return next;
    });

    void flushOutbox();

    postSettlementCard(localGroup, groupId, newSettlement);
  };

  const updateSettlement = async (groupId: string, updatedSettlement: Settlement, requestId?: string) => {
    try {
      const group = groups.find((g) => g.groupId === groupId);
      if (!group) throw new Error('Group not found');

      const updatedSettlements = group.settlements.map((settlement) =>
        settlement.settlementId === updatedSettlement.settlementId
          ? {
              ...updatedSettlement,
              requestId: requestId ?? updatedSettlement.requestId ?? updatedSettlement.settlementId,
            }
          : settlement
      );

      const docRef = doc(db, 'groups', groupId);
      await updateDoc(docRef, {
        settlements: updatedSettlements,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error('Error updating settlement:', error);
      throw error;
    }
  };

  const deleteSettlement = async (groupId: string, settlementId: string) => {
    try {
      const group = groups.find((g) => g.groupId === groupId);
      if (!group) throw new Error('Group not found');

      const updatedSettlements = group.settlements.filter((s) => s.settlementId !== settlementId);

      const docRef = doc(db, 'groups', groupId);
      await updateDoc(docRef, {
        settlements: updatedSettlements,
        updatedAt: serverTimestamp(),
      });

      // Withdraw any delivered notification that deep-links to this
      // settlement on this device.
      void dismissNotificationsForEntity({ settlementId });
    } catch (error) {
      console.error('Error deleting settlement:', error);
      throw error;
    }
  };

  // ──────────────────────────────────────────────────────────────────────
  // Group admin operations
  //
  // All of the following enforce role-based authorization client-side AND
  // emit a system message into the linked chat thread so chat groups stay
  // in sync. Real authorization MUST be enforced by Firestore Security Rules
  // — these client checks only protect the UX, not the data.
  // ──────────────────────────────────────────────────────────────────────

  const writeGroupSystemMessage = async (
    groupId: string,
    content: string,
    options: {
      participantsOverride?: ChatParticipant[];
      participantIdsOverride?: string[];
      /** Money-in-chat: turn the system line into a typed card (type/expenseRef). */
      messageOverrides?: Partial<Pick<ChatMessage, 'type' | 'expenseRef'>>;
      /**
       * Deterministic message id (digest/alert idempotency): concurrent posts
       * from several members converge on ONE message in RTDB + local stores.
       */
      fixedMessageId?: string;
    } = {},
  ) => {
    if (!user) return;
    try {
      // Query by MY participation, not by groupId: the chats read rule requires
      // `auth.uid in participantIds`, and a groupId-only query can't prove that
      // (Firestore "rules are not filters") — it dies with permission-denied.
      // array-contains(uid) is provably safe and needs no composite index; the
      // group match happens client-side over the user's own chats.
      const chatsRef = collection(db, 'chats');
      const chatQ = query(chatsRef, where('participantIds', 'array-contains', user.userId));
      const chatSnap = await getDocs(chatQ);
      const chatDoc = chatSnap.docs.find((d) => (d.data() as { groupId?: string }).groupId === groupId);
      if (!chatDoc) return;
      const chatId = chatDoc.id;
      const chatData = chatDoc.data() as Record<string, unknown>;

      const baseParticipants =
        options.participantsOverride ?? ((chatData.participants as ChatParticipant[] | undefined) ?? []);
      const baseParticipantIds =
        options.participantIdsOverride ?? ((chatData.participantIds as string[] | undefined) ?? []);

      const msgId = options.fixedMessageId ?? uuid();
      const now = Date.now();
      const systemMessage: ChatMessage = {
        id: msgId,
        messageId: msgId,
        requestId: msgId,
        chatId,
        senderId: user.userId,
        type: 'system',
        content,
        status: 'sent',
        createdAt: now,
        timestamp: now,
        isFromMe: false,
        deliveredTo: [],
        readBy: [],
        ...options.messageOverrides,
      };

      const updatePayload: Record<string, unknown> = {
        lastMessage: { ...systemMessage, createdAt: serverTimestamp() },
        updatedAt: serverTimestamp(),
      };

      if (options.participantsOverride !== undefined) {
        updatePayload.participants = baseParticipants;
      }
      if (options.participantIdsOverride !== undefined) {
        updatePayload.participantIds = baseParticipantIds;
      }

      await updateDoc(chatDoc.ref, updatePayload);

      for (const recipientId of baseParticipantIds) {
        try {
          await queueMessage(recipientId, systemMessage, true);
        } catch (error) {
          console.error(`Failed to queue system message for ${recipientId}:`, error);
        }
      }
    } catch (error) {
      // Group admin actions must never fail because of a chat sync error —
      // the source of truth is the group doc; the chat is best-effort.
      console.warn('writeGroupSystemMessage failed', error);
    }
  };

  /**
   * Direct-chat variant of writeGroupSystemMessage (doc 26 §1:1): posts a
   * typed card into a KNOWN chat (no group→chat lookup — direct threads have
   * no groupId). Same idempotency contract: a fixedMessageId converges
   * concurrent posts on one message.
   */
  const writeDirectCardMessage = async (
    chatId: string,
    participantIds: string[],
    content: string,
    options: {
      messageOverrides?: Partial<Pick<ChatMessage, 'type' | 'expenseRef'>>;
      fixedMessageId?: string;
    } = {},
  ) => {
    if (!user) return;
    try {
      const msgId = options.fixedMessageId ?? uuid();
      const now = Date.now();
      const systemMessage: ChatMessage = {
        id: msgId,
        messageId: msgId,
        requestId: msgId,
        chatId,
        senderId: user.userId,
        type: 'system',
        content,
        status: 'sent',
        createdAt: now,
        timestamp: now,
        isFromMe: false,
        deliveredTo: [],
        readBy: [],
        ...options.messageOverrides,
      };
      await updateDoc(doc(db, 'chats', chatId), {
        lastMessage: { ...systemMessage, createdAt: serverTimestamp() },
        updatedAt: serverTimestamp(),
      });
      for (const recipientId of participantIds) {
        try {
          await queueMessage(recipientId, systemMessage, false);
        } catch (error) {
          console.error(`Failed to queue direct card for ${recipientId}:`, error);
        }
      }
    } catch (error) {
      console.warn('writeDirectCardMessage failed', error);
    }
  };

  // ── Money-in-chat auto-post (ai_layer/docs/21) ─────────────────────────────
  // Best-effort card into the linked group chat. Honors the admin autoPost
  // policy ('cards' → typed card, 'compact' → plain system line, 'off' → skip)
  // and NEVER blocks or fails the money write itself — the group doc is the
  // source of truth, the chat is a mirror.

  const memberName = (group: Group | undefined, userId: string): string =>
    [...(group?.members ?? []), ...(group?.archivedMembers ?? [])].find((m) => m.userId === userId)
      ?.displayName ?? 'Someone';

  const postExpenseCard = (group: Group | undefined, groupId: string, expense: Expense) => {
    const policy = resolveMoneyInChat(group?.moneyInChat).autoPost;
    if (policy === 'off') return;
    const payerName = memberName(group, expense.paidBy);
    const content = `💸 ${expense.title} · ${formatCurrency(expense.amount, group?.currency)} paid by ${payerName}`;
    const ref: ExpenseRef = {
      kind: 'expense',
      groupId,
      refId: expense.expenseId,
      snapshot: {
        title: expense.title,
        amount: expense.amount,
        currency: group?.currency ?? 'USD',
        payerName,
        payerId: expense.paidBy,
        participantCount: expense.participants.length,
        ...(expense.category ? { category: expense.category } : {}),
      },
    };
    void writeGroupSystemMessage(
      groupId,
      content,
      policy === 'cards' ? { messageOverrides: { type: 'expense', expenseRef: ref } } : {},
    );
  };

  const postSettlementCard = (group: Group | undefined, groupId: string, settlement: Settlement) => {
    const policy = resolveMoneyInChat(group?.moneyInChat).autoPost;
    if (policy === 'off') return;
    const fromName = memberName(group, settlement.fromUserId);
    const toName = memberName(group, settlement.toUserId);
    const content = `✅ ${fromName} paid ${toName} ${formatCurrency(settlement.amount, group?.currency)}`;
    const ref: ExpenseRef = {
      kind: 'settlement',
      groupId,
      refId: settlement.settlementId,
      snapshot: {
        title: 'Settlement',
        amount: settlement.amount,
        currency: group?.currency ?? 'USD',
        payerName: fromName,
        payerId: settlement.fromUserId,
        participantCount: 2,
        toName,
        toUserId: settlement.toUserId,
      },
    };
    void writeGroupSystemMessage(
      groupId,
      content,
      policy === 'cards' ? { messageOverrides: { type: 'expense', expenseRef: ref } } : {},
    );
  };

  // ── Insights → chat (ai_layer/docs/22): digests, budget alerts, anomalies ──

  /**
   * Post the previous period's "wrapped" digest card (idempotent via a
   * deterministic message id — any member can trigger it, one card results).
   * Called by ChatRoomScreen when it sees the digest is due and absent.
   */
  const postGroupDigest = async (groupId: string, periodKey: string, window: { startMs: number; endMs: number; label: string }) => {
    const group = groups.find((g) => g.groupId === groupId);
    if (!group) return;
    const settings = resolveMoneyInChat(group.moneyInChat);
    if (settings.insights.digestCadence === 'off') return;

    const agg = aggregateRange(group.expenses ?? [], window, user?.userId ?? '');
    if (agg.count === 0) return; // Nothing to wrap.
    const topCategory = agg.byCategory[0]?.category;
    const { rows } = memberBreakdown(group.expenses ?? [], group.members ?? [], window);
    const topPayer = rows[0];

    const title = `${window.label} wrapped`;
    const content = `📊 ${title} · ${formatCurrency(agg.total, group.currency)} across ${agg.count} expense${agg.count === 1 ? '' : 's'}${topCategory ? ` · Top: ${topCategory}` : ''}`;
    const ref: ExpenseRef = {
      kind: 'digest',
      groupId,
      refId: periodKey,
      snapshot: {
        title,
        amount: agg.total,
        currency: group.currency ?? 'USD',
        payerName: topPayer?.name ?? '',
        payerId: topPayer?.userId ?? '',
        participantCount: agg.count,
        ...(topCategory ? { category: topCategory } : {}),
      },
    };
    await writeGroupSystemMessage(groupId, content, {
      messageOverrides: { type: 'expense', expenseRef: ref },
      fixedMessageId: `digest-${groupId}-${periodKey}`,
    });
  };

  // ── Recurring-bill cards (ai_layer/docs/26) ────────────────────────────────
  // Digest pattern: any member who opens the chat triggers generation sync,
  // then posts the missing occurrence cards with deterministic message ids —
  // concurrent posts from several members converge on ONE card. The card is
  // STATEFUL by pointer: it renders upcoming → due → generated → settled from
  // live group data, so it is posted once per occurrence and never edited.

  const RECENT_GENERATED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const PENDING_CARD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  const UPCOMING_LEAD_MS = 3 * 24 * 60 * 60 * 1000; // T-3, monthly+ bills only

  const postRecurringBillCards = async (groupId: string, existingMessageIds: Set<string>) => {
    const group = groups.find((g) => g.groupId === groupId);
    if (!group) return;
    const policy = resolveMoneyInChat(group.moneyInChat).autoPost;
    if (policy === 'off') return;

    try {
      // Generation first (idempotent server/client dual path) so a just-due
      // fixed bill's card renders "generated", not a stale "due".
      await syncRecurringBillsForGroupWithFallback(groupId);
      const bills = await getRecurringBillsForGroup(groupId);
      const now = Date.now();

      for (const bill of bills) {
        const isVariable = bill.amountMode === 'variable';
        const leadMs =
          bill.recurrenceRule.frequency === 'monthly' || bill.recurrenceRule.frequency === 'yearly'
            ? UPCOMING_LEAD_MS
            : 0;

        const occurrences = new Set<number>();
        if (bill.lastGeneratedAt && now - bill.lastGeneratedAt <= RECENT_GENERATED_WINDOW_MS) {
          occurrences.add(bill.lastGeneratedAt);
        }
        for (const pendingAt of bill.pendingOccurrences ?? []) {
          if (now - pendingAt <= PENDING_CARD_WINDOW_MS) occurrences.add(pendingAt);
        }
        if (bill.isActive && leadMs > 0 && bill.nextDueAt > now && bill.nextDueAt - now <= leadMs) {
          occurrences.add(bill.nextDueAt);
        }

        for (const occurrenceAt of occurrences) {
          const messageId = `recbill-${bill.billId}-${occurrenceAt}`;
          if (existingMessageIds.has(messageId)) continue;

          const payerId = resolveRotationPayer(bill);
          const payerName = memberName(group, payerId);
          const summary = getRecurrenceSummary(bill.recurrenceRule);
          const content = `🔁 ${bill.title} · ${summary}${
            isVariable ? '' : ` · ${formatCurrency(bill.amount, group.currency)}`
          }`;
          const ref: ExpenseRef = {
            kind: 'recurringBill',
            groupId,
            refId: bill.billId,
            occurrenceAt,
            snapshot: {
              title: bill.title,
              amount: isVariable ? 0 : bill.amount,
              currency: group.currency ?? 'USD',
              payerName,
              payerId,
              participantCount: bill.participants.length,
              ...(bill.category ? { category: bill.category } : {}),
              recurrenceSummary: summary,
              ...(isVariable ? { variable: true } : {}),
            },
          };
          await writeGroupSystemMessage(
            groupId,
            content,
            policy === 'cards'
              ? { messageOverrides: { type: 'expense', expenseRef: ref }, fixedMessageId: messageId }
              : { fixedMessageId: messageId },
          );
        }
      }
      // Detection surface (c) — doc 26: the bot suggests the strongest
      // recurring-looking pattern not yet set up. The deterministic message id
      // doubles as the once-per-cluster-EVER rate limit (messages are
      // permanent locally, so a seen suggestion never re-posts).
      const candidate = detectRecurringCandidates(group.expenses ?? [], {
        excludeKeys: bills.map((b) => b.title),
      })[0];
      if (candidate) {
        const suggestionId = `recsuggest-${groupId}-${candidate.key.replace(/\s+/g, '_')}`;
        if (!existingMessageIds.has(suggestionId)) {
          await writeGroupSystemMessage(
            groupId,
            `🔁 "${candidate.title}" has been added ${candidate.occurrenceCount} times on a ${candidate.cadence} rhythm — set it up as a recurring bill and it handles itself. Recurring Bills → New.`,
            { fixedMessageId: suggestionId },
          );
        }
      }
    } catch (error) {
      // Cards are a mirror — never let them break chat open or generation.
      console.warn('postRecurringBillCards failed', error);
    }
  };

  /**
   * 1:1 recurring request cards (doc 26): from a DIRECT chat, sync the hidden
   * ledger's bills and post an accept card per parked occurrence. Same digest
   * pattern — deterministic `recreq-<billId>-<occurrenceAt>` ids, caller
   * passes the already-present message ids.
   */
  const postRecurringRequestCards = async (
    friendUserId: string,
    chatId: string,
    participantIds: string[],
    existingMessageIds: Set<string>,
  ) => {
    if (!user) return;
    const ledger = findHiddenLedgerGroup(groups, user.userId, friendUserId);
    if (!ledger) return;
    try {
      await syncRecurringBillsForGroupWithFallback(ledger.groupId);
      const bills = await getRecurringBillsForGroup(ledger.groupId);
      const now = Date.now();
      for (const bill of bills) {
        if (bill.requiresAccept !== true) continue;
        for (const occurrenceAt of bill.pendingOccurrences ?? []) {
          if (now - occurrenceAt > PENDING_CARD_WINDOW_MS) continue;
          const messageId = `recreq-${bill.billId}-${occurrenceAt}`;
          if (existingMessageIds.has(messageId)) continue;
          const payerId = resolveRotationPayer(bill);
          const payerName = memberName(ledger, payerId);
          const summary = getRecurrenceSummary(bill.recurrenceRule);
          const ref: ExpenseRef = {
            kind: 'recurringRequest',
            groupId: ledger.groupId,
            refId: bill.billId,
            occurrenceAt,
            snapshot: {
              title: bill.title,
              amount: bill.amount,
              currency: ledger.currency ?? 'USD',
              payerName,
              payerId,
              participantCount: bill.participants.length,
              ...(bill.category ? { category: bill.category } : {}),
              recurrenceSummary: summary,
            },
          };
          await writeDirectCardMessage(
            chatId,
            participantIds,
            `🔁 ${bill.title} · ${summary} · ${formatCurrency(bill.amount, ledger.currency)} — awaiting accept`,
            { messageOverrides: { type: 'expense', expenseRef: ref }, fixedMessageId: messageId },
          );
        }
      }
    } catch (error) {
      console.warn('postRecurringRequestCards failed', error);
    }
  };

  /** Budget-crossing alert card (80% / 100%), idempotent per month+category+threshold. */
  const maybePostBudgetAlert = (group: Group | undefined, groupId: string, expense: Expense) => {
    if (!group?.budgets) return;
    const settings = resolveMoneyInChat(group.moneyInChat);
    if (!settings.insights.budgetAlerts) return;
    const now = Date.now();
    const before = budgetStatus(group.budgets, group.expenses ?? [], now);
    const after = budgetStatus(group.budgets, [...(group.expenses ?? []), expense], now);
    const cat = (expense.category ?? 'General').trim() || 'General';
    const prev = before.find((b) => b.category.toLowerCase() === cat.toLowerCase());
    const next = after.find((b) => b.category.toLowerCase() === cat.toLowerCase());
    if (!next) return;
    const threshold = next.pct >= 100 ? 100 : next.pct >= 80 ? 80 : null;
    if (threshold == null || (prev && prev.pct >= threshold)) return;
    const mk = monthKey(now);
    const title = threshold >= 100 ? `${next.category} budget exceeded` : `${next.category} at ${next.pct}% of budget`;
    const ref: ExpenseRef = {
      kind: 'insight',
      groupId,
      refId: `budget-${mk}-${next.category}`,
      snapshot: {
        title,
        amount: next.spent,
        currency: group.currency ?? 'USD',
        payerName: '',
        payerId: '',
        participantCount: 0,
        category: next.category,
      },
    };
    void writeGroupSystemMessage(groupId, `🎯 ${title} · ${formatCurrency(next.spent, group.currency)} of ${formatCurrency(next.budget, group.currency)}`, {
      messageOverrides: { type: 'expense', expenseRef: ref },
      fixedMessageId: `budget-${groupId}-${mk}-${next.category.toLowerCase()}-${threshold}`,
    });
  };

  /** Unusual-spend alert card (opt-in via admin panel; default off). */
  const maybePostAnomalyAlert = (group: Group | undefined, groupId: string, expense: Expense) => {
    if (!group) return;
    const settings = resolveMoneyInChat(group.moneyInChat);
    if (!settings.insights.anomalyPosts) return;
    const hits = detectAnomalies([...(group.expenses ?? []), expense], Date.now());
    const mine = hits.find((a) => a.expenseId === expense.expenseId);
    if (!mine) return;
    const ref: ExpenseRef = {
      kind: 'insight',
      groupId,
      refId: expense.expenseId,
      snapshot: {
        title: `${mine.title}: ${mine.ratio}× the usual`,
        amount: mine.amount,
        currency: group.currency ?? 'USD',
        payerName: '',
        payerId: '',
        participantCount: 0,
        category: mine.category,
      },
    };
    void writeGroupSystemMessage(
      groupId,
      `📈 ${mine.title} is ${mine.ratio}× the usual for ${mine.category}`,
      {
        messageOverrides: { type: 'expense', expenseRef: ref },
        fixedMessageId: `anomaly-${groupId}-${expense.expenseId}`,
      },
    );
  };

  /** Admin-set per-category monthly budgets (group currency). */
  const updateGroupBudgets = async (groupId: string, budgets: Record<string, number>) => {
    if (!user) throw new Error('You must be signed in to change budgets.');
    const group = groups.find((g) => g.groupId === groupId);
    if (!group) throw new Error('Group not found.');
    const me = group.members.find((m) => m.userId === user.userId);
    if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
      throw new Error('Only group admins can set budgets.');
    }
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(budgets)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && k.trim()) clean[k.trim()] = Math.round(n * 100) / 100;
    }
    const groupRef = doc(db, 'groups', groupId);
    await updateDoc(groupRef, { budgets: clean, updatedAt: serverTimestamp() });
    setGroups((prev) => {
      const next = prev.map((g) => (g.groupId === groupId ? { ...g, budgets: clean, updatedAt: Date.now() } : g));
      if (user) void persistGroups(user.userId, next);
      return next;
    });
  };

  const updateMoneyInChat = async (groupId: string, settings: MoneyInChatSettings) => {
    if (!user) throw new Error('You must be signed in to change group settings.');
    const group = groups.find((g) => g.groupId === groupId);
    if (!group) throw new Error('Group not found.');
    const me = group.members.find((m) => m.userId === user.userId);
    if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
      throw new Error('Only group admins can change Money in Chat settings.');
    }

    const groupRef = doc(db, 'groups', groupId);
    await updateDoc(groupRef, { moneyInChat: settings, updatedAt: serverTimestamp() });

    setGroups((prev) => {
      const next = prev.map((g) =>
        g.groupId === groupId ? { ...g, moneyInChat: settings, updatedAt: Date.now() } : g,
      );
      if (user) void persistGroups(user.userId, next);
      return next;
    });

    void writeGroupSystemMessage(groupId, `${me.displayName} updated Money in Chat settings`);
  };

  const updateGroup = async (
    groupId: string,
    updates: { name?: string; description?: string; photoURL?: string },
  ) => {
    if (!user) throw new Error('You must be signed in to edit a group.');
    const group = groups.find((g) => g.groupId === groupId);
    if (!group) throw new Error('Group not found.');

    const me = group.members.find((m) => m.userId === user.userId);
    if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
      throw new Error('Only group admins can edit group details.');
    }

    const trimmedName = updates.name?.trim();
    const hasName = updates.name !== undefined;
    if (hasName && !trimmedName) {
      throw new Error('Group name cannot be empty.');
    }

    const trimmedDescription = updates.description?.trim();
    const hasDescription = updates.description !== undefined;

    const writePayload: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (hasName && trimmedName) writePayload.name = trimmedName;
    if (hasDescription) writePayload.description = trimmedDescription ?? '';
    if (updates.photoURL !== undefined) writePayload.photoURL = updates.photoURL;

    if (Object.keys(writePayload).length === 1) {
      // Only updatedAt would change — skip the write.
      return;
    }

    await updateDoc(doc(db, 'groups', groupId), writePayload);

    if (hasName && trimmedName && trimmedName !== group.name) {
      await writeGroupSystemMessage(
        groupId,
        `${user.displayName} renamed the group to "${trimmedName}"`,
      );
    }
  };


  /**
   * Convert every monetary value in the group to `newCurrency` using `rate`
   * (amount_new = amount_old * rate). One transaction over the group doc:
   * expenses (amount + participant shares + receipt line items), settlements,
   * and the group currency itself. Admin-gated like other group edits. The
   * rate is chosen/confirmed by the user in the UI before this runs.
   */
  const convertGroupCurrency = async (groupId: string, newCurrency: string, rate: number) => {
    if (!user) throw new Error('You must be signed in to convert a group currency.');
    if (!(rate > 0) || !Number.isFinite(rate)) throw new Error('Invalid exchange rate.');
    const group = groups.find((g) => g.groupId === groupId);
    if (!group) throw new Error('Group not found.');
    const me = group.members.find((m) => m.userId === user.userId);
    if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
      throw new Error('Only group admins can convert the currency.');
    }
    const target = newCurrency.toUpperCase();
    if (target === group.currency?.toUpperCase()) return;

    const zeroDecimal = ['JPY', 'KRW', 'VND', 'CLP'].includes(target);
    // Minor-unit scale for this target currency (100 = cents, 1 = whole units
    // for zero-decimal currencies like JPY) — all rounding below happens in
    // integer minor units to avoid floating-point drift.
    const scale = zeroDecimal ? 1 : 100;
    const toRawUnits = (v: number) => (v || 0) * rate * scale;
    const round = (v: number) => Math.round(toRawUnits(v)) / scale;
    const convertMoney = (v: number | undefined): number | undefined =>
      v === undefined ? undefined : round(v);

    /**
     * Rounds a set of raw (unrounded) minor-unit values so they sum EXACTLY
     * to round(total) — remainder minor-units go to the largest fractional
     * parts first, the same convention splitMath.ts uses for split rounding.
     * Without this, rounding every share independently drifts the sum away
     * from the converted total by a cent or more per expense.
     */
    const reconcileShares = (total: number, raw: number[]): number[] => {
      const totalUnits = Math.round(toRawUnits(total));
      const floored = raw.map((v) => Math.floor(toRawUnits(v)));
      let remainder = totalUnits - floored.reduce((a, b) => a + b, 0);
      const byFraction = raw
        .map((v, i) => ({ i, frac: toRawUnits(v) - Math.floor(toRawUnits(v)) }))
        .sort((a, b) => b.frac - a.frac);
      for (const { i } of byFraction) {
        if (remainder === 0) break;
        floored[i] += remainder > 0 ? 1 : -1;
        remainder += remainder > 0 ? -1 : 1;
      }
      return floored.map((u) => u / scale);
    };

    const convertParticipantConfig = (
      cfg: ExpenseSplitParticipantConfig,
    ): ExpenseSplitParticipantConfig => ({
      ...cfg,
      exactAmount: convertMoney(cfg.exactAmount),
      adjustment: convertMoney(cfg.adjustment),
      historicalPaid: convertMoney(cfg.historicalPaid),
      computedAmount: convertMoney(cfg.computedAmount),
    });

    const convertSplitMetadata = (
      meta: ExpenseSplitMetadata | undefined,
    ): ExpenseSplitMetadata | undefined => {
      if (!meta) return meta;
      return {
        ...meta,
        taxAmount: convertMoney(meta.taxAmount),
        tipAmount: convertMoney(meta.tipAmount),
        receiptItems: meta.receiptItems?.map((item) => ({ ...item, price: round(item.price) })),
        itemCategories: meta.itemCategories?.map((cat) => ({ ...cat, amount: round(cat.amount) })),
        participantConfig: meta.participantConfig?.map(convertParticipantConfig),
      };
    };

    await runTransaction(db, async (txn) => {
      const ref = doc(db, 'groups', groupId);
      const snap = await txn.get(ref);
      if (!snap.exists()) throw new Error('Group not found.');
      const data = snap.data() as Group;

      const expenses = (data.expenses ?? []).map((expense) => {
        const shares = reconcileShares(
          expense.amount,
          (expense.participants ?? []).map((p) => p.share),
        );
        return {
          ...expense,
          amount: round(expense.amount),
          participants: (expense.participants ?? []).map((participantShare, i) => ({
            ...participantShare,
            share: shares[i],
          })),
          splitMetadata: convertSplitMetadata(expense.splitMetadata),
        };
      });
      const settlements = (data.settlements ?? []).map((settlement) => ({
        ...settlement,
        amount: round(settlement.amount),
      }));
      // Per-category budget thresholds are stored in the group currency too —
      // left unconverted, a budget silently becomes looser or tighter by the
      // conversion factor with no warning the next time it's checked.
      const budgets = data.budgets
        ? Object.fromEntries(
            Object.entries(data.budgets).map(([category, amount]) => [category, round(amount)]),
          )
        : data.budgets;

      txn.update(ref, {
        currency: target,
        expenses,
        settlements,
        ...(budgets ? { budgets } : {}),
        updatedAt: serverTimestamp(),
      });
    });

    await writeGroupSystemMessage(
      groupId,
      `converted the group currency from ${group.currency} to ${target}`,
    );
  };

  const updateMemberRole = async (
    groupId: string,
    userId: string,
    role: 'admin' | 'member',
  ) => {
    if (!user) throw new Error('You must be signed in.');
    const group = groups.find((g) => g.groupId === groupId);
    if (!group) throw new Error('Group not found.');

    const actor = group.members.find((m) => m.userId === user.userId);
    if (!actor || actor.role !== 'owner') {
      throw new Error('Only the group owner can change member roles.');
    }

    const target = group.members.find((m) => m.userId === userId);
    if (!target) throw new Error('Member not found.');
    if (target.role === 'owner') {
      throw new Error("You can't change the owner's role.");
    }
    if (target.role === role) return;

    await runTransaction(db, async (txn) => {
      const ref = doc(db, 'groups', groupId);
      const snap = await txn.get(ref);
      if (!snap.exists()) throw new Error('Group not found.');
      const data = snap.data() as Group;
      const newMembers = (data.members ?? []).map((member) =>
        member.userId === userId ? { ...member, role } : member,
      );
      txn.update(ref, { members: newMembers, updatedAt: serverTimestamp() });
    });

    await writeGroupSystemMessage(
      groupId,
      role === 'admin'
        ? `${target.displayName} is now an admin`
        : `${target.displayName} is no longer an admin`,
    );
  };

  const removeMember = async (groupId: string, userId: string) => {
    if (!user) throw new Error('You must be signed in.');
    if (userId === user.userId) {
      throw new Error('Use leave group to remove yourself.');
    }
    const group = groups.find((g) => g.groupId === groupId);
    if (!group) throw new Error('Group not found.');

    const actor = group.members.find((m) => m.userId === user.userId);
    const target = group.members.find((m) => m.userId === userId);
    if (!actor) throw new Error('You are not a member of this group.');
    if (!target) throw new Error('Member not found.');

    if (actor.role !== 'owner' && actor.role !== 'admin') {
      throw new Error('Only group admins can remove members.');
    }
    if (target.role === 'owner') {
      throw new Error("You can't remove the owner.");
    }
    if (actor.role === 'admin' && target.role === 'admin') {
      throw new Error('Admins can only remove regular members. Ask the owner.');
    }

    let nextParticipants: ChatParticipant[] | undefined;
    let nextParticipantIds: string[] | undefined;

    await runTransaction(db, async (txn) => {
      const ref = doc(db, 'groups', groupId);
      const snap = await txn.get(ref);
      if (!snap.exists()) throw new Error('Group not found.');
      const data = snap.data() as Group;

      const removed = (data.members ?? []).find((member) => member.userId === userId);
      const newMembers = (data.members ?? []).filter((member) => member.userId !== userId);
      const newMemberIds = (data.memberIds ?? []).filter((id) => id !== userId);

      // Archive instead of drop: keeps displayName/photo resolvable forever
      // so historical balances/debts don't render as "Unknown".
      const existingArchive = (data.archivedMembers ?? []).filter(
        (member) => member.userId !== userId,
      );
      const archivedEntry: GroupMember = removed
        ? {
            ...removed,
            role: 'member',
            balance: 0,
            archived: true,
            archivedAt: Date.now(),
            archivedReason: 'removed',
          }
        : {
            userId,
            displayName: target.displayName,
            ...(target.photoURL ? { photoURL: target.photoURL } : {}),
            role: 'member',
            balance: 0,
            archived: true,
            archivedAt: Date.now(),
            archivedReason: 'removed',
          };

      // stripUndefinedDeep must not wrap serverTimestamp() — see the comment
      // at its joinGroup call site for why that silently corrupts the sentinel.
      txn.update(ref, {
        ...stripUndefinedDeep({
          members: newMembers,
          memberIds: newMemberIds,
          archivedMembers: [...existingArchive, archivedEntry],
        }),
        updatedAt: serverTimestamp(),
      });
    });

    // Mirror removal in the chat thread (best effort).
    try {
      const chatsRef = collection(db, 'chats');
      const chatQ = query(chatsRef, where('groupId', '==', groupId));
      const chatSnap = await getDocs(chatQ);
      if (!chatSnap.empty) {
        const chatDoc = chatSnap.docs[0];
        const chatData = chatDoc.data() as Record<string, unknown>;
        const currentParticipants = (chatData.participants as ChatParticipant[] | undefined) ?? [];
        const currentParticipantIds = (chatData.participantIds as string[] | undefined) ?? [];
        nextParticipants = currentParticipants.filter((p) => p.userId !== userId);
        nextParticipantIds = currentParticipantIds.filter((id) => id !== userId);
      }
    } catch (error) {
      console.warn('removeMember chat sync prefetch failed', error);
    }

    await writeGroupSystemMessage(
      groupId,
      `${target.displayName} was removed from the group`,
      {
        participantsOverride: nextParticipants,
        participantIdsOverride: nextParticipantIds,
      },
    );
  };

  const leaveGroup = async (groupId: string) => {
    if (!user) throw new Error('You must be signed in.');
    const group = groups.find((g) => g.groupId === groupId);
    if (!group) throw new Error('Group not found.');

    const me = group.members.find((m) => m.userId === user.userId);
    if (!me) throw new Error('You are not a member of this group.');
    if (me.role === 'owner') {
      throw new Error('Owners must promote another member to owner before leaving.');
    }
    // Doc 29 Fix #1: leaving no longer silently zeroes a real balance — the
    // leaving member must settle up first. `me.balance` is already the live,
    // dynamically-recomputed number (adaptGroup), not a stale cached value.
    if (Math.abs(me.balance) >= 0.005) {
      throw new Error(
        me.balance > 0
          ? `You're owed ${formatCurrency(me.balance, group.currency)} — settle up before leaving.`
          : `You owe ${formatCurrency(Math.abs(me.balance), group.currency)} — settle up before leaving.`,
      );
    }

    let nextParticipants: ChatParticipant[] | undefined;
    let nextParticipantIds: string[] | undefined;

    await runTransaction(db, async (txn) => {
      const ref = doc(db, 'groups', groupId);
      const snap = await txn.get(ref);
      if (!snap.exists()) throw new Error('Group not found.');
      const data = snap.data() as Group;
      const meRecord = (data.members ?? []).find((member) => member.userId === user.userId);
      const newMembers = (data.members ?? []).filter((member) => member.userId !== user.userId);
      const newMemberIds = (data.memberIds ?? []).filter((id) => id !== user.userId);

      const existingArchive = (data.archivedMembers ?? []).filter(
        (member) => member.userId !== user.userId,
      );
      const archivedEntry: GroupMember = {
        userId: user.userId,
        displayName: meRecord?.displayName ?? me.displayName,
        ...(meRecord?.photoURL ? { photoURL: meRecord.photoURL } : me.photoURL ? { photoURL: me.photoURL } : {}),
        role: 'member',
        balance: 0,
        archived: true,
        archivedAt: Date.now(),
        archivedReason: 'left',
      };

      // stripUndefinedDeep must not wrap serverTimestamp() — see the comment
      // at its joinGroup call site for why that silently corrupts the sentinel.
      txn.update(ref, {
        ...stripUndefinedDeep({
          members: newMembers,
          memberIds: newMemberIds,
          archivedMembers: [...existingArchive, archivedEntry],
        }),
        updatedAt: serverTimestamp(),
      });
    });

    try {
      const chatsRef = collection(db, 'chats');
      const chatQ = query(chatsRef, where('groupId', '==', groupId));
      const chatSnap = await getDocs(chatQ);
      if (!chatSnap.empty) {
        const chatDoc = chatSnap.docs[0];
        const chatData = chatDoc.data() as Record<string, unknown>;
        const currentParticipants = (chatData.participants as ChatParticipant[] | undefined) ?? [];
        const currentParticipantIds = (chatData.participantIds as string[] | undefined) ?? [];
        nextParticipants = currentParticipants.filter((p) => p.userId !== user.userId);
        nextParticipantIds = currentParticipantIds.filter((id) => id !== user.userId);
      }
    } catch (error) {
      console.warn('leaveGroup chat sync prefetch failed', error);
    }

    await writeGroupSystemMessage(groupId, `${me.displayName} left the group`, {
      participantsOverride: nextParticipants,
      participantIdsOverride: nextParticipantIds,
    });
  };

  const deleteGroup = async (groupId: string) => {
    if (!user) throw new Error('You must be signed in.');
    const group = groups.find((g) => g.groupId === groupId);
    if (!group) throw new Error('Group not found.');

    const me = group.members.find((m) => m.userId === user.userId);
    if (!me || me.role !== 'owner') {
      throw new Error('Only the group owner can delete the group.');
    }

    // Firestore writeBatch caps at 500 operations. For groups with that many
    // top-level expense docs the cleanup must page; for now we surface a
    // clear error rather than silently leaking docs.
    const batch = writeBatch(db);
    batch.delete(doc(db, 'groups', groupId));

    const chatsRef = collection(db, 'chats');
    const chatQ = query(chatsRef, where('groupId', '==', groupId));
    const chatSnap = await getDocs(chatQ);
    chatSnap.forEach((chatDoc) => batch.delete(chatDoc.ref));

    const expensesRef = collection(db, 'expenses');
    const expQ = query(expensesRef, where('groupId', '==', groupId));
    const expSnap = await getDocs(expQ);
    expSnap.forEach((expDoc) => batch.delete(expDoc.ref));

    const opCount = 1 + chatSnap.size + expSnap.size;
    if (opCount > 450) {
      throw new Error(
        'This group has too many linked records to delete in a single operation. Contact support.',
      );
    }

    await batch.commit();

    // Withdraw every delivered notification that deep-links to the deleted
    // group or its chat thread on this device (expenses, settlements, joins,
    // messages). Other members' devices clear via the snapshot diff.
    void dismissNotificationsForEntity({ groupId });
    chatSnap.forEach((chatDoc) => {
      void dismissNotificationsForEntity({ chatId: chatDoc.id });
    });
  };

  const value = useMemo(
    () => ({
      groups,
      loading,
      pendingSyncIds,
      createGroup,
      joinGroup,
      addExpense,
      updateExpense,
      deleteExpense,
      settleUp,
      updateSettlement,
      deleteSettlement,
      updateGroup,
      convertGroupCurrency,
      updateMoneyInChat,
      updateGroupBudgets,
      postGroupDigest,
      postRecurringBillCards,
      postRecurringRequestCards,
      updateMemberRole,
      removeMember,
      leaveGroup,
      deleteGroup,
    }),
    [groups, loading, pendingSyncIds],
  );

  return <GroupContext.Provider value={value}>{children}</GroupContext.Provider>;
};

export const useGroups = () => {
  const context = useContext(GroupContext);
  if (!context) {
    throw new Error('useGroups must be used within GroupProvider');
  }
  return context;
};
