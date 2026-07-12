/**
 * splitHistoryService — on-device memory for the split-options screen.
 *
 * Every confirmed split is recorded per group (device-local, never synced).
 * Suggestions are then derived from what this group ACTUALLY does — the last
 * split can be repeated verbatim, and the habitual method/payer surface once
 * a real pattern exists (recency-weighted frequency). No history → no chips.
 * The engine genuinely improves with use, which is the whole point: it
 * replaces the old hardcoded placeholder suggestions.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type HistoryMethod =
  | 'equal' | 'exact' | 'percentage' | 'shares' | 'adjustment'
  | 'itemized' | 'income' | 'consumption' | 'timeBased' | 'gamified' | 'itemType';

export interface SplitRecord {
  at: number;
  method: HistoryMethod;
  gamifiedMode?: string;
  payerId: string;
  payerName: string;
  includedIds: string[];
  totalAmount: number;
  /** Per-user ratio of the total (0–1), for methods where re-applying makes sense. */
  ratios?: Record<string, number>;
}

export interface SplitSuggestion {
  id: 'repeat_last' | 'usual_method' | 'usual_payer';
  icon: string;
  label: string;
  record?: SplitRecord;
  method?: HistoryMethod;
  payerId?: string;
}

const KEY_PREFIX = '@split_history_v1:';
const MAX_RECORDS = 40;

const METHOD_LABELS: Record<HistoryMethod, string> = {
  equal: 'Equal',
  exact: 'Exact amounts',
  percentage: 'Percentages',
  shares: 'Shares',
  adjustment: 'Adjustments',
  itemized: 'Receipt items',
  income: 'By income',
  consumption: 'By consumption',
  timeBased: 'Time-based',
  gamified: 'Fun mode',
  itemType: 'By category',
};

async function load(contextKey: string): Promise<SplitRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFIX + contextKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function recordSplit(contextKey: string, record: SplitRecord): Promise<void> {
  if (!contextKey) return;
  try {
    const records = await load(contextKey);
    records.unshift(record);
    await AsyncStorage.setItem(KEY_PREFIX + contextKey, JSON.stringify(records.slice(0, MAX_RECORDS)));
  } catch {
    // History is best-effort; never block the Done flow.
  }
}

/** Human label for a record, e.g. "Percentages 60/40" or "Equal · 4 people". */
function describeRecord(record: SplitRecord): string {
  const base = METHOD_LABELS[record.method] ?? record.method;
  if (record.ratios && (record.method === 'percentage' || record.method === 'shares' || record.method === 'income')) {
    const parts = record.includedIds
      .map((id) => record.ratios?.[id] ?? 0)
      .filter((r) => r > 0)
      .map((r) => Math.round(r * 100));
    if (parts.length >= 2 && parts.length <= 3) {
      return `${base} ${parts.join('/')}`;
    }
  }
  return `${base} · ${record.includedIds.length} ${record.includedIds.length === 1 ? 'person' : 'people'}`;
}

/**
 * Rank suggestions from history. Frequency is recency-weighted (0.85^age) so
 * the group's CURRENT habit wins over ancient ones — this is what makes the
 * chips sharpen with every recorded split.
 */
export async function getSuggestions(
  contextKey: string,
  currentPayerId: string,
): Promise<SplitSuggestion[]> {
  if (!contextKey) return [];
  const records = await load(contextKey);
  if (records.length === 0) return [];

  const suggestions: SplitSuggestion[] = [];
  const last = records[0];

  suggestions.push({
    id: 'repeat_last',
    icon: 'history',
    label: `Repeat last: ${describeRecord(last)}`,
    record: last,
  });

  // Habitual method — needs at least 3 records to call anything a habit.
  if (records.length >= 3) {
    const weights = new Map<HistoryMethod, number>();
    let total = 0;
    records.forEach((r, i) => {
      const w = Math.pow(0.85, i);
      weights.set(r.method, (weights.get(r.method) ?? 0) + w);
      total += w;
    });
    const [topMethod, topWeight] = [...weights.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topMethod !== last.method && topWeight / total >= 0.4) {
      suggestions.push({
        id: 'usual_method',
        icon: 'star-four-points',
        label: `Usual here: ${METHOD_LABELS[topMethod]}`,
        method: topMethod,
      });
    }

    // Habitual payer — only when it disagrees with the current selection.
    const payerWeights = new Map<string, { w: number; name: string }>();
    records.forEach((r, i) => {
      const w = Math.pow(0.85, i);
      const entry = payerWeights.get(r.payerId) ?? { w: 0, name: r.payerName };
      entry.w += w;
      payerWeights.set(r.payerId, entry);
    });
    const [topPayerId, topPayer] = [...payerWeights.entries()].sort((a, b) => b[1].w - a[1].w)[0];
    if (topPayerId !== currentPayerId && topPayer.w / total >= 0.6 && topPayer.name) {
      suggestions.push({
        id: 'usual_payer',
        icon: 'account-cash',
        label: `${topPayer.name} usually pays`,
        payerId: topPayerId,
      });
    }
  }

  return suggestions;
}
