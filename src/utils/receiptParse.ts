/**
 * receiptParse.ts — pure helpers for the on-device receipt parser. No RN /
 * native imports so they're unit-testable. The orchestration (native call,
 * availability, learning lookup) lives in src/services/onDeviceReceiptService.ts.
 */

/** Raw structural shape returned by the native `parseReceiptStructured`. */
export interface OnDeviceReceiptRaw {
  items?: { name?: string; price?: number; quantity?: number }[];
  merchantName?: string;
  date?: string;
  subtotal?: number;
  tax?: number;
  tip?: number;
  total?: number;
}

export interface OnDeviceReceiptParsed {
  items: { name: string; price: number; quantity: number }[];
  merchantName: string | null;
  date: string | null;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number | null;
}

// Names come from user-entered corrections, so neutralize characters that would
// break the quoted, one-per-line few-shot block (newlines, embedded quotes).
const sanitizeHintText = (s: string): string =>
  s.replace(/[\r\n]+/g, ' ').replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim();

/** Render learned name corrections as a compact few-shot block for the prompt. */
export const buildReceiptFewShot = (
  hints: readonly { from: string; to: string }[],
): string =>
  hints
    .map((h) => ({ from: sanitizeHintText(h.from), to: sanitizeHintText(h.to) }))
    .filter((h) => h.from && h.to)
    .map((h) => `- "${h.from}" -> "${h.to}"`)
    .join('\n');

const positive = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;

/** Normalize + validate the raw native result into app-friendly fields. */
export const mapOnDeviceReceipt = (r: OnDeviceReceiptRaw): OnDeviceReceiptParsed => ({
  items: (r.items ?? [])
    .filter(
      (i): i is { name: string; price: number; quantity?: number } =>
        !!i &&
        typeof i.price === 'number' &&
        Number.isFinite(i.price) &&
        i.price > 0 &&
        typeof i.name === 'string' &&
        i.name.trim().length > 0,
    )
    .map((i) => ({
      name: i.name.trim(),
      price: i.price,
      quantity: Number.isInteger(i.quantity) && (i.quantity as number) > 0 ? (i.quantity as number) : 1,
    })),
  merchantName: typeof r.merchantName === 'string' && r.merchantName.trim() ? r.merchantName.trim() : null,
  date: typeof r.date === 'string' && r.date.trim() ? r.date.trim() : null,
  subtotal: positive(r.subtotal),
  tax: positive(r.tax),
  tip: positive(r.tip),
  total: positive(r.total),
});
