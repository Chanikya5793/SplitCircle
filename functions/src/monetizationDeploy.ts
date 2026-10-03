/**
 * Minimal deployment entry point for the monetization foundation.
 *
 * The primary index currently contains unreleased modules whose production
 * secrets are intentionally absent. This entry keeps a scoped monetization
 * deployment independent from those unrelated release gates.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {
    confirmRecurringBillOccurrence as confirmRecurringBillOccurrenceImpl,
    processAllDueRecurringBills,
    processGroupDueRecurringBills,
} from "./recurringBills";

initializeApp();

export { cleanupMonetizationOnUserDeleted } from "./monetizationAccountCleanup";
export { getMonetizationSnapshot, recordMonetizationUsage } from "./monetization";
export {
    authorizeMonetizedOperation,
    finalizeMonetizedOperation,
    reapExpiredMonetizationReservations,
} from "./monetizationEnforcement";
export {
    appStoreServerNotificationsV2,
    verifyAppleTransaction,
} from "./appleCommerce";
export {
    getMonetizationSupportAccount,
    grantMonetizationCourtesyCredits,
    releaseMonetizationReservationForSupport,
    setMonetizationTestAccess,
} from "./monetizationSupport";
export { convertGroupCurrency, mutateExpense } from "./expenseMutation";
export { mutateRecurringBill, mutateSettlement } from "./financialMutations";

const stringValue = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";

const safeError = (error: unknown): Record<string, string> => error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorName: "UnknownError", errorMessage: String(error) };

/**
 * These three mirrors keep the commerce/financial deployment independent of
 * unrelated functions whose production secrets are intentionally absent.
 * Their implementation stays in recurringBills.ts, shared with index.ts.
 */
export const runRecurringBillsScheduler = onSchedule("every 6 hours", async () => {
    try {
        const result = await processAllDueRecurringBills();
        logger.info("Recurring bills scheduler completed", result);
    } catch (error) {
        logger.error("Recurring bills scheduler failed", safeError(error));
        throw error;
    }
});

export const triggerRecurringBillsForGroup = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
    const groupId = stringValue(request.data?.groupId);
    if (!groupId) throw new HttpsError("invalid-argument", "Missing required field: groupId");

    const groupSnapshot = await getFirestore().collection("groups").doc(groupId).get();
    if (!groupSnapshot.exists) throw new HttpsError("not-found", "Group not found.");
    const memberIds = Array.isArray(groupSnapshot.data()?.memberIds)
        ? groupSnapshot.data()!.memberIds as string[]
        : [];
    if (!memberIds.includes(uid)) {
        throw new HttpsError("permission-denied", "User is not a member of this group.");
    }

    try {
        const result = await processGroupDueRecurringBills(groupId);
        logger.info("Recurring bills sync completed for group", { groupId, uid, ...result });
        return {
            generatedCount: result.generatedExpenses,
            processedBills: result.processedBills,
            scannedBills: result.scannedBills,
        };
    } catch (error) {
        logger.error("Recurring bills sync failed for group", { groupId, uid, ...safeError(error) });
        throw new HttpsError("internal", "Failed to sync recurring bills.");
    }
});

export const confirmRecurringBillOccurrence = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
    const groupId = stringValue(request.data?.groupId);
    const billId = stringValue(request.data?.billId);
    const occurrenceAt = request.data?.occurrenceAt;
    const amount = request.data?.amount;
    const expectedCurrency = stringValue(request.data?.expectedCurrency).toUpperCase();
    if (!groupId || !billId || typeof occurrenceAt !== "number" || typeof amount !== "number" ||
        !/^[A-Z]{3}$/.test(expectedCurrency)) {
        throw new HttpsError("invalid-argument", "Missing recurring occurrence fields.");
    }
    try {
        return await confirmRecurringBillOccurrenceImpl({
            uid,
            groupId,
            billId,
            occurrenceAt,
            amount,
            expectedCurrency,
        });
    } catch (error) {
        if (error instanceof HttpsError) throw error;
        logger.error("confirmRecurringBillOccurrence failed", {
            uid,
            groupId,
            billId,
            ...safeError(error),
        });
        throw new HttpsError("internal", "Could not confirm this recurring occurrence.");
    }
});
