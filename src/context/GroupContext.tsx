import { db } from '@/firebase';
import type { Expense, Group, ParticipantShare, Settlement } from '@/models';
import { deleteImage, uploadImage } from '@/services/storageService';
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
  addExpense: (groupId: string, expense: Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>, imageUri?: string) => Promise<void>;
  updateExpense: (groupId: string, expense: Expense, newImageUri?: string | null) => Promise<void>;
  deleteExpense: (groupId: string, expenseId: string) => Promise<void>;
  settleUp: (groupId: string, settlement: Omit<Settlement, 'settlementId' | 'createdAt' | 'status'>) => Promise<void>;
}
// ...existing code...
  const addExpense = async (
    groupId: string,
    expense: Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>,
    imageUri?: string,
  ) => {
    try {
      console.log('Adding expense to group:', groupId, expense);
      const expenseId = uuid();
      const docRef = doc(db, 'groups', groupId);
      
      let receipt = expense.receipt;
      if (imageUri) {
        const path = `groups/${groupId}/expenses/${expenseId}/receipt.jpg`;
        const url = await uploadImage(imageUri, path);
        receipt = { url, fileName: 'receipt.jpg' };
      }

      // Use the participants calculated by the UI, which handles rounding correctly
      const splitShares: ParticipantShare[] = expense.participants;

      const newExpense = {
        ...expense,
        expenseId,
        participants: splitShares,
        receipt,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

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

  const updateExpense = async (groupId: string, updatedExpense: Expense, newImageUri?: string | null) => {
    try {
      const group = groups.find((g) => g.groupId === groupId);
      if (!group) throw new Error('Group not found');

      let receipt = updatedExpense.receipt;

      if (newImageUri !== undefined) {
        // If explicitly null, delete existing image
        if (newImageUri === null && receipt?.url) {
           // Assuming path convention
           const path = `groups/${groupId}/expenses/${updatedExpense.expenseId}/receipt.jpg`;
           await deleteImage(path);
           receipt = undefined;
        } else if (newImageUri) {
           // Upload new image (overwrites if same path, but good to be safe)
           const path = `groups/${groupId}/expenses/${updatedExpense.expenseId}/receipt.jpg`;
           const url = await uploadImage(newImageUri, path);
           receipt = { url, fileName: 'receipt.jpg' };
        }
      }

      const finalExpense = { ...updatedExpense, receipt, updatedAt: Date.now() };

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
         const path = `groups/${groupId}/expenses/${expenseId}/receipt.jpg`;
         await deleteImage(path);
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
  };

  const addExpense = async (
    groupId: string,
    expense: Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>,
  ) => {
    try {
      console.log('Adding expense to group:', groupId, expense);
      const expenseId = uuid();
      const docRef = doc(db, 'groups', groupId);
      
      // Use the participants calculated by the UI, which handles rounding correctly
      const splitShares: ParticipantShare[] = expense.participants;

      await updateDoc(docRef, {
        expenses: arrayUnion({
          ...expense,
          expenseId,
          participants: splitShares,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
        updatedAt: serverTimestamp(),
      });
      
      // Also add to the top-level expenses collection for easier querying later
      await addDoc(collection(db, 'expenses'), {
        ...expense,
        groupId,
        expenseId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      console.log('Expense added successfully');
    } catch (error) {
      console.error('Error adding expense:', error);
      throw error;
    }
  };

  const updateExpense = async (groupId: string, updatedExpense: Expense) => {
    try {
      const group = groups.find((g) => g.groupId === groupId);
      if (!group) throw new Error('Group not found');

      const updatedExpenses = group.expenses.map((exp) =>
        exp.expenseId === updatedExpense.expenseId ? { ...updatedExpense, updatedAt: Date.now() } : exp
      );

      const docRef = doc(db, 'groups', groupId);
      await updateDoc(docRef, {
        expenses: updatedExpenses,
        updatedAt: serverTimestamp(),
      });

      // Update top-level expenses collection (best effort)
      const q = query(collection(db, 'expenses'), where('expenseId', '==', updatedExpense.expenseId));
      const snapshot = await getDocs(q);
      snapshot.forEach(async (docSnap) => {
        await updateDoc(doc(db, 'expenses', docSnap.id), {
          ...updatedExpense,
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

  const value = useMemo(
    () => ({ groups, loading, createGroup, joinGroup, addExpense, updateExpense, deleteExpense, settleUp }),
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
