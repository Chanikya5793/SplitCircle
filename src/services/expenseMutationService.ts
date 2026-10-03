import { app } from '@/firebase';
import type { Expense } from '@/models';
import type { MutationExpectation } from '@/utils/mutationConflict';
import { getFunctions, httpsCallable } from 'firebase/functions';

export interface ExpenseWriteAuthorization {
  operationId: string;
  authorizationId: string;
}

type ExpenseMutationInput =
  | {
      action: 'create';
      groupId: string;
      expense: Expense;
      expectedCurrency?: string;
      authorization?: ExpenseWriteAuthorization;
    }
  | {
      action: 'update';
      groupId: string;
      expense: Expense;
      expectation: MutationExpectation;
      expectedCurrency?: string;
      authorization?: ExpenseWriteAuthorization;
    }
  | {
      action: 'delete';
      groupId: string;
      expenseId: string;
      expectation: MutationExpectation;
    };

interface ExpenseMutationResult {
  success: true;
  duplicate: boolean;
  expense?: Expense;
}

const mutateExpenseCallable = httpsCallable<ExpenseMutationInput, ExpenseMutationResult>(
  getFunctions(app),
  'mutateExpense',
);

const convertGroupCurrencyCallable = httpsCallable<
  { groupId: string; expectedCurrency: string; newCurrency: string; rate: number },
  { success: true; previousCurrency: string; currency: string }
>(getFunctions(app), 'convertGroupCurrency');

export const createExpenseOnServer = async (
  groupId: string,
  expense: Expense,
  authorization?: ExpenseWriteAuthorization,
  expectedCurrency?: string,
): Promise<ExpenseMutationResult> => (
  await mutateExpenseCallable({ action: 'create', groupId, expense, authorization, expectedCurrency })
).data;

export const updateExpenseOnServer = async (
  groupId: string,
  expense: Expense,
  expectation: MutationExpectation,
  authorization?: ExpenseWriteAuthorization,
  expectedCurrency?: string,
): Promise<ExpenseMutationResult> => (
  await mutateExpenseCallable({ action: 'update', groupId, expense, expectation, authorization, expectedCurrency })
).data;

export const deleteExpenseOnServer = async (
  groupId: string,
  expenseId: string,
  expectation: MutationExpectation,
): Promise<ExpenseMutationResult> => (
  await mutateExpenseCallable({ action: 'delete', groupId, expenseId, expectation })
).data;

export const convertGroupCurrencyOnServer = async (
  groupId: string,
  expectedCurrency: string,
  newCurrency: string,
  rate: number,
): Promise<void> => {
  await convertGroupCurrencyCallable({ groupId, expectedCurrency, newCurrency, rate });
};
