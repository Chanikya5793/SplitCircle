/**
 * Debt Minimization Algorithm
 * 
 * Uses a greedy approach to minimize the number of transactions needed to settle all debts.
 * This is more efficient than the naive pairwise approach.
 */

export interface Debt {
    from: string;
    to: string;
    amount: number;
}

/**
 * Minimizes the number of transactions needed to settle all debts.
 * 
 * Algorithm:
 * 1. Calculate net balance for each person (positive = creditor, negative = debtor)
 * 2. Sort debtors and creditors by magnitude
 * 3. Greedily match largest debtor with largest creditor
 * 4. Repeat until all balances are settled
 * 
 * @param balances - Record of userId to their net balance (positive = owed money, negative = owes money)
 * @returns Array of optimized debt transactions
 */
export const minimizeDebts = (balances: Record<string, number>): Debt[] => {
    const debts: Debt[] = [];

    // Separate into debtors (negative balance) and creditors (positive balance)
    const debtors: { userId: string; amount: number }[] = [];
    const creditors: { userId: string; amount: number }[] = [];

    Object.entries(balances).forEach(([userId, balance]) => {
        if (balance < -0.01) {
            debtors.push({ userId, amount: Math.abs(balance) });
        } else if (balance > 0.01) {
            creditors.push({ userId, amount: balance });
        }
    });

    // Sort by amount (descending) for greedy matching
    debtors.sort((a, b) => b.amount - a.amount);
    creditors.sort((a, b) => b.amount - a.amount);

    let i = 0; // debtor index
    let j = 0; // creditor index

    while (i < debtors.length && j < creditors.length) {
        const debtor = debtors[i];
        const creditor = creditors[j];

        // Settle the smaller of the two amounts
        const settleAmount = Math.min(debtor.amount, creditor.amount);

        if (settleAmount > 0.01) {
            debts.push({
                from: debtor.userId,
                to: creditor.userId,
                amount: Number(settleAmount.toFixed(2)),
            });
        }

        // Update remaining amounts
        debtor.amount -= settleAmount;
        creditor.amount -= settleAmount;

        // Move to next person if fully settled
        if (debtor.amount < 0.01) i++;
        if (creditor.amount < 0.01) j++;
    }

    return debts;
};

/**
 * Calculate net balances from a list of expenses and settlements
 * 
 * @param expenses - Array of expenses with paidBy and participants
 * @param settlements - Array of settlements between members
 * @returns Record of userId to net balance
 */
export const calculateBalancesFromExpenses = (
    expenses: { paidBy: string; participants: { userId: string; share: number }[] }[],
    settlements: { fromUserId: string; toUserId: string; amount: number }[] = []
): Record<string, number> => {
    const balances: Record<string, number> = {};

    // Initialize balances
    expenses.forEach((expense) => {
        // Payer gets credit for the full amount
        balances[expense.paidBy] = (balances[expense.paidBy] || 0) +
            expense.participants.reduce((sum, p) => sum + p.share, 0) -
            (expense.participants.find(p => p.userId === expense.paidBy)?.share || 0);

        // Each participant owes their share (except the payer who already gets credit)
        expense.participants.forEach((participant) => {
            if (participant.userId !== expense.paidBy) {
                balances[participant.userId] = (balances[participant.userId] || 0) - participant.share;
            }
        });
    });

    // Apply settlements
    settlements.forEach((settlement) => {
        balances[settlement.fromUserId] = (balances[settlement.fromUserId] || 0) + settlement.amount;
        balances[settlement.toUserId] = (balances[settlement.toUserId] || 0) - settlement.amount;
    });

    return balances;
};

/**
 * Check if all debts are settled (all balances near zero)
 */
export const isSettled = (balances: Record<string, number>): boolean => {
    return Object.values(balances).every(balance => Math.abs(balance) < 0.01);
};
