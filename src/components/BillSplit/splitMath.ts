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

  // each participant's raw subtotal share (only for included participants)
  const included = participants.filter((p) => p.included);
  const participantSubtotals: Record<string, number> = {};
  for (const p of included) participantSubtotals[p.id] = 0;

  for (const item of items) {
    // only assign to included participants
    const validAssignees = item.assignedTo.filter((uid) => participantSubtotals[uid] !== undefined);
    if (validAssignees.length === 0) continue;
    const perPersonCents = distributeEvenly(toCents(item.price), validAssignees.length);
    validAssignees.forEach((uid, i) => {
      participantSubtotals[uid] += perPersonCents[i];
    });
  }

  // prorate tax & tip by subtotal ratio using fractional-remainder to avoid drift
  const extrasCents = toCents(taxAmount) + toCents(tipAmount);

  if (extrasCents === 0 || subtotalCents === 0) {
    return participants.map((p) => ({
      ...p,
      computedAmount: p.included ? fromCents(participantSubtotals[p.id] || 0) : 0,
    }));
  }

  // Use largest-remainder method to distribute extras without drift
  const rawExtras = included.map((p) => ((participantSubtotals[p.id] || 0) / subtotalCents) * extrasCents);
  const flooredExtras = rawExtras.map((c) => Math.floor(c));
  let allocatedExtras = flooredExtras.reduce((a, b) => a + b, 0);
  let remainderExtras = extrasCents - allocatedExtras;

  const fractions = rawExtras
    .map((c, i) => ({ i, frac: c - Math.floor(c) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of fractions) {
    if (remainderExtras <= 0) break;
    flooredExtras[i] += 1;
    remainderExtras -= 1;
  }

  const includedResults: Record<string, number> = {};
  included.forEach((p, idx) => {
    includedResults[p.id] = (participantSubtotals[p.id] || 0) + flooredExtras[idx];
  });

  return participants.map((p) => ({
    ...p,
    computedAmount: p.included ? fromCents(includedResults[p.id] || 0) : 0,
  }));
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

// ─── TIME-BASED HELPERS ─────────────────────────────────────────────────────
function parseDateOnly(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const day = Number(dayText);
  const date = new Date(year, monthIndex, day);

  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== monthIndex
    || date.getDate() !== day
  ) {
    return null;
  }

  date.setHours(0, 0, 0, 0);
  return date;
}

function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function daysBetweenDates(checkIn: string, checkOut: string): number {
  const d1 = parseDateOnly(checkIn);
  const d2 = parseDateOnly(checkOut);
  if (!d1 || !d2) return 0;
  const diffMs = d2.getTime() - d1.getTime();
  const ONE_DAY_MS = 1000 * 60 * 60 * 24;
  return Math.max(0, Math.floor(diffMs / ONE_DAY_MS) + 1);
}

export function listDatesBetween(checkIn: string, checkOut: string): string[] {
  const start = parseDateOnly(checkIn);
  const end = parseDateOnly(checkOut);
  if (!start || !end || end.getTime() < start.getTime()) return [];

  const dates: string[] = [];
  const current = new Date(start);
  while (current.getTime() <= end.getTime()) {
    dates.push(formatDateOnly(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
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

export function computeStandardTimeBased(total: number, periodDays: number, participants: Participant[]): Participant[] {
  const included = participants.filter((participant) => participant.included);
  const participantCount = included.length;
  const normalizedPeriodDays = Math.max(1, Math.round(periodDays));

  if (participantCount === 0) {
    return participants.map((participant) => ({ ...participant, computedAmount: 0 }));
  }

  if (participantCount === 1) {
    const onlyParticipantId = included[0].id;
    return participants.map((participant) => ({
      ...participant,
      computedAmount: participant.id === onlyParticipantId ? roundCents(total) : 0,
    }));
  }

  const basePerPersonPerDay = total / normalizedPeriodDays / participantCount;
  const totalMissingDays = included.reduce((sum, participant) => (
    sum + Math.max(0, normalizedPeriodDays - Math.min(normalizedPeriodDays, Math.max(0, participant.daysStayed)))
  ), 0);

  const totalCents = toCents(total);
  const rawCents = included.map((participant) => {
    const normalizedStayedDays = Math.min(normalizedPeriodDays, Math.max(0, participant.daysStayed));
    const ownDaysCost = normalizedStayedDays * basePerPersonPerDay;
    const participantMissingDays = Math.max(0, normalizedPeriodDays - normalizedStayedDays);
    const redistributedCost = (totalMissingDays - participantMissingDays) * basePerPersonPerDay / (participantCount - 1);
    return (ownDaysCost + redistributedCost) * 100;
  });
  const flooredCents = rawCents.map((value) => Math.floor(value));
  const allocated = flooredCents.reduce((sum, value) => sum + value, 0);
  let remainder = totalCents - allocated;

  const fractions = rawCents
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (const { index } of fractions) {
    if (remainder <= 0) break;
    flooredCents[index] += 1;
    remainder -= 1;
  }

  let includedIndex = 0;
  return participants.map((participant) => ({
    ...participant,
    computedAmount: participant.included ? fromCents(flooredCents[includedIndex++]) : 0,
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
    return { isValid: false, message: `Over by ${Math.abs(diff).toFixed(2)}`, difference: diff };
  }
  return { isValid: false, message: `Under by ${Math.abs(diff).toFixed(2)}`, difference: diff };
}
