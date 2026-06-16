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

/**
 * Keyword → canonical category, for deterministically categorizing an expense
 * from its title/description (offline, no model). First keyword hit wins.
 */
const CATEGORY_KEYWORDS: Record<string, readonly string[]> = {
  Food: ['food', 'dinner', 'lunch', 'breakfast', 'brunch', 'restaurant', 'eat', 'eating', 'groceries', 'grocery', 'meal', 'snack', 'dining', 'coffee', 'pizza', 'drinks', 'bar', 'beer', 'takeout', 'doordash', 'ubereats'],
  Transport: ['transport', 'gas', 'fuel', 'petrol', 'uber', 'lyft', 'taxi', 'cab', 'commute', 'train', 'bus', 'parking', 'toll', 'metro', 'ride'],
  Utilities: ['utility', 'utilities', 'electric', 'electricity', 'water', 'internet', 'wifi', 'rent', 'bill', 'phone', 'heating', 'trash', 'gas bill'],
  Entertainment: ['entertainment', 'movie', 'cinema', 'concert', 'netflix', 'spotify', 'game', 'show', 'tickets', 'event'],
  Shopping: ['shopping', 'amazon', 'walmart', 'target', 'clothes', 'clothing', 'shoes', 'mall', 'store', 'electronics'],
  Travel: ['travel', 'flight', 'hotel', 'airbnb', 'trip', 'vacation', 'airfare', 'booking', 'resort'],
  Health: ['health', 'doctor', 'pharmacy', 'medicine', 'gym', 'medical', 'dentist', 'hospital', 'clinic'],
};

/**
 * Best-effort category for a free-text expense title (e.g. "100 for gas" → Transport).
 * Returns `fallback` ('General') when nothing matches. Pure + offline.
 */
export function categorizeText(text: string | null | undefined, fallback: string = 'General'): string {
  if (typeof text !== 'string' || !text.trim()) return fallback;
  const q = ` ${text.toLowerCase()} `;
  for (const [category, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some((w) => q.includes(` ${w} `) || q.includes(`${w}s `) || q.includes(` ${w},`))) {
      return category;
    }
  }
  return fallback;
}
