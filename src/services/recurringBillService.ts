/**
 * Recurring Bills Service
 * 
 * Handles creation, management, and automatic expense generation for recurring bills.
 */

import { addDoc, collection, deleteDoc, doc, getDocs, query, updateDoc, where } from 'firebase/firestore';
import { db } from '@/firebase';
import type { RecurringBill } from '@/models/recurringBill';
import type { Expense } from '@/models';

const COLLECTION_NAME = 'recurringBills';

/**
 * Create a new recurring bill
 */
export const createRecurringBill = async (
    bill: Omit<RecurringBill, 'billId' | 'createdAt' | 'updatedAt' | 'lastGeneratedAt'>
): Promise<string> => {
    const now = Date.now();
    const docRef = await addDoc(collection(db, COLLECTION_NAME), {
        ...bill,
        createdAt: now,
        updatedAt: now,
    });
    return docRef.id;
};

/**
 * Get all recurring bills for a group
 */
export const getRecurringBillsForGroup = async (groupId: string): Promise<RecurringBill[]> => {
    const q = query(collection(db, COLLECTION_NAME), where('groupId', '==', groupId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
        billId: doc.id,
        ...doc.data(),
    })) as RecurringBill[];
};

/**
 * Update a recurring bill
 */
export const updateRecurringBill = async (
    billId: string,
    updates: Partial<Omit<RecurringBill, 'billId' | 'createdAt'>>
): Promise<void> => {
    const docRef = doc(db, COLLECTION_NAME, billId);
    await updateDoc(docRef, {
        ...updates,
        updatedAt: Date.now(),
    });
};

/**
 * Delete a recurring bill
 */
export const deleteRecurringBill = async (billId: string): Promise<void> => {
    const docRef = doc(db, COLLECTION_NAME, billId);
    await deleteDoc(docRef);
};

/**
 * Toggle recurring bill active status
 */
export const toggleRecurringBillStatus = async (billId: string, isActive: boolean): Promise<void> => {
    await updateRecurringBill(billId, { isActive });
};

/**
 * Calculate the next due date based on frequency
 */
export const calculateNextDueDate = (bill: RecurringBill, fromDate: Date = new Date()): number => {
    const next = new Date(fromDate);

    switch (bill.frequency) {
        case 'weekly':
            next.setDate(next.getDate() + 7);
            break;
        case 'biweekly':
            next.setDate(next.getDate() + 14);
            break;
        case 'monthly':
            next.setMonth(next.getMonth() + 1);
            if (bill.dayOfMonth) {
                // Ensure day doesn't exceed month's days
                const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
                next.setDate(Math.min(bill.dayOfMonth, maxDay));
            }
            break;
    }

    return next.getTime();
};

/**
 * Check if a bill is due (should generate an expense)
 */
export const isBillDue = (bill: RecurringBill, now: Date = new Date()): boolean => {
    if (!bill.isActive) return false;
    return now.getTime() >= bill.nextDueAt;
};

/**
 * Generate expense data from a recurring bill
 */
export const generateExpenseFromBill = (bill: RecurringBill): Omit<Expense, 'expenseId'> => {
    const now = Date.now();
    return {
        groupId: bill.groupId,
        title: `${bill.title} (Recurring)`,
        category: bill.category,
        amount: bill.amount,
        paidBy: bill.paidBy,
        splitType: 'custom',
        participants: bill.participants,
        settled: false,
        notes: `Auto-generated from recurring bill`,
        createdAt: now,
        updatedAt: now,
    };
};

/**
 * Process all due recurring bills for a group
 * Returns the expenses that should be created
 */
export const processDueBills = async (
    groupId: string,
    addExpenseFn: (expense: Omit<Expense, 'expenseId'>) => Promise<void>
): Promise<number> => {
    const bills = await getRecurringBillsForGroup(groupId);
    const now = new Date();
    let generatedCount = 0;

    for (const bill of bills) {
        if (isBillDue(bill, now)) {
            // Generate the expense
            const expenseData = generateExpenseFromBill(bill);
            await addExpenseFn(expenseData);

            // Update the bill with new next due date
            const nextDueAt = calculateNextDueDate(bill, now);
            await updateRecurringBill(bill.billId, {
                lastGeneratedAt: now.getTime(),
                nextDueAt,
            });

            generatedCount++;
        }
    }

    return generatedCount;
};
