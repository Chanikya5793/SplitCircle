import { db } from '@/firebase';
import type { Expense, Group, ParticipantShare, Settlement } from '@/models';
import { computeSplit } from '@/utils/split';
import {
    addDoc,
    arrayUnion,
    collection,
    doc,
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
  addExpense: (groupId: string, expense: Omit<Expense, 'expenseId' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  settleUp: (groupId: string, settlement: Omit<Settlement, 'settlementId' | 'createdAt' | 'status'>) => Promise<void>;
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

const adaptGroup = (data: Group): Group => ({
  ...data,
  expenses: (data.expenses ?? []).map((expense) => ({
    ...expense,
    createdAt: normalizeTimestamp((expense as Expense).createdAt),
    updatedAt: normalizeTimestamp((expense as Expense).updatedAt),
  })),
  settlements: (data.settlements ?? []).map((settlement) => ({
    ...settlement,
    createdAt: normalizeTimestamp((settlement as Settlement).createdAt),
  })),
});

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
    const expenseId = uuid();
    const docRef = doc(db, 'groups', groupId);
    const splitShares: ParticipantShare[] = computeSplit(
      expense.amount,
      expense.splitType,
      expense.participants.map((item) => item.userId),
      expense.participants,
    );
    await updateDoc(docRef, {
      expenses: arrayUnion({
        ...expense,
        expenseId,
        participants: splitShares,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
      updatedAt: serverTimestamp(),
    });
    await addDoc(collection(db, 'expenses'), {
      ...expense,
      groupId,
      expenseId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
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
        createdAt: serverTimestamp(),
        status: 'pending',
      }),
      updatedAt: serverTimestamp(),
    });
  };

  const value = useMemo(
    () => ({ groups, loading, createGroup, joinGroup, addExpense, settleUp }),
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
