export type BasicSplitMethod = 'equal' | 'exact' | 'percentage' | 'shares' | 'adjustment';
export type AdvancedSplitMethod = 'itemized' | 'income' | 'consumption' | 'timeBased' | 'gamified' | 'itemType';
export type SplitMethod = BasicSplitMethod | AdvancedSplitMethod;
export type GamifiedMode = 'roulette' | 'weightedRoulette' | 'scrooge';
export type TimeSplitVariant = 'dynamic' | 'standard';

export interface Participant {
  id: string;
  name: string;
  avatarUrl?: string;
  included: boolean;
  exactAmount: number;
  percentage: number;
  shares: number;
  adjustment: number;
  incomeWeight: number;
  daysStayed: number;
  checkInDate?: string;
  checkOutDate?: string;
  selectedStayDates?: string[];
  partsConsumed: number;
  rouletteWeight: number;
  historicalPaid: number;
  computedAmount: number;
}

export interface ReceiptItem {
  id: string;
  name: string;
  price: number;
  assignedTo: string[];
  splitMode?: 'equal' | 'exact' | 'percentage' | 'shares';
  splitData?: Record<string, number>;
}

export interface ItemCategory {
  id: string;
  label: string;
  amount: number;
  excludedParticipants: string[];
}

export interface SmartSuggestion {
  id: string;
  label: string;
  icon: string;
}

export interface ValidationResult {
  isValid: boolean;
  message: string;
  difference: number;
}

export const MOCK_PARTICIPANTS: Participant[] = [
  {
    id: 'u1', name: 'Chanakya', avatarUrl: undefined, included: true,
    exactAmount: 0, percentage: 0, shares: 1, adjustment: 0,
    incomeWeight: 70000, daysStayed: 0, partsConsumed: 0, rouletteWeight: 25,
    historicalPaid: 320, computedAmount: 0,
  },
  {
    id: 'u2', name: 'Chandler', avatarUrl: undefined, included: true,
    exactAmount: 0, percentage: 0, shares: 1, adjustment: 0,
    incomeWeight: 55000, daysStayed: 0, partsConsumed: 0, rouletteWeight: 25,
    historicalPaid: 180, computedAmount: 0,
  },
  {
    id: 'u3', name: 'Alice', avatarUrl: undefined, included: true,
    exactAmount: 0, percentage: 0, shares: 1, adjustment: 0,
    incomeWeight: 90000, daysStayed: 0, partsConsumed: 0, rouletteWeight: 25,
    historicalPaid: 450, computedAmount: 0,
  },
  {
    id: 'u4', name: 'Bob', avatarUrl: undefined, included: true,
    exactAmount: 0, percentage: 0, shares: 1, adjustment: 0,
    incomeWeight: 60000, daysStayed: 0, partsConsumed: 0, rouletteWeight: 25,
    historicalPaid: 95, computedAmount: 0,
  },
];

export const MOCK_TOTAL = 150.0;
