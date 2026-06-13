/**
 * categoryMatch.ts — canonical expense categories + a pure coercion helper that
 * snaps a model's free-text category answer onto the app's fixed list. No
 * RN/native imports so it stays unit-testable.
 */

export const EXPENSE_CATEGORIES = [
  'General',
  'Food',
  'Transport',
  'Utilities',
  'Entertainment',
  'Shopping',
  'Travel',
  'Health',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');

/**
 * Snap a raw category string onto `allowed`: exact (case-insensitive) match
 * first, then a contains-match either direction; otherwise the fallback. Guards
 * against the model returning extra words, punctuation, or an off-list value.
 */
export function coerceCategory(
  raw: string | null | undefined,
  fallback: string = 'General',
  allowed: readonly string[] = EXPENSE_CATEGORIES,
): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const r = norm(raw);
  if (!r) return fallback;

  const exact = allowed.find((c) => norm(c) === r);
  if (exact) return exact;

  const contains = allowed.find((c) => {
    const n = norm(c);
    return n.length > 0 && (r.includes(n) || n.includes(r));
  });
  return contains ?? fallback;
}
