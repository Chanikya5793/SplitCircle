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

export type BillAmountMode = 'fixed' | 'variable';

/**
 * Payer rotation (ai_layer/docs/26). When present, `order` overrides `paidBy`:
 * the payer for the next generated occurrence is `order[index % order.length]`,
 * and `index` advances ONLY when an occurrence actually generates an expense
 * (skipped occurrences do not consume a turn).
 */
export interface BillRotation {
    order: string[]; // userIds, in turn order
    index: number;
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

    // ── Recurring Bills v2 (ai_layer/docs/26) ────────────────────────────
    /** 'fixed' auto-generates at `amount`; 'variable' waits for an amount
     *  confirmation per occurrence (pendingOccurrences). Default 'fixed'. */
    amountMode?: BillAmountMode;
    /** Payer rotation — overrides paidBy per occurrence when present. */
    rotation?: BillRotation;
    /** occurrenceAt timestamps the group explicitly skipped — generation
     *  passes over these without creating an expense or consuming a turn. */
    skippedOccurrences?: number[];
    /** Variable bills: due occurrences awaiting an amount (capped, oldest
     *  dropped). Fixed bills never populate this. */
    pendingOccurrences?: number[];
    /** 1:1 recurring requests (doc 26, hidden-ledger bills): occurrences park
     *  in pendingOccurrences and book ONLY on the counterparty's accept —
     *  consent per occurrence, no silent accrual. */
    requiresAccept?: boolean;
    /** Idempotency marker: occurrenceAt the T-3 payer push was sent for. */
    reminderSentFor?: number;

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
