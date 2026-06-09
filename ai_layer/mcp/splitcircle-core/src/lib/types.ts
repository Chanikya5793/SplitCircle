/**
 * types.ts — Domain types for the splitcircle-core MCP server.
 *
 * Mirrors the subset of src/models the server reads/writes (Phase 1). Kept local
 * because this server deploys independently to Cloud Run.
 */

export interface ParticipantShare {
  userId: string;
  share: number;
}

export interface Expense {
  expenseId: string;
  requestId?: string;
  groupId: string;
  title: string;
  category: string;
  amount: number;
  paidBy: string;
  splitType: 'equal' | 'percentage' | 'shares' | 'custom';
  participants: ParticipantShare[];
  settled?: boolean;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GroupMember {
  userId: string;
  displayName: string;
  role: 'owner' | 'admin' | 'member';
  balance?: number;
}

export interface Settlement {
  settlementId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  status: 'pending' | 'completed';
  createdAt: number;
}

export interface Group {
  groupId: string;
  name: string;
  currency: string;
  members: GroupMember[];
  memberIds?: string[];
  expenses: Expense[];
  settlements: Settlement[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** Result of an MCP tool handler — structured payload + optional human-readable text. */
export interface ToolResult<T = unknown> {
  data: T;
  text: string;
}
