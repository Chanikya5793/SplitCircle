import type { ParticipantShare } from './expense';

export type BillFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type LegacyBillFrequency = 'weekly' | 'biweekly' | 'monthly';
export type MonthlyPattern = 'dayOfMonth' | 'weekdaysOfMonth';

export interface RecurrenceRule {
    frequency: BillFrequency;
    interval: number; // every N frequency periods
    monthlyPattern?: MonthlyPattern;
    weekdays?: number[]; // 0-6, Sunday = 0
    daysOfMonth?: number[]; // 1-31
    weeksOfMonth?: number[]; // 1-5
    monthsOfYear?: number[]; // 1-12
    timezoneOffsetMinutes?: number; // Offset from UTC in minutes
}

export interface RecurringBill {
    billId: string;
    groupId: string;
    title: string;
    amount: number;
    category: string;
    paidBy: string;
    participants: ParticipantShare[];
    recurrenceRule: RecurrenceRule;
    startAt: number;
    endAt?: number;

    // Legacy fields retained for backward compatibility.
    frequency?: LegacyBillFrequency;
    dayOfMonth?: number;
    dayOfWeek?: number;

    isActive: boolean;
    lastGeneratedAt?: number;
    nextDueAt: number;
    createdAt: number;
    updatedAt: number;
}
