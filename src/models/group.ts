import type { Expense } from './expense';

export interface GroupMember {
  userId: string;
  displayName: string;
  photoURL?: string;
  role: 'owner' | 'admin' | 'member';
  balance: number;
  /**
   * True when the user is no longer an active group member but is preserved
   * for historical reference (so balances, debts, and chat history can keep
   * resolving their displayName instead of "Unknown"). Members with this flag
   * are stored under `Group.archivedMembers`, never `Group.members`.
   */
  archived?: boolean;
  /** When the member was removed or left, if archived. */
  archivedAt?: number;
  /** How they exited the group. */
  archivedReason?: 'left' | 'removed';
}

export interface Settlement {
  settlementId: string;
  requestId?: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  createdAt: number;
  note?: string;
  status: 'pending' | 'completed';
}

export interface Group {
  groupId: string;
  requestId?: string;
  inviteCode: string;
  name: string;
  description?: string;
  currency: string;
  members: GroupMember[];
  /**
   * Members who have left or been removed. Their userId is still referenced
   * by historical expenses and settlements, so we keep their identity here
   * so balance / debt / friend lookups can resolve a real displayName.
   */
  archivedMembers?: GroupMember[];
  memberIds?: string[];
  expenses: Expense[];
  settlements: Settlement[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
