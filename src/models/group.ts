import type { Expense } from './expense';

export interface GroupMember {
  userId: string;
  displayName: string;
  photoURL?: string;
  role: 'owner' | 'admin' | 'member';
  balance: number;
}

export interface Settlement {
  settlementId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  createdAt: number;
  note?: string;
  status: 'pending' | 'completed';
}

export interface Group {
  groupId: string;
  inviteCode: string;
  name: string;
  description?: string;
  currency: string;
  members: GroupMember[];
  memberIds?: string[];
  expenses: Expense[];
  settlements: Settlement[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
