/**
 * predict_service.ts — Auto-categorize new expenses via BigQuery ML (MODEL-01).
 *
 * Cloud Function triggered on group writes (Phase 1: expenses are embedded in the
 * group doc). For each newly-added expense whose category is blank/'uncategorized',
 * it calls `ML.PREDICT` and writes the predicted category back to Firestore — ONLY
 * when the user left it blank (Critical Rule #5: never overwrite a user's choice).
 *
 * Idempotent: skips expenses that already have a non-empty, non-default category,
 * so repeated trigger fires are no-ops.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as logger from 'firebase-functions/logger';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';
import { BigQuery } from '@google-cloud/bigquery';

if (getApps().length === 0) initializeApp();
const db = getFirestore();
const bq = new BigQuery();

const PROJECT = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT || '';
const DATASET = process.env.BQ_DATASET || 'splitcircle_ml';
const REGION = process.env.GCP_REGION || 'us-central1';
const CONFIDENCE_THRESHOLD = Number(process.env.CATEGORY_CONFIDENCE ?? 0.6);

function isBlank(category: unknown): boolean {
  return !category || (typeof category === 'string' && (category.trim() === '' || category.trim().toLowerCase() === 'uncategorized'));
}

interface PredictResult { category: string; confidence: number }

async function predictCategory(e: { title: string; amount: number; createdAt: number; participantCount: number }): Promise<PredictResult | null> {
  const d = new Date(e.createdAt || Date.now());
  const query = `
    SELECT predicted_label AS category,
           (SELECT MAX(p.prob) FROM UNNEST(predicted_label_probs) AS p) AS confidence
    FROM ML.PREDICT(MODEL \`${PROJECT}.${DATASET}.expense_category_classifier\`,
      (SELECT LOWER(TRIM(@title)) AS title, @amount AS amount,
              @hour AS hour_of_day, @dow AS day_of_week, @pcount AS participant_count))`;
  const [rows] = await bq.query({
    query, location: REGION,
    params: {
      title: e.title ?? '',
      amount: e.amount ?? 0,
      hour: d.getUTCHours(),
      dow: d.getUTCDay() + 1, // BQ DAYOFWEEK is 1..7 (Sun=1)
      pcount: e.participantCount ?? 1,
    },
  });
  const r = rows?.[0] as PredictResult | undefined;
  return r ? { category: r.category, confidence: Number(r.confidence) } : null;
}

export const autoCategorizeExpenses = onDocumentWritten('groups/{groupId}', async (event) => {
  const after = event.data?.after?.data();
  if (!after || !Array.isArray(after.expenses)) return;

  const updated = [...after.expenses];
  let changed = false;

  for (let i = 0; i < updated.length; i++) {
    const e = updated[i];
    if (!e?.expenseId || !isBlank(e.category)) continue; // respect user's choice / idempotent

    try {
      const prediction = await predictCategory({
        title: e.title ?? e.description ?? '',
        amount: Number(e.amount) || 0,
        createdAt: Number(e.createdAt) || Date.now(),
        participantCount: Array.isArray(e.participants) ? e.participants.length : 1,
      });
      if (prediction && prediction.confidence >= CONFIDENCE_THRESHOLD) {
        updated[i] = { ...e, category: prediction.category, categorySource: 'model', updatedAt: Date.now() };
        changed = true;
        logger.info('Auto-categorized expense', { expenseId: e.expenseId, category: prediction.category, confidence: prediction.confidence });
      }
    } catch (err) {
      logger.error('Auto-categorize failed', { expenseId: e.expenseId, error: err instanceof Error ? err.message : 'unknown' });
    }
  }

  if (changed) {
    await db.collection('groups').doc(event.params.groupId).update({ expenses: updated });
  }
});
