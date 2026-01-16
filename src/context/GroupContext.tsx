import { db } from '@/firebase';
import type { ChatMessage, ChatParticipant, Expense, Group, ParticipantShare, Settlement } from '@/models';
import { queueMessage } from '@/services/messageQueueService';
import { deleteFile, uploadFile } from '@/services/storageService';
import {
  addDoc,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useAuth } from './AuthContext';

interface GroupContextValue {
  groups: Group[];
  loading: boolean;
  createGroup: (name: string, currency: string) => Promise<string>;
  joinGroup: (inviteCode: string) => Promise<void>;
  addExpense: (groupId: string, expense: Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>, fileUri?: string, fileName?: string) => Promise<void>;
  updateExpense: (groupId: string, expense: Expense, newFileUri?: string | null, newFileName?: string) => Promise<void>;
  deleteExpense: (groupId: string, expenseId: string) => Promise<void>;
  settleUp: (groupId: string, settlement: Omit<Settlement, 'settlementId' | 'createdAt' | 'status'>) => Promise<void>;
  updateSettlement: (groupId: string, settlement: Settlement) => Promise<void>;
  deleteSettlement: (groupId: string, settlementId: string) => Promise<void>;
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

const adaptGroup = (data: Group): Group => {
  const expenses = (data.expenses ?? []).map((expense) => ({
    ...expense,
    createdAt: normalizeTimestamp((expense as Expense).createdAt),
    updatedAt: normalizeTimestamp((expense as Expense).updatedAt),
  }));

  // Calculate balances dynamically based on expenses
  const memberBalances: Record<string, number> = {};
  data.members.forEach(m => memberBalances[m.userId] = 0);

  expenses.forEach(expense => {
    // Payer gets positive balance (they are owed money)
    const paidAmount = expense.amount;
    memberBalances[expense.paidBy] = (memberBalances[expense.paidBy] || 0) + paidAmount;

    // Participants get negative balance (they owe money)
    expense.participants.forEach(p => {
      memberBalances[p.userId] = (memberBalances[p.userId] || 0) - p.share;
    });
  });

  // Apply settlements to balances
  (data.settlements || []).forEach(settlement => {
    // Payer (fromUserId) pays money, so their balance increases (debt reduces)
    memberBalances[settlement.fromUserId] = (memberBalances[settlement.fromUserId] || 0) + settlement.amount;

    // Receiver (toUserId) receives money, so their balance decreases (amount owed to them reduces)
    memberBalances[settlement.toUserId] = (memberBalances[settlement.toUserId] || 0) - settlement.amount;
  });

  return {
    ...data,
    expenses,
    members: data.members.map(m => ({
      ...m,
      balance: memberBalances[m.userId] || 0
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

  const createGroup = async (name: string, currency: string) => {
    if (!user) throw new Error('Missing user');
    const groupId = uuid();
    await setDoc(doc(collection(db, 'groups'), groupId), {
      groupId,
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

  const joinGroup = async (inviteCode: string) => {
    if (!user) throw new Error('Missing user');
    const groupsRef = collection(db, 'groups');
    const q = query(groupsRef, where('inviteCode', '==', inviteCode));
    const snapshot = await new Promise<Group | null>((resolve) => {
      const unsub = onSnapshot(q, (snap) => {
        const docData = snap.docs[0]?.data() as Group | undefined;
        resolve(docData ?? null);
        unsub();
      });
    });
    if (!snapshot) {
      throw new Error('Invite code not found');
    }
    await updateDoc(doc(db, 'groups', snapshot.groupId), {
      memberIds: arrayUnion(user.userId),
      members: arrayUnion({
        userId: user.userId,
        displayName: user.displayName,
        photoURL: user.photoURL,
        role: 'member',
        balance: 0,
      }),
      updatedAt: serverTimestamp(),
    });

    // Update associated chat thread if it exists
    const chatsRef = collection(db, 'chats');
    const chatQ = query(chatsRef, where('groupId', '==', snapshot.groupId));
    const chatSnapshot = await getDocs(chatQ);

    if (!chatSnapshot.empty) {
      const chatDoc = chatSnapshot.docs[0];
      const chatId = chatDoc.id;
      const chatData = chatDoc.data();

      const newParticipant: ChatParticipant = {
        userId: user.userId,
        displayName: user.displayName,
        photoURL: user.photoURL,
        status: 'online',
      };

      const msgId = uuid();
      const now = Date.now();
      const systemMessage: ChatMessage = {
        id: msgId,
        messageId: msgId,
        chatId,
        senderId: 'system',
        type: 'system',
        content: `${user.displayName} joined the group`,
        status: 'sent',
        createdAt: now,
        timestamp: now,
        isFromMe: false,
        deliveredTo: [],
        readBy: [],
      };

      await updateDoc(doc(db, 'chats', chatId), {
        participantIds: arrayUnion(user.userId),
        participants: arrayUnion(newParticipant),
        lastMessage: { ...systemMessage, createdAt: serverTimestamp() },
        updatedAt: serverTimestamp(),
      });

      // Queue system message for all participants (including the new user)
      const currentParticipantIds = (chatData.participantIds as string[]) || [];
      const allRecipients = [...new Set([...currentParticipantIds, user.userId])];

      for (const recipientId of allRecipients) {
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
  ) => {
    try {
      console.log('Adding expense to group:', groupId, expense);
      const expenseId = uuid();
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

      const newExpense: any = {
        ...expense,
        expenseId,
        participants: splitShares,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      if (receipt) {
        newExpense.receipt = receipt;
      }

      await updateDoc(docRef, {
        expenses: arrayUnion(newExpense),
        updatedAt: serverTimestamp(),
      });

      // Also add to the top-level expenses collection for easier querying later
      await addDoc(collection(db, 'expenses'), {
        ...newExpense,
        groupId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      console.log('Expense added successfully');
    } catch (error) {
      console.error('Error adding expense:', error);
      throw error;
    }
  };

  const updateExpense = async (groupId: string, updatedExpense: Expense, newFileUri?: string | null, newFileName?: string) => {
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

      const finalExpense: any = { ...updatedExpense, updatedAt: Date.now() };

      if (receipt) {
        finalExpense.receipt = receipt;
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

      // Update top-level expenses collection (best effort)
      const q = query(collection(db, 'expenses'), where('expenseId', '==', finalExpense.expenseId));
      const snapshot = await getDocs(q);
      snapshot.forEach(async (docSnap) => {
        await updateDoc(doc(db, 'expenses', docSnap.id), {
          ...finalExpense,
          updatedAt: serverTimestamp(),
        });
      });
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

      // Delete from top-level expenses collection
      const q = query(collection(db, 'expenses'), where('expenseId', '==', expenseId));
      const snapshot = await getDocs(q);
      snapshot.forEach(async (docSnap) => {
        await deleteDoc(doc(db, 'expenses', docSnap.id));
      });
    } catch (error) {
      console.error('Error deleting expense:', error);
      throw error;
    }
  };


  const settleUp = async (
    groupId: string,
    settlement: Omit<Settlement, 'settlementId' | 'createdAt' | 'status'>,
  ) => {
    const docRef = doc(db, 'groups', groupId);
    await updateDoc(docRef, {
      settlements: arrayUnion({
        ...settlement,
        settlementId: uuid(),
        createdAt: Date.now(),
        status: 'pending',
      }),
      updatedAt: serverTimestamp(),
    });
  };

  const updateSettlement = async (groupId: string, updatedSettlement: Settlement) => {
    try {
      const group = groups.find((g) => g.groupId === groupId);
      if (!group) throw new Error('Group not found');

      const updatedSettlements = group.settlements.map((settlement) =>
        settlement.settlementId === updatedSettlement.settlementId ? updatedSettlement : settlement
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

  const value = useMemo(
    () => ({ groups, loading, createGroup, joinGroup, addExpense, updateExpense, deleteExpense, settleUp, updateSettlement, deleteSettlement }),
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
