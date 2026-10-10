/**
 * Commercial quota for callables that do paid provider work themselves.
 *
 * The reservation is taken before the provider is contacted and settled after
 * it answers: a provider error, a partial answer or a thrown exception costs
 * nothing (blueprint: "do not debit credits for a provider error"). Safety
 * cool-downs inside the callable still apply on top of this, for everyone.
 */

import { randomUUID } from "node:crypto";
import type { CallableRequest } from "firebase-functions/v2/https";
import type { MeteredFeatureId } from "./monetizationCatalog";
import {
    authorizeServerMeteredOperation,
    finalizeServerMeteredOperation,
    quotaExhaustedError,
    type MonetizedOperationAuthorization,
} from "./monetizationEnforcement";
import { resolveRequestMonetizationContext } from "./monetizationRequest";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Public slice of the decision, returned alongside the provider result. */
export interface MeteredUsageNotice {
    source: MonetizedOperationAuthorization["source"];
    remaining: number | null;
    resetsAt: number | null;
    creditBalance: number;
}

/**
 * Stable per-attempt key. Clients that send a UUID get retry-safe charging;
 * older clients that send nothing are charged per call, as before.
 */
export function providerOperationKey(prefix: string, requested: unknown): string {
    const id = typeof requested === "string" && UUID_V4.test(requested.trim())
        ? requested.trim().toLowerCase()
        : randomUUID();
    return `${prefix}:${id}`;
}

export async function runMeteredProviderOperation<T>(params: {
    request: CallableRequest;
    featureId: MeteredFeatureId;
    operationKey: string;
    /** Only true when the user approved spending credits for THIS attempt. */
    useCredits: boolean;
    run: () => Promise<T>;
    /** Whether the provider actually delivered a billable result. */
    succeeded?: (result: T) => boolean;
}): Promise<{ result: T; usage: MeteredUsageNotice }> {
    const context = await resolveRequestMonetizationContext(params.request);
    const authorization = await authorizeServerMeteredOperation({
        uid: context.uid,
        environment: context.environment,
        access: context.access,
        featureId: params.featureId,
        operationKey: params.operationKey,
        useCredits: params.useCredits,
    });
    if (!authorization.allowed) throw quotaExhaustedError(authorization);

    const settle = (outcome: "completed" | "failed") => finalizeServerMeteredOperation({
        uid: context.uid,
        environment: context.environment,
        authorization,
        operationKey: params.operationKey,
        outcome,
    });

    let result: T;
    try {
        result = await params.run();
    } catch (error) {
        await settle("failed").catch(() => undefined);
        throw error;
    }
    const billable = params.succeeded ? params.succeeded(result) : true;
    await settle(billable ? "completed" : "failed");
    // A released reservation hands back exactly what it held.
    const returnedUse = !billable && authorization.source === "included_use" ? 1 : 0;
    const returnedCredits = !billable && authorization.source === "credits"
        ? authorization.creditCost ?? 0
        : 0;
    return {
        result,
        usage: {
            source: authorization.source,
            remaining: authorization.remaining === null ? null : authorization.remaining + returnedUse,
            resetsAt: authorization.resetsAt,
            creditBalance: authorization.creditBalance + returnedCredits,
        },
    };
}
