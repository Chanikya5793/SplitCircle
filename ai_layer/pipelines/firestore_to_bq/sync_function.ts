/**
 * sync_function.ts — Firestore → BigQuery streaming sync for the SplitCircle AI layer.
 *
 * IMPORTANT (Phase 1 correction): SplitCircle stores expenses and settlements as
 * EMBEDDED ARRAYS inside `groups/{groupId}` — there is no canonical flat
 * `/expenses/{id}` collection in production. So this sync triggers on group
 * writes and UNNESTS the arrays into flat BigQuery rows.
 *
 * Idempotency (Critical Rule #5): BigQuery streaming inserts use a deterministic
 * `insertId` (`${expenseId}:${updatedAt}`) so duplicate trigger fires de-dupe
 * within BigQuery's best-effort window. Rows are append-only; downstream views
 * select the latest `synced_at` per id.
 *
 * PII (Critical Rule #3): expense `title`/`notes` free text is NOT written here
 * beyond `title` (needed as a classifier feature) — `notes` is reduced to a
 * boolean `notes_present`. Never log expense text.
 *
 * Deploy as a Cloud Function v2 (Node 22) alongside the existing `functions/`.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as logger from 'firebase-functions/logger';
import { BigQuery } from '@google-cloud/bigquery';
import { loadFxConfig, fxNormalize } from './fx';

const DATASET = process.env.BQ_DATASET || 'splitcircle_ml';
const bq = new BigQuery();
const FX = loadFxConfig();

/** Minimal shapes mirroring src/models (kept local — this deploys independently). */
interface RawParticipant { userId?: string; share?: number }
interface RawExpense {
  expenseId: string;
  groupId?: string;
  title?: string;
  description?: string; // legacy drift — tolerated as fallback
  category?: string;
  amount?: number;
  paidBy?: string;
  splitType?: string;
  splitMetadata?: { method?: string };
  participants?: RawParticipant[];
  settled?: boolean;
  notes?: string;
  receipt?: unknown;
  recurring?: unknown;
  createdAt?: number;
  updatedAt?: number;
}
interface RawSettlement {
  settlementId: string;
  fromUserId?: string;
  toUserId?: string;
  amount?: number;
  status?: string;
  createdAt?: number;
}

/** Firestore epoch-ms → BigQuery TIMESTAMP literal. */
function toBqTimestamp(ms: number | undefined | null): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Map one embedded expense to a BigQuery row. */
export function mapExpenseRow(groupId: string, currency: string, e: RawExpense, syncedAt: string) {
  const participantIds = (e.participants ?? [])
    .map((p) => p.userId)
    .filter((id): id is string => typeof id === 'string');
  const amount = typeof e.amount === 'number' ? e.amount : 0;
  const fx = fxNormalize(amount, currency, FX);
  return {
    expense_id: e.expenseId,
    group_id: groupId,
    title: e.title ?? e.description ?? null,
    category: e.category ?? null,
    amount,
    currency: currency || null,
    amount_normalized: fx.amount_normalized,
    normalized_currency: fx.normalized_currency,
    fx_rate: fx.fx_rate,
    paid_by: e.paidBy ?? '',
    split_type: e.splitType ?? null,
    split_method: e.splitMetadata?.method ?? null,
    participant_ids: participantIds,
    participant_count: participantIds.length,
    settled: Boolean(e.settled),
    has_receipt: Boolean(e.receipt),
    is_recurring: Boolean(e.recurring),
    notes_present: typeof e.notes === 'string' && e.notes.trim().length > 0,
    created_at: toBqTimestamp(e.createdAt) ?? syncedAt,
    updated_at: toBqTimestamp(e.updatedAt),
    synced_at: syncedAt,
  };
}

/** Map one embedded settlement to a BigQuery row. */
export function mapSettlementRow(groupId: string, currency: string, s: RawSettlement, syncedAt: string) {
  const amount = typeof s.amount === 'number' ? s.amount : 0;
  const fx = fxNormalize(amount, currency, FX);
  return {
    settlement_id: s.settlementId,
    group_id: groupId,
    from_user_id: s.fromUserId ?? '',
    to_user_id: s.toUserId ?? '',
    amount,
    currency: currency || null,
    amount_normalized: fx.amount_normalized,
    normalized_currency: fx.normalized_currency,
    fx_rate: fx.fx_rate,
    status: s.status ?? null,
    created_at: toBqTimestamp(s.createdAt) ?? syncedAt,
    synced_at: syncedAt,
  };
}

async function insertRows(table: string, rows: Array<{ insertId: string; json: object }>): Promise<void> {
  if (rows.length === 0) return;
  // `raw: true` lets us supply a deterministic per-row insertId for best-effort
  // de-dup (the BigQuery client has no `insertIds` option — the id rides on each row).
  await bq.dataset(DATASET).table(table).insert(
    rows.map((r) => ({ insertId: r.insertId, json: r.json })),
    { raw: true, skipInvalidRows: false },
  );
}

/**
 * Core: unnest a group doc's expenses + settlements + summary into BigQuery rows.
 * Decoupled from the Functions event shape so the consolidated `onGroupWritten`
 * orchestrator (in `functions/`) can call it directly — one trigger, not three
 * (Phase 4 §2). Append-only; idempotent via deterministic insertIds.
 */
export async function runBqSyncForGroup(
  groupId: string,
  after: Record<string, unknown> | undefined,
): Promise<{ expenses: number; settlements: number }> {
  const syncedAt = new Date().toISOString();

  // Deletion: a production system would also tombstone BQ rows / delete vectors
  // (right-to-erasure, Phase 4 §7). Left as a documented extension point.
  if (!after) {
    logger.info('group deleted — skipping BQ upsert (see erasure extension point)', { groupId });
    return { expenses: 0, settlements: 0 };
  }

  const currency = (after.currency as string) || 'USD';
  const expenses = Array.isArray(after.expenses) ? (after.expenses as RawExpense[]) : [];
  const settlements = Array.isArray(after.settlements) ? (after.settlements as RawSettlement[]) : [];
  const memberIds = Array.isArray(after.memberIds) ? (after.memberIds as string[]) : [];

  try {
    await insertRows(
      'expenses',
      expenses
        .filter((e) => e && e.expenseId)
        .map((e) => ({
          insertId: `${e.expenseId}:${e.updatedAt ?? e.createdAt ?? ''}`,
          json: mapExpenseRow(groupId, currency, e, syncedAt),
        })),
    );

    await insertRows(
      'settlements',
      settlements
        .filter((s) => s && s.settlementId)
        .map((s) => ({
          insertId: `${s.settlementId}:${s.createdAt ?? ''}`,
          json: mapSettlementRow(groupId, currency, s, syncedAt),
        })),
    );

    await insertRows('groups', [{
      insertId: `${groupId}:${(after.updatedAt as number) ?? ''}`,
      json: {
        group_id: groupId,
        name: (after.name as string) ?? null,
        currency,
        member_ids: memberIds,
        member_count: memberIds.length,
        created_by: (after.createdBy as string) ?? null,
        created_at: toBqTimestamp(after.createdAt as number),
        updated_at: toBqTimestamp(after.updatedAt as number),
        synced_at: syncedAt,
      },
    }]);

    logger.info('Synced group to BigQuery', {
      groupId, expenses: expenses.length, settlements: settlements.length,
    });
    return { expenses: expenses.length, settlements: settlements.length };
  } catch (err) {
    // Do not log row contents (PII). Log counts + error name only.
    logger.error('BigQuery sync failed', {
      groupId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    throw err; // let Functions retry
  }
}

/**
 * Trigger: any write to a group document (standalone deploy). Thin wrapper over
 * `runBqSyncForGroup` — prefer the consolidated `onGroupWritten` in production.
 */
export const syncGroupToBigQuery = onDocumentWritten('groups/{groupId}', async (event) => {
  await runBqSyncForGroup(event.params.groupId, event.data?.after?.data());
});
