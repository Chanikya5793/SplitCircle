import type { ParticipantShare } from './expense';

export type BillFrequency = 'weekly' | 'biweekly' | 'monthly';

export interface RecurringBill {
    billId: string;
    groupId: string;
    title: string;
    amount: number;
    category: string;
    paidBy: string;
    participants: ParticipantShare[];
    frequency: BillFrequency;
    dayOfMonth?: number; // 1-31 for monthly, ignored for weekly
    dayOfWeek?: number; // 0-6 for weekly (Sunday = 0)
    isActive: boolean;
    lastGeneratedAt?: number;
    nextDueAt: number;
    createdAt: number;
    updatedAt: number;
}
