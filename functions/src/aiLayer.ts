/**
 * aiLayer.ts — Consolidated AI-layer ingestion trigger ("one trigger, not three",
 * Phase 4 §2). On every `groups/{groupId}` write this fans out to the AI layer's
 * three per-group cores — BigQuery sync, expense embedding, and BQML
 * auto-categorization — in sequence, isolating failures so one bad step does not
 * block the others.
 *
 * SAFE BY DEFAULT: gated behind `AI_LAYER_ENABLED`. When unset / !== 'true' this is
 * a pure no-op, so it is safe to deploy before the GCP/Vertex backend exists and it
 * never touches the existing app behavior.
 *
 * ACTIVATION (the documented integration step, Phase 5b self-review):
 *   1. Provision the backend (`ai_layer/setup/gcp_setup.sh`) and set the AI-layer
 *      env (`ai_layer/.env.example`).
 *   2. Build the AI layer and point `AI_LAYER_DIST` at its compiled barrel
 *      (`ai_layer/index.ts`); ensure its runtime deps — `@google-cloud/bigquery`,
 *      `google-auth-library` — are installed in the Functions runtime.
 *   3. Set `AI_LAYER_ENABLED=true`.
 * The cores are imported dynamically only when enabled, so the Functions build and
 * deploy stay lean and dependency-free until activation.
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";

const AI_LAYER_ENABLED = process.env.AI_LAYER_ENABLED === "true";
// Path/specifier for the compiled AI-layer barrel (see ai_layer/index.ts).
// Overridable so the cores can be bundled or published independently of this
// Functions package.
const AI_LAYER_DIST = process.env.AI_LAYER_DIST || "../ai_layer";

type GroupDoc = Record<string, unknown> | undefined;

export interface AiLayerCores {
    runBqSyncForGroup: (groupId: string, after: GroupDoc) => Promise<unknown>;
    runEmbedForGroup: (groupId: string, after: GroupDoc) => Promise<unknown>;
    runAutoCategorizeForGroup: (groupId: string, after: GroupDoc) => Promise<unknown>;
}

let coresPromise: Promise<AiLayerCores | null> | null = null;

/** Lazily load the AI-layer cores; degrade gracefully if they are not bundled. */
async function loadCores(): Promise<AiLayerCores | null> {
    if (!coresPromise) {
        // Non-literal specifier → not resolved at build time; this is what keeps the
        // Functions package independent of the AI layer until it is activated.
        const spec: string = AI_LAYER_DIST;
        coresPromise = import(spec)
            .then((m) => m as AiLayerCores)
            .catch((err: unknown) => {
                logger.warn("AI layer enabled but cores could not be loaded; skipping fan-out", {
                    dist: AI_LAYER_DIST,
                    error: err instanceof Error ? err.message : "unknown",
                });
                return null;
            });
    }
    return coresPromise;
}

/** Run one fan-out step in isolation — a failure is logged, never rethrown. */
export async function runStep(name: string, groupId: string, fn: () => Promise<unknown>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        // Counts/names only — never log expense text (PII, Critical Rule #3).
        logger.error("AI layer step failed", {
            step: name,
            groupId,
            error: err instanceof Error ? err.message : "unknown",
        });
    }
}

/**
 * Sequential, isolated fan-out to the three cores. Sync first (it also handles
 * the delete/erasure path), then embed, then categorize. Each step is isolated so
 * one failure never blocks the others. Exported for unit testing.
 */
export async function fanOut(cores: AiLayerCores, groupId: string, after: GroupDoc): Promise<void> {
    await runStep("bq_sync", groupId, () => cores.runBqSyncForGroup(groupId, after));
    await runStep("embed", groupId, () => cores.runEmbedForGroup(groupId, after));
    await runStep("auto_categorize", groupId, () => cores.runAutoCategorizeForGroup(groupId, after));
}

/**
 * Consolidated AI-layer fan-out for a single group write. Each core is idempotent
 * (embed: contentHash; categorize: blank-only; sync: deterministic insertIds), so
 * the auto-categorize write-back that re-fires this trigger settles after one extra
 * no-op pass — bounded, not infinite.
 */
export const onGroupWritten = onDocumentWritten("groups/{groupId}", async (event) => {
    if (!AI_LAYER_ENABLED) {
        return;
    }

    const cores = await loadCores();
    if (!cores) {
        return;
    }

    const after = event.data?.after?.data() as GroupDoc;
    await fanOut(cores, event.params.groupId, after);
});
