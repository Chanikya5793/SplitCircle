/**
 * Read-only usage summary for the in-app "Usage & limits" page.
 *
 * Everything here is derived from server-owned records the enforcement path
 * already writes: plan-window counters (usageWindows), free-preview claims
 * (previews), per-day completion totals (usageDays) and the credit ledger.
 * Nothing in this module can grant or spend access.
 */

import { getFirestore, type DocumentData, type Firestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
    METERED_FEATURES,
    MONETIZATION_SCHEMA_VERSION,
    PUBLISHED_FEATURE_IDS,
    type MeteredFeatureId,
    type MonetizationEnvironment,
    type PlanId,
    type QuotaRule,
} from "./monetizationCatalog";
import { getRuleWindow, hashOpaque, type InternalTestAccess } from "./monetizationCore";
import { usageCountKey, usageDayKey } from "./monetizationEnforcement";
import { resolveRequestMonetizationContext } from "./monetizationRequest";
import { ensureMonetizationAccount, safeNonNegativeInteger, usageAccountRef } from "./monetizationStore";

export const USAGE_HISTORY_DAYS = 30;
const LEDGER_PAGE_SIZE = 25;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface FeatureUsage {
    featureId: MeteredFeatureId;
    label: string;
    unit: { one: string; other: string };
    rule: QuotaRule;
    /** Completed uses in the current plan window (null when unlimited). */
    used: number;
    /** Uses reserved by operations still in flight. */
    reserved: number;
    limit: number | null;
    remaining: number | null;
    windowStartMs: number | null;
    resetsAt: number | null;
    creditCost: number | null;
    /** Free-plan per-variant previews, when the feature offers them. */
    previews: { variant: string; claimed: boolean }[] | null;
}

export interface UsageDay {
    day: string;
    counts: Partial<Record<MeteredFeatureId, number>>;
    creditsSpent: number;
}

export interface CreditLedgerItem {
    id: string;
    type: string;
    status: string;
    creditDelta: number;
    balanceAfter: number | null;
    featureId: MeteredFeatureId | null;
    productId: string | null;
    createdAt: number | null;
}

export interface MonetizationUsageSummary {
    schemaVersion: 1;
    serverTime: number;
    environment: MonetizationEnvironment;
    planId: PlanId;
    validUntil: number | null;
    creditBalance: number;
    creditDebt: number;
    access: Pick<InternalTestAccess, "kind" | "commercialQuotaBypass" | "grantExpiresAt">;
    features: FeatureUsage[];
    daily: UsageDay[];
    ledger: CreditLedgerItem[];
}

function windowDocumentId(featureId: MeteredFeatureId, windowKey: string): string {
    return hashOpaque(["usage-window-v2", featureId, windowKey]);
}

function previewDocumentId(featureId: MeteredFeatureId, variant: string): string {
    return hashOpaque(["usage-preview-v2", `${featureId}:${variant}`]);
}

function toMillis(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value && typeof value === "object" && "toMillis" in value) {
        const fn = (value as { toMillis?: unknown }).toMillis;
        if (typeof fn === "function") {
            const result = fn.call(value);
            return typeof result === "number" && Number.isFinite(result) ? result : null;
        }
    }
    return null;
}

/** The last `days` UTC day keys, oldest first, ending today. */
export function usageHistoryDays(nowMs: number, days = USAGE_HISTORY_DAYS): string[] {
    const today = Date.UTC(
        new Date(nowMs).getUTCFullYear(),
        new Date(nowMs).getUTCMonth(),
        new Date(nowMs).getUTCDate(),
    );
    return Array.from({ length: days }, (_, index) => usageDayKey(today - (days - 1 - index) * DAY_MS));
}

/** Pure projection of one feature's meter from its stored window document. */
export function buildFeatureUsage(params: {
    featureId: MeteredFeatureId;
    planId: PlanId;
    nowMs: number;
    windowData: DocumentData | undefined;
    claimedVariants: ReadonlySet<string>;
}): FeatureUsage {
    const feature = METERED_FEATURES[params.featureId];
    const rule = feature.quotaByPlan[params.planId];
    const window = getRuleWindow(rule, params.nowMs);
    const used = safeNonNegativeInteger(params.windowData?.completedCount);
    const reserved = safeNonNegativeInteger(params.windowData?.reservedCount);
    const limit = rule.kind === "metered" ? rule.limit : null;
    return {
        featureId: params.featureId,
        label: feature.label,
        unit: feature.unit,
        rule,
        used,
        reserved,
        limit,
        remaining: limit === null ? null : Math.max(0, limit - used - reserved),
        windowStartMs: window?.startMs ?? null,
        resetsAt: window?.endMs ?? null,
        creditCost: feature.creditCost,
        previews: feature.freePreview && feature.variants && params.planId === "free"
            ? feature.variants.map((variant) => ({ variant, claimed: params.claimedVariants.has(variant) }))
            : null,
    };
}

export function parseUsageDay(day: string, data: DocumentData | undefined): UsageDay {
    const counts: Partial<Record<MeteredFeatureId, number>> = {};
    const stored = data?.counts && typeof data.counts === "object" ? data.counts as Record<string, unknown> : {};
    for (const featureId of PUBLISHED_FEATURE_IDS) {
        const value = safeNonNegativeInteger(stored[usageCountKey(featureId)]);
        if (value > 0) counts[featureId] = value;
    }
    return { day, counts, creditsSpent: safeNonNegativeInteger(data?.creditsSpent) };
}

export function parseLedgerItem(id: string, data: DocumentData): CreditLedgerItem {
    const featureId = typeof data.featureId === "string" && data.featureId in METERED_FEATURES
        ? data.featureId as MeteredFeatureId
        : null;
    // A released reservation nets to zero; report what actually moved.
    const creditDelta = typeof data.creditDelta === "number" && Number.isFinite(data.creditDelta)
        ? Math.trunc(data.creditDelta)
        : 0;
    return {
        id,
        type: typeof data.type === "string" ? data.type : "unknown",
        status: typeof data.status === "string" ? data.status : "unknown",
        creditDelta,
        balanceAfter: typeof data.balanceAfter === "number" ? data.balanceAfter : null,
        featureId,
        productId: typeof data.productId === "string" ? data.productId : null,
        createdAt: toMillis(data.createdAt),
    };
}

export async function readMonetizationUsage(params: {
    uid: string;
    environment: MonetizationEnvironment;
    access: InternalTestAccess;
    nowMs: number;
    db?: Firestore;
}): Promise<MonetizationUsageSummary> {
    const db = params.db ?? getFirestore();
    const account = await ensureMonetizationAccount({
        uid: params.uid,
        environment: params.environment,
        db,
        nowMs: params.nowMs,
    });
    const usageRef = usageAccountRef(params.environment, params.uid, db);

    const windowRefs = PUBLISHED_FEATURE_IDS.map((featureId) => {
        const window = getRuleWindow(METERED_FEATURES[featureId].quotaByPlan[account.planId], params.nowMs);
        return window ? usageRef.collection("usageWindows").doc(windowDocumentId(featureId, window.key)) : null;
    });
    const previewRefs = PUBLISHED_FEATURE_IDS.flatMap((featureId) => {
        const feature = METERED_FEATURES[featureId];
        return feature.freePreview && feature.variants
            ? feature.variants.map((variant) => ({
                featureId,
                variant,
                ref: usageRef.collection("previews").doc(previewDocumentId(featureId, variant)),
            }))
            : [];
    });
    const days = usageHistoryDays(params.nowMs);
    const dayRefs = days.map((day) => usageRef.collection("usageDays").doc(day));

    const refs = [
        ...windowRefs.filter((ref): ref is NonNullable<typeof ref> => ref !== null),
        ...previewRefs.map((entry) => entry.ref),
        ...dayRefs,
    ];
    const [snapshots, ledgerSnapshot] = await Promise.all([
        refs.length > 0 ? db.getAll(...refs) : Promise.resolve([]),
        usageRef.collection("creditLedger").orderBy("createdAt", "desc").limit(LEDGER_PAGE_SIZE).get(),
    ]);
    const byPath = new Map(snapshots.map((snapshot) => [snapshot.ref.path, snapshot]));

    // Only a consumed preview is spent; a reserved one is released on failure.
    const claimed = new Map<MeteredFeatureId, Set<string>>();
    for (const entry of previewRefs) {
        const data = byPath.get(entry.ref.path)?.data();
        if (data?.status === "consumed") {
            const set = claimed.get(entry.featureId) ?? new Set<string>();
            set.add(entry.variant);
            claimed.set(entry.featureId, set);
        }
    }

    const features = PUBLISHED_FEATURE_IDS.map((featureId, index) => buildFeatureUsage({
        featureId,
        planId: account.planId,
        nowMs: params.nowMs,
        windowData: windowRefs[index] ? byPath.get(windowRefs[index]!.path)?.data() : undefined,
        claimedVariants: claimed.get(featureId) ?? new Set(),
    }));

    return {
        schemaVersion: MONETIZATION_SCHEMA_VERSION,
        serverTime: params.nowMs,
        environment: params.environment,
        planId: account.planId,
        validUntil: account.validUntilMs,
        creditBalance: account.creditBalance,
        creditDebt: account.creditDebt,
        access: {
            kind: params.access.kind,
            commercialQuotaBypass: params.access.commercialQuotaBypass,
            grantExpiresAt: params.access.grantExpiresAt,
        },
        features,
        daily: days.map((day, index) => parseUsageDay(day, byPath.get(dayRefs[index].path)?.data())),
        ledger: ledgerSnapshot.docs.map((doc) => parseLedgerItem(doc.id, doc.data())),
    };
}

export const getMonetizationUsage = onCall({ cors: true, maxInstances: 20 }, async (request) => {
    const nowMs = Date.now();
    const context = await resolveRequestMonetizationContext(request, nowMs);
    try {
        return await readMonetizationUsage({
            uid: context.uid,
            environment: context.environment,
            access: context.access,
            nowMs,
        });
    } catch (error) {
        logger.error("getMonetizationUsage failed", {
            accountDigest: hashOpaque(["monetization-log-v1", context.uid]),
            errorName: error instanceof Error ? error.name : "UnknownError",
        });
        throw new HttpsError("internal", "Usage information is temporarily unavailable.");
    }
});
