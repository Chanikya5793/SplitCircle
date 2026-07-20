import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

describe('SplitCircleSplitMethodAppEnum ↔ ExpenseSplitMethod', () => {
  it('Swift enum cases match the TS ExpenseSplitMethod union exactly', () => {
    // Source of truth: the union in src/models/expense.ts (parsed as text — no RN import).
    const block = read('../../models/expense.ts').match(/export type ExpenseSplitMethod\s*=([\s\S]*?);/);
    if (!block) throw new Error('ExpenseSplitMethod union not found');
    const tsMethods = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

    // Swift: bare `case foo` ⇒ rawValue "foo"; honor an explicit `= "…"` if present.
    const swift = read('../../../modules/splitcircle-ai/ios/SplitCircleSplitMethod.swift');
    const swiftMethods = [...swift.matchAll(/case\s+(\w+)\s*(?:=\s*"([^"]+)")?/g)].map((m) => m[2] ?? m[1]);

    expect(new Set(swiftMethods)).toEqual(new Set(tsMethods));
    expect(swiftMethods.length).toBe(tsMethods.length); // catches dupes / one-sided adds
  });
});
