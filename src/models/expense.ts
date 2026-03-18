export type SplitType = 'equal' | 'percentage' | 'shares' | 'custom';
export type ExpenseSplitMethod =
  | 'equal'
  | 'exact'
  | 'percentage'
  | 'shares'
  | 'adjustment'
  | 'itemized'
  | 'income'
  | 'consumption'
  | 'timeBased'
  | 'gamified'
  | 'itemType';
export type ExpenseGamifiedMode = 'roulette' | 'weightedRoulette' | 'scrooge';
export type ExpenseTimeSplitVariant = 'dynamic' | 'standard';

export interface ParticipantShare {
  userId: string;
  share: number;
}

export interface ExpenseSplitParticipantConfig {
  userId: string;
  included: boolean;
  exactAmount?: number;
  percentage?: number;
  shares?: number;
  adjustment?: number;
  incomeWeight?: number;
  historicalPaid?: number;
  daysStayed?: number;
  checkInDate?: string;
  checkOutDate?: string;
  selectedStayDates?: string[];
  partsConsumed?: number;
  rouletteWeight?: number;
  computedAmount?: number;
}

export interface ExpenseReceiptItem {
  id: string;
  name: string;
  price: number;
  quantity?: number;
  assignedTo: string[];
}

export interface ExpenseItemCategory {
  id: string;
  label: string;
  amount: number;
  excludedParticipants: string[];
}

export interface ExpenseWeightedAssignment {
  userId: string;
  percentage: number;
}

export interface ExpenseSplitMetadata {
  version: 1;
  method: ExpenseSplitMethod;
  participantConfig: ExpenseSplitParticipantConfig[];
  receiptItems?: ExpenseReceiptItem[];
  taxAmount?: number;
  tipAmount?: number;
  totalParts?: number;
  timeSplitVariant?: ExpenseTimeSplitVariant;
  timePeriodDays?: number;
  timePeriodStartDate?: string;
  timePeriodEndDate?: string;
  gamifiedMode?: ExpenseGamifiedMode;
  rouletteLoserId?: string;
  weightedAssignments?: ExpenseWeightedAssignment[];
  karmaIntensity?: number;
  itemCategories?: ExpenseItemCategory[];
}

export interface ReceiptMetadata {
  url?: string;
  fileName?: string;
  size?: number;
  scannedWith?: 'visionkit' | 'ocr' | 'manual';
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
  splitMetadata?: ExpenseSplitMetadata;
  settled: boolean;
  notes?: string;
  receipt?: ReceiptMetadata;
  recurring?: RecurringExpenseMetadata;
  createdAt: number;
  updatedAt: number;
}
