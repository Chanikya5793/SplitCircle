/**
 * receipt_split.ts — Itemized split from receipt line items (Sprint 5 receipts).
 *
 * Pure logic that turns assigned line items (the existing `ExpenseReceiptItem`
 * shape: `{ price, quantity?, assignedTo[] }`) into per-user totals, prorating tax
 * and tip by each user's item subtotal. This is the deterministic core a receipts
 * MCP tool / Document AI flow calls after extraction; tested without any API.
 */

export interface ReceiptItem {
  id?: string;
  name?: string;
  price: number;
  quantity?: number;
  assignedTo: string[]; // userIds sharing this line item equally
}

export interface ItemizedSplit {
  perUser: Record<string, number>;
  unassignedTotal: number;
  total: number;
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * Split items across assignees, then prorate tax + tip by each user's subtotal.
 * Items with no assignee are pooled into `unassignedTotal` (not silently dropped).
 */
export function suggestItemizedSplit(
  items: ReceiptItem[],
  opts: { tax?: number; tip?: number } = {},
): ItemizedSplit {
  const subtotal: Record<string, number> = {};
  let unassignedTotal = 0;

  for (const it of (Array.isArray(items) ? items : [])) {
    const lineTotal = (Number(it.price) || 0) * (it.quantity && it.quantity > 0 ? it.quantity : 1);
    const who = Array.isArray(it.assignedTo) ? it.assignedTo.filter(Boolean) : [];
    if (who.length === 0) {
      unassignedTotal += lineTotal;
      continue;
    }
    const each = lineTotal / who.length;
    for (const uid of who) subtotal[uid] = (subtotal[uid] ?? 0) + each;
  }

  const assignedSum = Object.values(subtotal).reduce((s, v) => s + v, 0);
  const extras = (Number(opts.tax) || 0) + (Number(opts.tip) || 0);

  const perUser: Record<string, number> = {};
  for (const [uid, sub] of Object.entries(subtotal)) {
    const share = assignedSum > 0 ? (sub / assignedSum) * extras : 0;
    perUser[uid] = cents(sub + share);
  }

  const total = cents(assignedSum + extras + unassignedTotal);
  return { perUser, unassignedTotal: cents(unassignedTotal), total };
}
