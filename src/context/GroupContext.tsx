import { db } from '@/firebase';
import type { ChatMessage, ChatParticipant, Expense, Group, GroupMember, ParticipantShare, Settlement } from '@/models';
import { queueMessage } from '@/services/messageQueueService';
import { deleteFile, uploadFile } from '@/services/storageService';
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
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useAuth } from './AuthContext';

interface GroupContextValue {
  groups: Group[];
  loading: boolean;
  createGroup: (name: string, currency: string, requestId?: string) => Promise<string>;
  joinGroup: (inviteCode: string, requestId?: string) => Promise<void>;
  addExpense: (groupId: string, expense: Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>, fileUri?: string, fileName?: string, requestId?: string) => Promise<void>;
  updateExpense: (groupId: string, expense: Expense, newFileUri?: string | null, newFileName?: string, requestId?: string) => Promise<void>;
  deleteExpense: (groupId: string, expenseId: string) => Promise<void>;
  settleUp: (groupId: string, settlement: Omit<Settlement, 'settlementId' | 'createdAt' | 'status'>, requestId?: string) => Promise<void>;
  updateSettlement: (groupId: string, settlement: Settlement, requestId?: string) => Promise<void>;
  deleteSettlement: (groupId: string, settlementId: string) => Promise<void>;
  updateGroup: (groupId: string, updates: { name?: string; description?: string }) => Promise<void>;
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

export const GroupProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { user } = useAuth();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setGroups([]);
      setLoading(false);
      return () => undefined;
    }

    const groupsRef = collection(db, 'groups');
    const q = query(groupsRef, where('memberIds', 'array-contains', user.userId));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const payload = snapshot.docs.map((docSnapshot) => adaptGroup(docSnapshot.data() as Group));
      setGroups(payload);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user?.userId]);

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

  const joinGroup = async (inviteCode: string, requestId?: string) => {
    if (!user) throw new Error('Missing user');
    const groupsRef = collection(db, 'groups');
    const q = query(groupsRef, where('inviteCode', '==', inviteCode));
    const groupSnapshot = await getDocs(q);
    if (groupSnapshot.empty) {
      throw new Error('Invite code not found');
    }

    const groupDoc = groupSnapshot.docs[0];
    const groupData = groupDoc.data() as Group;
    if (groupData.memberIds?.includes(user.userId)) {
      return;
    }

    // Update associated chat thread if it exists
    const chatsRef = collection(db, 'chats');
    const chatQ = query(chatsRef, where('groupId', '==', groupData.groupId));
    const chatSnapshot = await getDocs(chatQ);
    const batch = writeBatch(db);

    // If the user previously left or was removed, drop them from
    // archivedMembers so we don't have a duplicate identity record.
    const purgedArchive = (groupData.archivedMembers ?? []).filter(
      (member) => member.userId !== user.userId,
    );
    batch.update(groupDoc.ref, stripUndefinedDeep({
      memberIds: arrayUnion(user.userId),
      members: arrayUnion({
        userId: user.userId,
        displayName: user.displayName,
        photoURL: user.photoURL ?? null,
        role: 'member',
        balance: 0,
      }),
      archivedMembers: purgedArchive,
      updatedAt: serverTimestamp(),
    }));

    let systemMessage: ChatMessage | null = null;
    let recipients: string[] = [];

    if (!chatSnapshot.empty) {
      const chatDoc = chatSnapshot.docs[0];
      const chatId = chatDoc.id;
      const chatData = chatDoc.data();

      const newParticipant: ChatParticipant = {
        userId: user.userId,
        displayName: user.displayName,
        ...(user.photoURL ? { photoURL: user.photoURL } : {}),
        status: 'online',
      };

      const msgId = requestId ?? uuid();
      const now = Date.now();
      systemMessage = {
        id: msgId,
        messageId: msgId,
        requestId: requestId ?? msgId,
        chatId,
        // RTDB queue rules require senderId to match auth.uid on create.
        senderId: user.userId,
        type: 'system',
        content: `${user.displayName} joined the group`,
        status: 'sent',
        createdAt: now,
        timestamp: now,
        isFromMe: false,
        deliveredTo: [],
        readBy: [],
      };

      batch.update(chatDoc.ref, {
        participantIds: arrayUnion(user.userId),
        participants: arrayUnion(newParticipant),
        lastMessage: { ...systemMessage, createdAt: serverTimestamp() },
        updatedAt: serverTimestamp(),
      });

      // Queue system message for all participants (including the new user)
      const currentParticipantIds = (chatData.participantIds as string[]) || [];
      recipients = [...new Set([...currentParticipantIds, user.userId])];
    }

    await batch.commit();

    if (systemMessage) {
      for (const recipientId of recipients) {
        try {
          await queueMessage(recipientId, systemMessage, true); // isGroupChat = true
        } catch (error) {
          console.error(`Failed to queue system message for ${recipientId}:`, error);
          // Continue to next recipient even if one fails
        }
      }
    }
  };

  const addExpense = async (
    groupId: string,
    expense: Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>,
    fileUri?: string,
    originalFileName?: string,
    requestId?: string,
  ) => {
    try {
      console.log('Adding expense to group:', groupId, expense);
      const expenseId = requestId ?? expense.requestId ?? uuid();
      const docRef = doc(db, 'groups', groupId);

      let receipt = expense.receipt;
      if (fileUri) {
        // Determine extension from URI or default to jpg
        let fileName = originalFileName;
        if (!fileName) {
          const extension = fileUri.split('.').pop()?.split('?')[0] || 'jpg';
          fileName = `receipt.${extension}`;
        }
        const path = `groups/${groupId}/expenses/${expenseId}/${fileName}`;
        const url = await uploadFile(fileUri, path);
        receipt = { url, fileName };
      }

      // Use the participants calculated by the UI, which handles rounding correctly
      const splitShares: ParticipantShare[] = expense.participants;

      const newExpense = stripUndefinedDeep({
        ...expense,
        expenseId,
        requestId: requestId ?? expense.requestId ?? expenseId,
        participants: splitShares,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      if (receipt) {
        newExpense.receipt = stripUndefinedDeep(receipt);
      }

      const writtenExpenseId = await runTransaction(db, async (transaction) => {
        const groupSnapshot = await transaction.get(docRef);
        if (!groupSnapshot.exists()) {
          throw new Error('Group not found');
        }

        const groupData = groupSnapshot.data() as Group;
        const existingExpense = (groupData.expenses ?? []).find((entry) =>
          entry.expenseId === expenseId ||
          ((requestId ?? expense.requestId) && entry.requestId === (requestId ?? expense.requestId)),
        );

        if (existingExpense) {
          return existingExpense.expenseId;
        }

        transaction.update(docRef, {
          expenses: [...(groupData.expenses ?? []), newExpense],
          updatedAt: serverTimestamp(),
        });

        return expenseId;
      });

      // Also add to the top-level expenses collection for easier querying later.
      await setDoc(doc(db, 'expenses', writtenExpenseId), {
        ...newExpense,
        groupId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      console.log('Expense added successfully');
    } catch (error) {
      console.error('Error adding expense:', error);
      throw error;
    }
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
          receipt = { url, fileName };
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

      // Update legacy top-level expenses collection docs (best effort).
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

      // Delete from legacy top-level expenses collection docs
      const q = query(collection(db, 'expenses'), where('expenseId', '==', expenseId));
      const snapshot = await getDocs(q);
      await Promise.all(snapshot.docs.map(async (docSnap) => {
        if (docSnap.id === expenseId) {
          return;
        }

        await deleteDoc(doc(db, 'expenses', docSnap.id));
      }));
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
    const docRef = doc(db, 'groups', groupId);
    const settlementId = requestId ?? settlement.requestId ?? uuid();

    await runTransaction(db, async (transaction) => {
      const groupSnapshot = await transaction.get(docRef);
      if (!groupSnapshot.exists()) {
        throw new Error('Group not found');
      }

      const groupData = groupSnapshot.data() as Group;
      const existingSettlement = (groupData.settlements ?? []).find((entry) =>
        entry.settlementId === settlementId ||
        ((requestId ?? settlement.requestId) && entry.requestId === (requestId ?? settlement.requestId)),
      );

      if (existingSettlement) {
        return existingSettlement.settlementId;
      }

      transaction.update(docRef, {
        settlements: [
          ...(groupData.settlements ?? []),
          {
            ...settlement,
            settlementId,
            requestId: requestId ?? settlement.requestId ?? settlementId,
            createdAt: Date.now(),
            status: 'pending',
          },
        ],
        updatedAt: serverTimestamp(),
      });

      return settlementId;
    });
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
    options: { participantsOverride?: ChatParticipant[]; participantIdsOverride?: string[] } = {},
  ) => {
    if (!user) return;
    try {
      const chatsRef = collection(db, 'chats');
      const chatQ = query(chatsRef, where('groupId', '==', groupId));
      const chatSnap = await getDocs(chatQ);
      if (chatSnap.empty) return;

      const chatDoc = chatSnap.docs[0];
      const chatId = chatDoc.id;
      const chatData = chatDoc.data() as Record<string, unknown>;

      const baseParticipants =
        options.participantsOverride ?? ((chatData.participants as ChatParticipant[] | undefined) ?? []);
      const baseParticipantIds =
        options.participantIdsOverride ?? ((chatData.participantIds as string[] | undefined) ?? []);

      const msgId = uuid();
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

  const updateGroup = async (
    groupId: string,
    updates: { name?: string; description?: string },
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

      txn.update(ref, stripUndefinedDeep({
        members: newMembers,
        memberIds: newMemberIds,
        archivedMembers: [...existingArchive, archivedEntry],
        updatedAt: serverTimestamp(),
      }));
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

      txn.update(ref, stripUndefinedDeep({
        members: newMembers,
        memberIds: newMemberIds,
        archivedMembers: [...existingArchive, archivedEntry],
        updatedAt: serverTimestamp(),
      }));
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
  };

  const value = useMemo(
    () => ({
      groups,
      loading,
      createGroup,
      joinGroup,
      addExpense,
      updateExpense,
      deleteExpense,
      settleUp,
      updateSettlement,
      deleteSettlement,
      updateGroup,
      updateMemberRole,
      removeMember,
      leaveGroup,
      deleteGroup,
    }),
    [groups, loading],
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
