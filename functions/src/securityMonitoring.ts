import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { FieldValue, Timestamp, getFirestore, type Query } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { sendPushToUsers } from "./notifications";
import {
    GoogleKmsKeyProvider,
    blindIndex,
    decryptIdentityValue,
    encryptIdentityValue,
    generateWrappedDek,
    identityAad,
    type EncryptedIdentityValue,
} from "./security/crypto";
import { FlareProvider, HibpProvider, securityFindingDedupeKey } from "./security/providers";
import { assessSecurityRisk } from "./security/riskEngine";
import type {
    ProviderScanResult,
    SecurityFindingState,
    SecurityIdentityType,
} from "./security/types";

const SECURITY_COLLECTION = "securityMonitors";
const CONSENT_VERSION = "2026-08-13.v1";
const MAX_IDENTITIES = 12;
const MANUAL_SCAN_COOLDOWN_MS = 60_000;
const DEFAULT_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const KEY_ROTATION_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;
const KEY_ROTATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_FINDINGS_PER_PROVIDER = 100;

const kmsKeyName = defineSecret("SECURITY_MONITORING_KMS_KEY");
const blindIndexKey = defineSecret("SECURITY_BLIND_INDEX_KEY");
const hibpApiKey = defineSecret("HIBP_API_KEY");
const flareApiKey = defineSecret("FLARE_API_KEY");

const monitoringSecrets = [kmsKeyName, blindIndexKey, hibpApiKey, flareApiKey];

const secretValue = (secret: { value: () => string }, envName: string): string => {
    try {
        return secret.value().trim();
    } catch {
        return process.env[envName]?.trim() ?? "";
    }
};

const authenticatedUid = (request: { auth?: { uid?: string; token?: Record<string, unknown> } }): string => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
    return uid;
};

const asString = (value: unknown, max = 320): string =>
    typeof value === "string" ? value.trim().slice(0, max) : "";

const normalizeIdentity = (type: SecurityIdentityType, raw: string): string => {
    const value = raw.trim().normalize("NFKC");
    if (type === "email") {
        const normalized = value.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) {
            throw new HttpsError("invalid-argument", "Enter a valid email address.");
        }
        return normalized;
    }
    if (type === "domain") {
        const normalized = value.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
        if (normalized.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)) {
            throw new HttpsError("invalid-argument", "Enter a valid domain name without a path.");
        }
        return normalized;
    }
    if (type === "phone") {
        const normalized = value.replace(/[\s().-]/g, "");
        if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
            throw new HttpsError("invalid-argument", "Enter a phone number in international format.");
        }
        return normalized;
    }
    const normalized = value.toLowerCase();
    if (!/^[\p{L}\p{N}._-]{2,64}$/u.test(normalized)) {
        throw new HttpsError("invalid-argument", "Enter a valid username.");
    }
    return normalized;
};

const maskedDisplay = (type: SecurityIdentityType, value: string): string => {
    if (type === "email") {
        const [local, domain] = value.split("@");
        return `${local.slice(0, 1)}${"•".repeat(Math.min(5, Math.max(2, local.length - 1)))}@${domain}`;
    }
    if (type === "phone") return `${value.slice(0, 3)} ••• ••• ${value.slice(-2)}`;
    if (type === "domain") return value;
    return `${value.slice(0, 2)}${"•".repeat(Math.min(6, Math.max(2, value.length - 2)))}`;
};

const toMillis = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value instanceof Timestamp) return value.toMillis();
    const candidate = value as { toMillis?: () => number } | null;
    return typeof candidate?.toMillis === "function" ? candidate.toMillis() : null;
};

const sanitizeProviderStatus = (results: ProviderScanResult[]) =>
    Object.fromEntries(results.map((result) => [result.provider, {
        status: result.status,
        latencyMs: result.latencyMs,
        findingCount: result.findings.length,
        checkedAt: Date.now(),
        ...(result.safeMessage ? { message: result.safeMessage } : {}),
    }]));

const monitorRef = (uid: string) => getFirestore().collection(SECURITY_COLLECTION).doc(uid);

async function writeTimeline(
    uid: string,
    type: string,
    fields: Record<string, unknown> = {},
): Promise<void> {
    await monitorRef(uid).collection("timeline").add({
        type,
        ...fields,
        createdAt: FieldValue.serverTimestamp(),
    });
}

async function claimManualScan(uid: string, requestId: string): Promise<"claimed" | "complete" | "running"> {
    const db = getFirestore();
    const rootRef = monitorRef(uid);
    const jobRef = rootRef.collection("scanJobs").doc(requestId);
    return db.runTransaction(async (transaction) => {
        const [root, job] = await Promise.all([transaction.get(rootRef), transaction.get(jobRef)]);
        if (job.exists) {
            const status = job.data()?.status;
            return status === "complete" ? "complete" : "running";
        }
        const nextAllowedAt = toMillis(root.data()?.nextManualScanAt) ?? 0;
        if (nextAllowedAt > Date.now()) {
            throw new HttpsError("resource-exhausted", "Please wait before starting another scan.", {
                retryAfterMs: nextAllowedAt - Date.now(),
            });
        }
        transaction.set(jobRef, {
            requestId,
            status: "running",
            source: "manual",
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.set(rootRef, {
            nextManualScanAt: Timestamp.fromMillis(Date.now() + MANUAL_SCAN_COOLDOWN_MS),
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return "claimed";
    });
}

async function runSecurityScan(uid: string, requestId: string, source: "manual" | "scheduled"): Promise<{
    findingCount: number;
    newHighRiskCount: number;
    providerStatus: Record<string, unknown>;
}> {
    const rootRef = monitorRef(uid);
    const root = await rootRef.get();
    if (!root.exists || root.data()?.enabled !== true || !root.data()?.consentedAt) {
        throw new HttpsError("failed-precondition", "Security monitoring is not enabled.");
    }

    const userWrappedDek = asString(root.data()?.wrappedDek, 8192);
    if (!userWrappedDek) throw new HttpsError("failed-precondition", "Security encryption key is unavailable.");
    const identitySnapshot = await rootRef.collection("identities").where("verificationState", "==", "verified").get();
    const keyProvider = new GoogleKmsKeyProvider(secretValue(kmsKeyName, "SECURITY_MONITORING_KMS_KEY"));
    const providers = [
        new HibpProvider(secretValue(hibpApiKey, "HIBP_API_KEY")),
        new FlareProvider(secretValue(flareApiKey, "FLARE_API_KEY")),
    ];
    const allResults: ProviderScanResult[] = [];
    let findingCount = 0;
    let newHighRiskCount = 0;

    for (const identityDoc of identitySnapshot.docs) {
        const identity = identityDoc.data();
        const type = identity.type as SecurityIdentityType;
        let plaintext = await decryptIdentityValue(
            identity.encryptedValue as EncryptedIdentityValue,
            identityAad(uid, identityDoc.id, type),
            keyProvider,
            userWrappedDek,
        );
        try {
            const results = await Promise.all(providers.map((provider) => provider.scan({
                type,
                value: plaintext,
                providerReference: asString(identity.providerReferences?.[provider.id], 128) || undefined,
            })));
            allResults.push(...results);

            for (const result of results) {
                const providerReference = (result as ProviderScanResult & { providerReference?: string }).providerReference;
                if (providerReference) {
                    await identityDoc.ref.set({
                        providerReferences: { ...(identity.providerReferences ?? {}), [result.provider]: providerReference },
                        updatedAt: FieldValue.serverTimestamp(),
                    }, { merge: true });
                }
                for (const finding of result.findings.slice(0, MAX_FINDINGS_PER_PROVIDER)) {
                    const findingId = securityFindingDedupeKey(identityDoc.id, finding);
                    const findingRef = rootRef.collection("findings").doc(findingId);
                    const existing = await findingRef.get();
                    const occurrenceCount = Math.max(0, Number(existing.data()?.occurrenceCount) || 0) + 1;
                    const assessment = assessSecurityRisk(finding, { repeatedExposureCount: occurrenceCount - 1 });
                    const isNew = !existing.exists;
                    await findingRef.set({
                        findingId,
                        identityId: identityDoc.id,
                        identityHint: identity.displayHint,
                        source: finding.source,
                        sourceReference: finding.sourceReference,
                        kind: finding.kind,
                        title: finding.title,
                        summary: finding.summary,
                        observedAt: finding.observedAt,
                        occurredAt: finding.occurredAt ?? null,
                        exposedDataClasses: finding.exposedDataClasses,
                        evidence: finding.evidence,
                        indicators: finding.indicators ?? {},
                        assessment,
                        state: existing.data()?.state ?? "active",
                        firstSeenAt: existing.data()?.firstSeenAt ?? FieldValue.serverTimestamp(),
                        lastSeenAt: FieldValue.serverTimestamp(),
                        occurrenceCount,
                        updatedAt: FieldValue.serverTimestamp(),
                    }, { merge: true });
                    findingCount += 1;
                    if (isNew && (assessment.severity === "critical" || assessment.severity === "high")) {
                        newHighRiskCount += 1;
                    }
                }
            }
        } finally {
            plaintext = "";
        }
    }

    const providerStatus = sanitizeProviderStatus(allResults);
    const completedAt = Date.now();
    await rootRef.set({
        providerStatus,
        lastScanAt: Timestamp.fromMillis(completedAt),
        nextScanAt: Timestamp.fromMillis(completedAt + DEFAULT_SCAN_INTERVAL_MS),
        updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await rootRef.collection("scanJobs").doc(requestId).set({
        status: "complete",
        source,
        findingCount,
        newHighRiskCount,
        providerStatus,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await writeTimeline(uid, "scan_completed", { requestId, source, findingCount, newHighRiskCount });

    if (newHighRiskCount > 0) {
        const detailed = root.data()?.detailedNotifications === true;
        await sendPushToUsers(
            [uid],
            detailed ? "Security alert" : "ManaSplit",
            detailed ? "A high-risk security finding needs your review." : "Open ManaSplit to review a protected security alert.",
            { type: "security", route: "SecurityCenter", requestId },
            "general",
            undefined,
            "general",
        );
    }

    return { findingCount, newHighRiskCount, providerStatus };
}

export const getSecurityCenter = onCall({ secrets: monitoringSecrets }, async (request) => {
    const uid = authenticatedUid(request);
    const rootRef = monitorRef(uid);
    const [root, identities, findings, timeline] = await Promise.all([
        rootRef.get(),
        rootRef.collection("identities").orderBy("createdAt", "asc").get(),
        rootRef.collection("findings").orderBy("lastSeenAt", "desc").limit(100).get(),
        rootRef.collection("timeline").orderBy("createdAt", "desc").limit(50).get(),
    ]);
    const rootData = root.data() ?? {};
    const safeFindings = findings.docs.map((doc) => {
        const data = doc.data();
        return {
            findingId: doc.id,
            identityId: data.identityId,
            identityHint: data.identityHint,
            source: data.source,
            kind: data.kind,
            title: data.title,
            summary: data.summary,
            observedAt: toMillis(data.observedAt) ?? toMillis(data.lastSeenAt) ?? Date.now(),
            occurredAt: toMillis(data.occurredAt),
            exposedDataClasses: data.exposedDataClasses ?? [],
            evidence: data.evidence ?? [],
            assessment: data.assessment,
            state: data.state,
            occurrenceCount: data.occurrenceCount ?? 1,
        };
    });
    const activeAssessments = safeFindings.filter((finding) => finding.state === "active" || finding.state === "acknowledged");
    const maxScore = activeAssessments.reduce((max, finding) => Math.max(max, Number(finding.assessment?.score) || 0), 0);

    return {
        enabled: rootData.enabled === true,
        consentVersion: rootData.consentVersion ?? null,
        detailedNotifications: rootData.detailedNotifications === true,
        lastScanAt: toMillis(rootData.lastScanAt),
        nextScanAt: toMillis(rootData.nextScanAt),
        providerStatus: rootData.providerStatus ?? {},
        securityScore: Math.max(0, 100 - maxScore),
        identities: identities.docs.map((doc) => ({
            identityId: doc.id,
            type: doc.data().type,
            displayHint: doc.data().displayHint,
            verificationState: doc.data().verificationState,
            verificationMethod: doc.data().verificationMethod,
            verificationChallenge: doc.data().verificationState === "pending" && doc.data().type === "domain"
                ? doc.data().verificationChallenge
                : undefined,
            createdAt: toMillis(doc.data().createdAt),
        })),
        findings: safeFindings,
        timeline: timeline.docs.map((doc) => ({ eventId: doc.id, ...doc.data(), createdAt: toMillis(doc.data().createdAt) })),
    };
});

export const enrollSecurityIdentity = onCall({ secrets: monitoringSecrets }, async (request) => {
    const uid = authenticatedUid(request);
    if (request.data?.consentAccepted !== true) {
        throw new HttpsError("failed-precondition", "Consent is required before monitoring an identity.");
    }
    const type = asString(request.data?.type, 20) as SecurityIdentityType;
    if (!["email", "username", "phone", "domain"].includes(type)) {
        throw new HttpsError("invalid-argument", "Unsupported identity type.");
    }
    const normalized = normalizeIdentity(type, asString(request.data?.value));
    const rootRef = monitorRef(uid);
    const [root, existing] = await Promise.all([
        rootRef.get(),
        rootRef.collection("identities").limit(MAX_IDENTITIES + 1).get(),
    ]);
    if (existing.size >= MAX_IDENTITIES) {
        throw new HttpsError("resource-exhausted", `You can monitor up to ${MAX_IDENTITIES} identities.`);
    }

    const index = blindIndex(uid, type, normalized, secretValue(blindIndexKey, "SECURITY_BLIND_INDEX_KEY"));
    if (existing.docs.some((doc) => doc.data().blindIndex === index)) {
        throw new HttpsError("already-exists", "That identity is already monitored.");
    }
    const identityId = randomUUID();
    const keyProvider = new GoogleKmsKeyProvider(secretValue(kmsKeyName, "SECURITY_MONITORING_KMS_KEY"));
    const userWrappedDek = asString(root.data()?.wrappedDek, 8192) || await generateWrappedDek(keyProvider);
    const encryptedValue = await encryptIdentityValue(
        normalized,
        identityAad(uid, identityId, type),
        keyProvider,
        userWrappedDek,
    );
    const token: Record<string, unknown> = request.auth?.token ?? {};
    const authEmail = asString(token.email).toLowerCase();
    const authPhone = asString(token.phone_number);
    const automaticallyVerified =
        (type === "email" && token.email_verified === true && normalized === authEmail) ||
        (type === "phone" && normalized === authPhone);
    const domainChallenge = type === "domain" ? `manasplit-verification=${randomBytes(24).toString("base64url")}` : null;
    const verificationState = automaticallyVerified ? "verified" : "pending";
    const verificationMethod = automaticallyVerified ? "firebase_auth" : type === "domain" ? "dns_txt" : "manual_proof_required";

    await rootRef.set({
        enabled: true,
        wrappedDek: userWrappedDek,
        keyVersion: Number(root.data()?.keyVersion) || 1,
        consentVersion: CONSENT_VERSION,
        consentedAt: FieldValue.serverTimestamp(),
        detailedNotifications: false,
        nextScanAt: Timestamp.fromMillis(Date.now()),
        nextKeyRotationAt: root.data()?.nextKeyRotationAt ?? Timestamp.fromMillis(Date.now() + KEY_ROTATION_INTERVAL_MS),
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: root.exists ? root.data()?.createdAt ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
    }, { merge: true });
    await rootRef.collection("identities").doc(identityId).create({
        identityId,
        type,
        encryptedValue,
        blindIndex: index,
        displayHint: maskedDisplay(type, normalized),
        verificationState,
        verificationMethod,
        ...(domainChallenge ? { verificationChallenge: domainChallenge } : {}),
        providerReferences: {},
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
    });
    await writeTimeline(uid, "identity_enrolled", { identityId, identityType: type, verificationState });
    return {
        identityId,
        displayHint: maskedDisplay(type, normalized),
        verificationState,
        verificationMethod,
        ...(domainChallenge ? { dnsRecordName: `_manasplit-monitor.${normalized}`, dnsRecordValue: domainChallenge } : {}),
    };
});

export const verifySecurityIdentity = onCall({ secrets: monitoringSecrets }, async (request) => {
    const uid = authenticatedUid(request);
    const identityId = asString(request.data?.identityId, 64);
    const ref = monitorRef(uid).collection("identities").doc(identityId);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new HttpsError("not-found", "Monitored identity not found.");
    const data = snapshot.data()!;
    if (data.verificationState === "verified") return { verified: true };
    if (data.type !== "domain" || data.verificationMethod !== "dns_txt") {
        throw new HttpsError("failed-precondition", "This identity needs an approved account-ownership proof before monitoring can start.");
    }
    const keyProvider = new GoogleKmsKeyProvider(secretValue(kmsKeyName, "SECURITY_MONITORING_KMS_KEY"));
    const root = await monitorRef(uid).get();
    const userWrappedDek = asString(root.data()?.wrappedDek, 8192);
    let domain = await decryptIdentityValue(
        data.encryptedValue as EncryptedIdentityValue,
        identityAad(uid, identityId, data.type),
        keyProvider,
        userWrappedDek || undefined,
    );
    try {
        const records = await resolveTxt(`_manasplit-monitor.${domain}`);
        const values = records.map((parts) => parts.join(""));
        if (!values.includes(data.verificationChallenge)) {
            throw new HttpsError("failed-precondition", "The DNS verification record was not found yet.");
        }
        await ref.update({
            verificationState: "verified",
            verifiedAt: FieldValue.serverTimestamp(),
            verificationChallenge: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
        });
        await writeTimeline(uid, "identity_verified", { identityId, identityType: "domain" });
        return { verified: true };
    } finally {
        domain = "";
    }
});

export const startSecurityScan = onCall({ secrets: monitoringSecrets, timeoutSeconds: 300 }, async (request) => {
    const uid = authenticatedUid(request);
    const requestId = asString(request.data?.requestId, 80);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
        throw new HttpsError("invalid-argument", "A valid idempotency request ID is required.");
    }
    const claim = await claimManualScan(uid, requestId);
    if (claim !== "claimed") {
        const job = await monitorRef(uid).collection("scanJobs").doc(requestId).get();
        return { status: claim, ...(job.data() ?? {}) };
    }
    try {
        return { status: "complete", ...(await runSecurityScan(uid, requestId, "manual")) };
    } catch (error) {
        await monitorRef(uid).collection("scanJobs").doc(requestId).set({
            status: "failed",
            safeMessage: "The scan did not complete. No sensitive provider response was retained.",
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        throw error;
    }
});

export const updateSecurityFinding = onCall(async (request) => {
    const uid = authenticatedUid(request);
    const findingId = asString(request.data?.findingId, 64);
    const state = asString(request.data?.state, 20) as SecurityFindingState;
    if (!["active", "acknowledged", "remediated", "resolved", "muted"].includes(state)) {
        throw new HttpsError("invalid-argument", "Unsupported finding state.");
    }
    const ref = monitorRef(uid).collection("findings").doc(findingId);
    if (!(await ref.get()).exists) throw new HttpsError("not-found", "Security finding not found.");
    await ref.update({ state, updatedAt: FieldValue.serverTimestamp() });
    await writeTimeline(uid, `finding_${state}`, { findingId });
    return { success: true };
});

export const updateSecurityPreferences = onCall(async (request) => {
    const uid = authenticatedUid(request);
    const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (typeof request.data?.enabled === "boolean") patch.enabled = request.data.enabled;
    if (typeof request.data?.detailedNotifications === "boolean") {
        patch.detailedNotifications = request.data.detailedNotifications;
    }
    await monitorRef(uid).set(patch, { merge: true });
    await writeTimeline(uid, request.data?.enabled === false ? "monitoring_paused" : "preferences_updated");
    return { success: true };
});

async function rotateUserDataEncryptionKey(uid: string, enforceCooldown: boolean): Promise<number> {
    const rootRef = monitorRef(uid);
    const root = await rootRef.get();
    if (!root.exists) throw new HttpsError("not-found", "Security monitoring is not configured.");
    const rootData = root.data() ?? {};
    const lastRotationAt = toMillis(rootData.keyRotatedAt) ?? toMillis(rootData.createdAt) ?? 0;
    if (enforceCooldown && Date.now() - lastRotationAt < KEY_ROTATION_COOLDOWN_MS) {
        throw new HttpsError("resource-exhausted", "The encryption key was rotated recently.");
    }
    const currentWrappedDek = asString(rootData.wrappedDek, 8192);
    if (!currentWrappedDek) throw new HttpsError("failed-precondition", "Security encryption key is unavailable.");

    const keyProvider = new GoogleKmsKeyProvider(secretValue(kmsKeyName, "SECURITY_MONITORING_KMS_KEY"));
    const nextWrappedDek = await generateWrappedDek(keyProvider);
    const identities = await rootRef.collection("identities").get();
    const reencrypted: Array<{ ref: FirebaseFirestore.DocumentReference; value: EncryptedIdentityValue }> = [];
    for (const identity of identities.docs) {
        const data = identity.data();
        let plaintext = await decryptIdentityValue(
            data.encryptedValue as EncryptedIdentityValue,
            identityAad(uid, identity.id, data.type),
            keyProvider,
            currentWrappedDek,
        );
        try {
            reencrypted.push({
                ref: identity.ref,
                value: await encryptIdentityValue(
                    plaintext,
                    identityAad(uid, identity.id, data.type),
                    keyProvider,
                    nextWrappedDek,
                ),
            });
        } finally {
            plaintext = "";
        }
    }

    const nextVersion = Math.max(1, Number(rootData.keyVersion) || 1) + 1;
    const batch = getFirestore().batch();
    for (const entry of reencrypted) {
        batch.update(entry.ref, { encryptedValue: entry.value, updatedAt: FieldValue.serverTimestamp() });
    }
    batch.update(rootRef, {
        wrappedDek: nextWrappedDek,
        keyVersion: nextVersion,
        keyRotatedAt: FieldValue.serverTimestamp(),
        nextKeyRotationAt: Timestamp.fromMillis(Date.now() + KEY_ROTATION_INTERVAL_MS),
        updatedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();
    await writeTimeline(uid, "encryption_key_rotated", { keyVersion: nextVersion });
    return nextVersion;
}

export const rotateSecurityEncryptionKey = onCall({ secrets: [kmsKeyName] }, async (request) => {
    const uid = authenticatedUid(request);
    return { keyVersion: await rotateUserDataEncryptionKey(uid, true) };
});

const deleteQuery = async (query: Query): Promise<void> => {
    const snapshot = await query.limit(400).get();
    if (snapshot.empty) return;
    const batch = getFirestore().batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snapshot.size === 400) await deleteQuery(query);
};

async function enqueueOrRemoveFlareReference(uid: string, identityId: string, providerReference: string): Promise<void> {
    try {
        await new FlareProvider(secretValue(flareApiKey, "FLARE_API_KEY")).remove(providerReference);
    } catch {
        await getFirestore().collection("securityProviderDeletions").doc(randomUUID()).set({
            provider: "flare",
            providerReference,
            subjectHash: createHash("sha256").update(`${uid}:${identityId}`).digest("base64url"),
            status: "pending",
            createdAt: FieldValue.serverTimestamp(),
        });
    }
}

/** Called before Firebase Auth deletion so provider identifiers are removed or
 * durably queued while the server still has the user's monitoring metadata. */
export async function prepareSecurityMonitoringAccountDeletion(uid: string): Promise<void> {
    const identities = await monitorRef(uid).collection("identities").get();
    for (const identity of identities.docs) {
        const flareReference = asString(identity.data().providerReferences?.flare, 128);
        if (flareReference) await enqueueOrRemoveFlareReference(uid, identity.id, flareReference);
    }
}

export const removeSecurityIdentity = onCall({ secrets: monitoringSecrets }, async (request) => {
    const uid = authenticatedUid(request);
    const identityId = asString(request.data?.identityId, 64);
    const rootRef = monitorRef(uid);
    const identityRef = rootRef.collection("identities").doc(identityId);
    const identity = await identityRef.get();
    if (!identity.exists) return { success: true };
    const flareReference = asString(identity.data()?.providerReferences?.flare, 128);
    if (flareReference) await enqueueOrRemoveFlareReference(uid, identityId, flareReference);
    await deleteQuery(rootRef.collection("findings").where("identityId", "==", identityId));
    await identityRef.delete();
    await writeTimeline(uid, "identity_removed", { identityId, identityType: identity.data()?.type });
    return { success: true };
});

export const deleteSecurityMonitoringData = onCall({ secrets: monitoringSecrets, timeoutSeconds: 300 }, async (request) => {
    const uid = authenticatedUid(request);
    const rootRef = monitorRef(uid);
    const identities = await rootRef.collection("identities").get();
    for (const identity of identities.docs) {
        const flareReference = asString(identity.data().providerReferences?.flare, 128);
        if (flareReference) await enqueueOrRemoveFlareReference(uid, identity.id, flareReference);
    }
    for (const subcollection of ["findings", "identities", "timeline", "scanJobs", "auditEvents"]) {
        await deleteQuery(rootRef.collection(subcollection));
    }
    await rootRef.delete();
    return { success: true };
});

export const scheduledSecurityScans = onSchedule(
    { schedule: "every 30 minutes", timeoutSeconds: 540, secrets: monitoringSecrets },
    async () => {
        const due = await getFirestore().collection(SECURITY_COLLECTION)
            .where("enabled", "==", true)
            .where("nextScanAt", "<=", Timestamp.now())
            .limit(25)
            .get();
        for (const monitor of due.docs) {
            const bucket = new Date().toISOString().slice(0, 13).replace(/[-T]/g, "");
            const requestId = `scheduled_${bucket}`;
            const jobRef = monitor.ref.collection("scanJobs").doc(requestId);
            try {
                await jobRef.create({ requestId, status: "running", source: "scheduled", createdAt: FieldValue.serverTimestamp() });
                if ((toMillis(monitor.data().nextKeyRotationAt) ?? Number.POSITIVE_INFINITY) <= Date.now()) {
                    await rotateUserDataEncryptionKey(monitor.id, false);
                }
                await runSecurityScan(monitor.id, requestId, "scheduled");
            } catch (error) {
                if ((error as { code?: number }).code !== 6) {
                    await jobRef.set({ status: "failed", safeMessage: "Scheduled scan failed safely.", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
                }
            }
        }
    },
);

export const scheduledSecurityProviderDeletions = onSchedule(
    { schedule: "every 60 minutes", timeoutSeconds: 300, secrets: [flareApiKey] },
    async () => {
        const pending = await getFirestore().collection("securityProviderDeletions")
            .where("status", "==", "pending")
            .limit(100)
            .get();
        const provider = new FlareProvider(secretValue(flareApiKey, "FLARE_API_KEY"));
        for (const deletion of pending.docs) {
            try {
                await provider.remove(asString(deletion.data().providerReference, 128));
                await deletion.ref.delete();
            } catch {
                await deletion.ref.set({
                    attempts: FieldValue.increment(1),
                    lastAttemptAt: FieldValue.serverTimestamp(),
                }, { merge: true });
            }
        }
    },
);

export const securityMonitoringSecrets = {
    kmsKeyName,
    blindIndexKey,
    hibpApiKey,
    flareApiKey,
};
