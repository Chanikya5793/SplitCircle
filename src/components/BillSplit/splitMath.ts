import type { ItemCategory, Participant, ReceiptItem, ValidationResult } from './types';

/** Crypto-quality random float in [0, 1) */
function cryptoRandom(): number {
  const arr = new Uint32Array(1);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(arr);
  } else {
    arr[0] = (Math.random() * 0xffffffff) >>> 0;
  }
  return arr[0] / 0x100000000;
}

/** Convert dollars to integer cents to avoid floating-point drift. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Convert integer cents back to dollars. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** Round a dollar amount to 2 decimal places. */
export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Distribute totalCents into `count` integer-cent buckets.
 * Remainder pennies go to the first N participants (index 0 = payer convention).
 */
export function distributeEvenly(totalCents: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

// ─── EQUAL ──────────────────────────────────────────────────────────────────
export function computeEqual(total: number, participants: Participant[]): Participant[] {
  const included = participants.filter((p) => p.included);
  if (included.length === 0) return participants.map((p) => ({ ...p, computedAmount: 0 }));

  const cents = distributeEvenly(toCents(total), included.length);
  let idx = 0;
  return participants.map((p) => ({
    ...p,
    computedAmount: p.included ? fromCents(cents[idx++]) : 0,
  }));
}

// ─── EXACT AMOUNTS ──────────────────────────────────────────────────────────
export function computeExact(participants: Participant[]): Participant[] {
  return participants.map((p) => ({
    ...p,
    computedAmount: p.included ? roundCents(p.exactAmount) : 0,
  }));
}

// ─── PERCENTAGE ─────────────────────────────────────────────────────────────
export function computePercentage(total: number, participants: Participant[]): Participant[] {
  const included = participants.filter((p) => p.included);
  if (included.length === 0) return participants.map((p) => ({ ...p, computedAmount: 0 }));

  const totalCents = toCents(total);
  const rawCents = included.map((p) => (p.percentage / 100) * totalCents);
  const flooredCents = rawCents.map((c) => Math.floor(c));
  const allocated = flooredCents.reduce((a, b) => a + b, 0);
  let remainder = totalCents - allocated;

  // distribute remainder by largest fractional part
  const fractions = rawCents
    .map((c, i) => ({ i, frac: c - Math.floor(c) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of fractions) {
    if (remainder <= 0) break;
    flooredCents[i] += 1;
    remainder -= 1;
  }

  let idx = 0;
  return participants.map((p) => ({
    ...p,
    computedAmount: p.included ? fromCents(flooredCents[idx++]) : 0,
  }));
}

// ─── SHARES ─────────────────────────────────────────────────────────────────
export function computeShares(total: number, participants: Participant[]): Participant[] {
  const included = participants.filter((p) => p.included);
  const totalShares = included.reduce((s, p) => s + p.shares, 0);
  if (totalShares === 0) return participants.map((p) => ({ ...p, computedAmount: 0 }));

  const totalCents = toCents(total);
  const rawCents = included.map((p) => (p.shares / totalShares) * totalCents);
  const flooredCents = rawCents.map((c) => Math.floor(c));
  const allocated = flooredCents.reduce((a, b) => a + b, 0);
  let remainder = totalCents - allocated;

  const fractions = rawCents
    .map((c, i) => ({ i, frac: c - Math.floor(c) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of fractions) {
    if (remainder <= 0) break;
    flooredCents[i] += 1;
    remainder -= 1;
  }

  let idx = 0;
  return participants.map((p) => ({
    ...p,
    computedAmount: p.included ? fromCents(flooredCents[idx++]) : 0,
  }));
}

// ─── ADJUSTMENT (+/-) ───────────────────────────────────────────────────────
export function computeAdjustment(total: number, participants: Participant[]): Participant[] {
  const included = participants.filter((p) => p.included);
  if (included.length === 0) return participants.map((p) => ({ ...p, computedAmount: 0 }));

  const totalAdjustmentCents = included.reduce((s, p) => s + toCents(p.adjustment), 0);
  const remainingCents = toCents(total) - totalAdjustmentCents;
  const baseParts = distributeEvenly(Math.max(0, remainingCents), included.length);

  let idx = 0;
  return participants.map((p) => {
    if (!p.included) return { ...p, computedAmount: 0 };
    const base = baseParts[idx++];
    return { ...p, computedAmount: fromCents(base + toCents(p.adjustment)) };
  });
}

// ─── ITEMIZED RECEIPT ───────────────────────────────────────────────────────
export function computeItemized(
  items: ReceiptItem[],
  taxAmount: number,
  tipAmount: number,
  participants: Participant[],
): Participant[] {
  const subtotalCents = items.reduce((s, it) => s + toCents(it.price), 0);
  if (subtotalCents === 0) return participants.map((p) => ({ ...p, computedAmount: 0 }));

  // each participant's raw subtotal share
  const participantSubtotals: Record<string, number> = {};
  for (const p of participants) participantSubtotals[p.id] = 0;

  for (const item of items) {
    if (item.assignedTo.length === 0) continue;
    const perPersonCents = distributeEvenly(toCents(item.price), item.assignedTo.length);
    item.assignedTo.forEach((uid, i) => {
      if (participantSubtotals[uid] !== undefined) {
        participantSubtotals[uid] += perPersonCents[i];
      }
    });
  }

  // prorate tax & tip by subtotal ratio
  const extrasCents = toCents(taxAmount) + toCents(tipAmount);
  return participants.map((p) => {
    const mySub = participantSubtotals[p.id] || 0;
    const myExtra = subtotalCents > 0 ? Math.round((mySub / subtotalCents) * extrasCents) : 0;
    return { ...p, computedAmount: fromCents(mySub + myExtra) };
  });
}

// ─── INCOME-PROPORTIONAL ────────────────────────────────────────────────────
export function computeIncome(total: number, participants: Participant[]): Participant[] {
  const included = participants.filter((p) => p.included);
  const totalWeight = included.reduce((s, p) => s + p.incomeWeight, 0);
  if (totalWeight === 0) return participants.map((p) => ({ ...p, computedAmount: 0 }));

  const totalCents = toCents(total);
  const rawCents = included.map((p) => (p.incomeWeight / totalWeight) * totalCents);
  const flooredCents = rawCents.map((c) => Math.floor(c));
  const allocated = flooredCents.reduce((a, b) => a + b, 0);
  let remainder = totalCents - allocated;

  const fractions = rawCents
    .map((c, i) => ({ i, frac: c - Math.floor(c) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of fractions) {
    if (remainder <= 0) break;
    flooredCents[i] += 1;
    remainder -= 1;
  }

  let idx = 0;
  return participants.map((p) => ({
    ...p,
    computedAmount: p.included ? fromCents(flooredCents[idx++]) : 0,
  }));
}

// ─── CONSUMPTION / FRACTION ─────────────────────────────────────────────────
export function computeConsumption(total: number, totalParts: number, participants: Participant[]): Participant[] {
  const included = participants.filter((p) => p.included);
  const consumedParts = included.reduce((s, p) => s + p.partsConsumed, 0);
  if (consumedParts === 0 || totalParts === 0) {
    return participants.map((p) => ({ ...p, computedAmount: 0 }));
  }

  const totalCents = toCents(total);
  const rawCents = included.map((p) => (p.partsConsumed / totalParts) * totalCents);
  const flooredCents = rawCents.map((c) => Math.floor(c));
  const allocated = flooredCents.reduce((a, b) => a + b, 0);
  let remainder = totalCents - allocated;

  const fractions = rawCents
    .map((c, i) => ({ i, frac: c - Math.floor(c) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of fractions) {
    if (remainder <= 0) break;
    flooredCents[i] += 1;
    remainder -= 1;
  }

  let idx = 0;
  return participants.map((p) => ({
    ...p,
    computedAmount: p.included ? fromCents(flooredCents[idx++]) : 0,
  }));
}

// ─── TIME-BASED / PRORATED ──────────────────────────────────────────────────
export function computeTimeBased(total: number, participants: Participant[]): Participant[] {
  const included = participants.filter((p) => p.included);
  const totalDays = included.reduce((s, p) => s + p.daysStayed, 0);
  if (totalDays === 0) return participants.map((p) => ({ ...p, computedAmount: 0 }));

  const totalCents = toCents(total);
  const rawCents = included.map((p) => (p.daysStayed / totalDays) * totalCents);
  const flooredCents = rawCents.map((c) => Math.floor(c));
  const allocated = flooredCents.reduce((a, b) => a + b, 0);
  let remainder = totalCents - allocated;

  const fractions = rawCents
    .map((c, i) => ({ i, frac: c - Math.floor(c) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of fractions) {
    if (remainder <= 0) break;
    flooredCents[i] += 1;
    remainder -= 1;
  }

  let idx = 0;
  return participants.map((p) => ({
    ...p,
    computedAmount: p.included ? fromCents(flooredCents[idx++]) : 0,
  }));
}

// ─── GAMIFIED: ROULETTE ─────────────────────────────────────────────────────
export function computeRoulette(total: number, participants: Participant[]): { participants: Participant[]; loserId: string } {
  const included = participants.filter((p) => p.included);
  if (included.length === 0) return { participants: participants.map((p) => ({ ...p, computedAmount: 0 })), loserId: '' };

  const loserIdx = Math.floor(cryptoRandom() * included.length);
  const loserId = included[loserIdx].id;
  return {
    participants: participants.map((p) => ({
      ...p,
      computedAmount: p.id === loserId ? roundCents(total) : 0,
    })),
    loserId,
  };
}

export function computeWeightedRoulette(
  total: number,
  participants: Participant[],
): { participants: Participant[]; loserId: string } {
  const included = participants.filter((p) => p.included);
  const totalWeight = included.reduce((s, p) => s + p.rouletteWeight, 0);
  if (totalWeight === 0 || included.length === 0) {
    return { participants: participants.map((p) => ({ ...p, computedAmount: 0 })), loserId: '' };
  }

  const rand = cryptoRandom() * totalWeight;
  let cumulative = 0;
  let loserId = included[0].id;
  for (const p of included) {
    cumulative += p.rouletteWeight;
    if (rand <= cumulative) {
      loserId = p.id;
      break;
    }
  }

  return {
    participants: participants.map((p) => ({
      ...p,
      computedAmount: p.id === loserId ? roundCents(total) : 0,
    })),
    loserId,
  };
}

export function computeScrooge(total: number, participants: Participant[]): { participants: Participant[]; loserId: string } {
  const included = participants.filter((p) => p.included);
  if (included.length === 0) return { participants: participants.map((p) => ({ ...p, computedAmount: 0 })), loserId: '' };

  // find the person who has paid the least historically
  const sorted = [...included].sort((a, b) => a.historicalPaid - b.historicalPaid);
  const loserId = sorted[0].id;

  return {
    participants: participants.map((p) => ({
      ...p,
      computedAmount: p.id === loserId ? roundCents(total) : 0,
    })),
    loserId,
  };
}

// ─── KARMA SPLIT (fair rebalancing based on payment history) ────────────────
export function computeKarma(
  total: number,
  participants: Participant[],
  intensity: number, // 0..1 where 0 = equal, 1 = full karma correction
): Participant[] {
  const included = participants.filter((p) => p.included);
  if (included.length === 0) return participants.map((p) => ({ ...p, computedAmount: 0 }));

  const totalCents = toCents(total);
  const equalShareCents = totalCents / included.length;
  const avgPaid = included.reduce((s, p) => s + p.historicalPaid, 0) / included.length;
  const maxDev = Math.max(...included.map((p) => Math.abs(p.historicalPaid - avgPaid)), 1);

  // Overpayers (positive deviation) get a lower share; underpayers get a higher share
  const rawShares = included.map((p) => {
    const normalizedDev = (p.historicalPaid - avgPaid) / maxDev; // -1..1
    const multiplier = 1 - normalizedDev * intensity * 0.8; // cap correction at 80%
    return Math.max(0, equalShareCents * multiplier);
  });

  // Normalize to total
  const rawSum = rawShares.reduce((a, b) => a + b, 0);
  const normalizedCents = rawShares.map((s) =>
    rawSum > 0 ? Math.round((s / rawSum) * totalCents) : Math.round(equalShareCents),
  );

  // Fix rounding remainder
  const computedSum = normalizedCents.reduce((a, b) => a + b, 0);
  const diff = totalCents - computedSum;
  if (diff !== 0 && normalizedCents.length > 0) {
    normalizedCents[0] += diff;
  }

  let idx = 0;
  return participants.map((p) => ({
    ...p,
    computedAmount: p.included ? fromCents(normalizedCents[idx++]) : 0,
  }));
}

// ─── ITEM-TYPE SPLIT ────────────────────────────────────────────────────────
export function computeItemType(
  total: number,
  categories: ItemCategory[],
  participants: Participant[],
): Participant[] {
  const included = participants.filter((p) => p.included);
  if (included.length === 0) return participants.map((p) => ({ ...p, computedAmount: 0 }));

  const categorizedTotal = categories.reduce((s, c) => s + toCents(c.amount), 0);
  const remainderCents = toCents(total) - categorizedTotal;

  // accumulate per-person cents
  const personCents: Record<string, number> = {};
  for (const p of included) personCents[p.id] = 0;

  // distribute each category among non-excluded included participants
  for (const cat of categories) {
    const eligible = included.filter((p) => !cat.excludedParticipants.includes(p.id));
    if (eligible.length === 0) continue;
    const parts = distributeEvenly(toCents(cat.amount), eligible.length);
    eligible.forEach((p, i) => {
      personCents[p.id] += parts[i];
    });
  }

  // distribute remainder equally among all included
  if (remainderCents > 0) {
    const parts = distributeEvenly(remainderCents, included.length);
    included.forEach((p, i) => {
      personCents[p.id] += parts[i];
    });
  }

  return participants.map((p) => ({
    ...p,
    computedAmount: p.included ? fromCents(personCents[p.id] || 0) : 0,
  }));
}

// ─── VALIDATION ─────────────────────────────────────────────────────────────
export function validateSplit(total: number, participants: Participant[]): ValidationResult {
  const allocatedCents = participants.reduce((s, p) => s + toCents(p.computedAmount), 0);
  const totalCents = toCents(total);
  const diffCents = allocatedCents - totalCents;

  if (Math.abs(diffCents) <= 1) {
    // allow 1 cent tolerance for rounding
    return { isValid: true, message: '', difference: 0 };
  }

  const diff = fromCents(diffCents);
  if (diff > 0) {
    return { isValid: false, message: `Over by $${Math.abs(diff).toFixed(2)}`, difference: diff };
  }
  return { isValid: false, message: `Under by $${Math.abs(diff).toFixed(2)}`, difference: diff };
}
