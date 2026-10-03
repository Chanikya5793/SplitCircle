import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { onDocumentDeleted } from "firebase-functions/v2/firestore";
import { deleteMonetizationData } from "./accountDeletion";
import { hashOpaque } from "./monetizationCore";

/**
 * Backstop for the currently deployed account-deletion callable. The local
 * cascade performs this cleanup before Auth deletion, while this trigger also
 * covers older deployed deleteAccount revisions and any other trusted server
 * path that removes the user's Firestore profile.
 */
export const cleanupMonetizationOnUserDeleted = onDocumentDeleted(
    {
        document: "users/{userId}",
        retry: true,
        maxInstances: 20,
    },
    async (event) => {
        const uid = event.params.userId;
        await deleteMonetizationData(getFirestore(), uid);
        logger.info("Deleted monetization account data after profile deletion", {
            accountDigest: hashOpaque(["monetization-cleanup-v1", uid]),
        });
    },
);
