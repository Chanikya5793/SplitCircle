/**
 * bigquery.ts — BigQuery/Firestore/Gemini-backed Analytics implementation.
 *
 * Reads the synced `splitcircle_ml` dataset for fast aggregation, falls back to
 * Firestore for the authoritative group expense list (contribution analysis), and
 * uses Gemini 2.5 Flash for the NL insight one-liner. Membership is enforced via
 * Firestore before returning any group data.
 *
 * Queries are parameterized (no string interpolation of user input) and scoped by
 * the authenticated uid (Critical Rule #2).
 */

import { BigQuery } from '@google-cloud/bigquery';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';
import { GoogleAuth } from 'google-auth-library';
import type { Analytics, RagAnswer } from './analytics.js';
import type { ExpenseRow, GroupExpense, ForecastPoint } from './aggregate.js';

if (getApps().length === 0) initializeApp();

const DATASET = process.env.BQ_DATASET || 'splitcircle_ml';
const REGION = process.env.GCP_REGION || 'us-central1';
const PROJECT = process.env.GCP_PROJECT_ID || process.env.GCLOUD_PROJECT || '';
const GEN_MODEL = process.env.GENERATION_MODEL || 'gemini-2.5-flash';

export type RagFn = (uid: string, question: string, groupId?: string) => Promise<RagAnswer>;

export class BigQueryAnalytics implements Analytics {
  private bq = new BigQuery();
  private db = getFirestore();
  private auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

  constructor(private ragFn?: RagFn) {}

  async getUserRows(uid: string, start: number, end: number, groupId?: string): Promise<ExpenseRow[]> {
    // Note: BQ `expenses` is one row per expense with a participant_ids array; we
    // attribute userShare via a JOIN to the participant share. For brevity here we
    // approximate userShare = amount / participant_count when participant detail
    // isn't materialized; a production deployment adds a participant-expanded view.
    const query = `
      SELECT expense_id, group_id, title, category, amount, currency, paid_by,
             UNIX_MILLIS(created_at) AS created_at_ms,
             SAFE_DIVIDE(amount, GREATEST(participant_count, 1)) AS user_share
      FROM \`${PROJECT}.${DATASET}.expenses\`
      WHERE @uid IN UNNEST(participant_ids)
        AND created_at BETWEEN TIMESTAMP_MILLIS(@start) AND TIMESTAMP_MILLIS(@end)
        ${groupId ? 'AND group_id = @groupId' : ''}
      ORDER BY created_at DESC`;
    const [rows] = await this.bq.query({
      query, location: REGION,
      params: { uid, start, end, ...(groupId ? { groupId } : {}) },
    });
    return rows.map((r: any) => ({
      expenseId: r.expense_id, groupId: r.group_id, title: r.title ?? '', category: r.category,
      amount: Number(r.amount), userShare: Number(r.user_share ?? 0), currency: r.currency ?? '',
      paidBy: r.paid_by, createdAtMs: Number(r.created_at_ms),
    }));
  }

  async getGroupExpenses(uid: string, groupId: string): Promise<{ memberIds: string[]; expenses: GroupExpense[]; currency: string }> {
    const doc = await this.db.collection('groups').doc(groupId).get();
    if (!doc.exists) throw new Error('Group not found');
    const data = doc.data()!;
    const memberIds: string[] = Array.isArray(data.memberIds) ? data.memberIds : [];
    if (!memberIds.includes(uid)) throw new Error('Not a member of this group');
    const expenses: GroupExpense[] = (Array.isArray(data.expenses) ? data.expenses : []).map((e: any) => ({
      expenseId: e.expenseId, amount: Number(e.amount) || 0, paidBy: e.paidBy,
      participants: Array.isArray(e.participants) ? e.participants : [],
    }));
    return { memberIds, expenses, currency: data.currency ?? 'USD' };
  }

  async forecastSpending(uid: string): Promise<ForecastPoint[]> {
    // MODEL-02 (ARIMA_PLUS) is keyed by user_id (= payer); scope to this uid.
    const query = `
      SELECT FORMAT_TIMESTAMP('%Y-%m', forecast_timestamp) AS month,
             forecast_value AS predicted,
             prediction_interval_lower_bound AS lower,
             prediction_interval_upper_bound AS upper
      FROM ML.FORECAST(MODEL \`${PROJECT}.${DATASET}.spending_forecaster\`,
        STRUCT(3 AS horizon, 0.8 AS confidence_level))
      WHERE user_id = @uid
      ORDER BY forecast_timestamp`;
    const [rows] = await this.bq.query({ query, location: REGION, params: { uid } });
    const round = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
    return rows.map((r: any) => ({
      month: r.month ?? '',
      predicted: Math.max(0, round(r.predicted)),
      lower: Math.max(0, round(r.lower)),
      upper: Math.max(0, round(r.upper)),
    }));
  }

  async ask(uid: string, question: string, groupId?: string): Promise<RagAnswer> {
    if (this.ragFn) return this.ragFn(uid, question, groupId);
    return { answer: 'RAG service is not configured for this deployment.', sources: [] };
  }

  async generateInsight(prompt: string): Promise<string> {
    const client = await this.auth.getClient();
    const token = (await client.getAccessToken()).token;
    const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models/${GEN_MODEL}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 80 },
      }),
    });
    if (!res.ok) return 'Spending changed compared to the previous period.';
    const data = await res.json() as any;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Spending changed compared to the previous period.';
  }
}
