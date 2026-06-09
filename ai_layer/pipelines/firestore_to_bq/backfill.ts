/**
 * backfill.ts — One-time backfill of all existing Firestore data into BigQuery.
 *
 * Reads every `groups/{groupId}` document, unnests embedded `expenses[]` and
 * `settlements[]` (Phase 1 model), and batch-loads them into the `splitcircle_ml`
 * dataset. Reuses the same row mappers as the streaming `sync_function` so
 * backfilled and live rows are identical in shape.
 *
 * Run locally with Application Default Credentials (a service account with
 * Firestore read + BigQuery dataEditor):
 *
 *   GCP_PROJECT_ID=my-proj BQ_DATASET=splitcircle_ml \
 *   GOOGLE_APPLICATION_CREDENTIALS=./sa.json \
 *   npx ts-node backfill.ts
 *
 * Idempotent: uses deterministic insertIds, so re-running de-dupes within
 * BigQuery's streaming window; for a clean reload, truncate the tables first.
 */

import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { BigQuery } from '@google-cloud/bigquery';
import { mapExpenseRow, mapSettlementRow } from './sync_function';

const DATASET = process.env.BQ_DATASET || 'splitcircle_ml';
const BATCH = 500;

if (getApps().length === 0) {
  initializeApp({ credential: applicationDefault() });
}
const db = getFirestore();
const bq = new BigQuery();

async function insertChunked(table: string, rows: Array<{ insertId: string; json: object }>): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await bq.dataset(DATASET).table(table).insert(
      slice.map((r) => ({ insertId: r.insertId, json: r.json })),
      { raw: true, skipInvalidRows: false },
    );
    inserted += slice.length;
  }
  return inserted;
}

async function main(): Promise<void> {
  const syncedAt = new Date().toISOString();
  const expenseRows: Array<{ insertId: string; json: object }> = [];
  const settlementRows: Array<{ insertId: string; json: object }> = [];
  const groupRows: Array<{ insertId: string; json: object }> = [];

  const snapshot = await db.collection('groups').get();
  console.log(`Backfilling ${snapshot.size} groups…`);

  for (const doc of snapshot.docs) {
    const g = doc.data();
    const groupId = doc.id;
    const currency = (g.currency as string) || 'USD';
    const memberIds = Array.isArray(g.memberIds) ? (g.memberIds as string[]) : [];

    for (const e of (Array.isArray(g.expenses) ? g.expenses : [])) {
      if (!e?.expenseId) continue;
      expenseRows.push({
        insertId: `${e.expenseId}:${e.updatedAt ?? e.createdAt ?? ''}`,
        json: mapExpenseRow(groupId, currency, e, syncedAt),
      });
    }
    for (const s of (Array.isArray(g.settlements) ? g.settlements : [])) {
      if (!s?.settlementId) continue;
      settlementRows.push({
        insertId: `${s.settlementId}:${s.createdAt ?? ''}`,
        json: mapSettlementRow(groupId, currency, s, syncedAt),
      });
    }
    groupRows.push({
      insertId: `${groupId}:${g.updatedAt ?? ''}`,
      json: {
        group_id: groupId,
        name: (g.name as string) ?? null,
        currency,
        member_ids: memberIds,
        member_count: memberIds.length,
        created_by: (g.createdBy as string) ?? null,
        created_at: g.createdAt ? new Date(g.createdAt as number).toISOString() : null,
        updated_at: g.updatedAt ? new Date(g.updatedAt as number).toISOString() : null,
        synced_at: syncedAt,
      },
    });
  }

  const e = await insertChunked('expenses', expenseRows);
  const s = await insertChunked('settlements', settlementRows);
  const gr = await insertChunked('groups', groupRows);
  console.log(`✅ Backfill complete: ${e} expenses, ${s} settlements, ${gr} groups.`);
}

main().catch((err) => {
  console.error('Backfill failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
