export type SplitType = 'equal' | 'percentage' | 'shares' | 'custom';

export interface ParticipantShare {
  userId: string;
  share: number;
}

export interface ReceiptMetadata {
  url?: string;
  fileName?: string;
  size?: number;
}

export interface RecurringExpenseMetadata {
  billId: string;
  occurrenceAt: number;
}

export interface Expense {
  expenseId: string;
  groupId: string;
  title: string;
  category: string;
  amount: number;
  paidBy: string;
  splitType: SplitType;
  participants: ParticipantShare[];
  settled: boolean;
  notes?: string;
  receipt?: ReceiptMetadata;
  recurring?: RecurringExpenseMetadata;
  createdAt: number;
  updatedAt: number;
}
