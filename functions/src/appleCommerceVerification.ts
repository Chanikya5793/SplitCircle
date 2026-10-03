import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { X509Certificate } from "node:crypto";
import {
    Environment,
    InAppOwnershipType,
    SignedDataVerifier,
    Type,
    VerificationException,
    VerificationStatus,
    type JWSRenewalInfoDecodedPayload,
    type JWSTransactionDecodedPayload,
    type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";

import {
    APPLE_APP_ID,
    APPLE_BUNDLE_ID,
    getAppleProduct,
    type AppleProduct,
} from "./commerceCatalog";

export type AppleCommerceEnvironment = "sandbox" | "production";

export type AppleCommerceVerificationErrorCode =
    | "invalid_input"
    | "invalid_certificate_configuration"
    | "signature_verification_failed"
    | "retryable_verification_failed"
    | "invalid_bundle"
    | "invalid_environment"
    | "invalid_app_id"
    | "unknown_product"
    | "product_mismatch"
    | "transaction_mismatch"
    | "account_token_mismatch"
    | "invalid_quantity"
    | "type_mismatch"
    | "invalid_ownership"
    | "revoked"
    | "expired"
    | "invalid_notification";

export class AppleCommerceVerificationError extends Error {
    readonly code: AppleCommerceVerificationErrorCode;
    readonly causeValue?: unknown;

    constructor(
        code: AppleCommerceVerificationErrorCode,
        message: string,
        causeValue?: unknown,
    ) {
        super(message);
        this.name = "AppleCommerceVerificationError";
        this.code = code;
        this.causeValue = causeValue;
    }
}

export interface AppleRootCertificateOptions {
    /** Explicit certificate files. Relative paths resolve from functions/. */
    rootCertificatePaths?: readonly string[];
    /** Explicit directory containing .cer, .der, .crt, .pem, or .b64 files. */
    rootCertificateDirectory?: string;
}

export interface AppleSignedDataVerifierOptions extends AppleRootCertificateOptions {
    /** Online OCSP and current-date checks are on by default and required outside tests/emulators. */
    enableOnlineChecks?: boolean;
}

export interface AppleTransactionExpectation {
    environment: AppleCommerceEnvironment;
    productId?: string;
    transactionId?: string;
    appAccountToken?: string;
    requireActive?: boolean;
    nowMs?: number;
}

export interface ValidatedAppleTransaction {
    decoded: JWSTransactionDecodedPayload;
    product: AppleProduct;
    environment: AppleCommerceEnvironment;
    productId: string;
    transactionId: string;
    originalTransactionId: string;
    appAccountToken: string;
    purchaseDate: number;
    signedDate: number;
    expiresDate: number | null;
    isExpired: boolean;
    isRevoked: boolean;
    isUpgraded: boolean;
}

export interface VerifyApplePurchaseInput {
    signedTransactionInfo: string;
    environment: AppleCommerceEnvironment;
    productId: string;
    transactionId: string;
    appAccountToken: string;
    nowMs?: number;
}

export interface ValidatedAppleRenewalInfo {
    decoded: JWSRenewalInfoDecodedPayload;
    environment: AppleCommerceEnvironment;
    originalTransactionId: string;
    productId: string | null;
    autoRenewProductId: string | null;
    appAccountToken: string | null;
    gracePeriodExpiresDate: number | null;
    signedDate: number;
}

export interface VerifiedAppleServerNotification {
    decoded: ResponseBodyV2DecodedPayload;
    environment: AppleCommerceEnvironment;
    transaction: ValidatedAppleTransaction | null;
    renewalInfo: ValidatedAppleRenewalInfo | null;
}

interface TransactionJwsVerifier {
    verifyAndDecodeTransaction(value: string): Promise<JWSTransactionDecodedPayload>;
}

interface NotificationJwsVerifier extends TransactionJwsVerifier {
    verifyAndDecodeNotification(value: string): Promise<ResponseBodyV2DecodedPayload>;
    verifyAndDecodeRenewalInfo(value: string): Promise<JWSRenewalInfoDecodedPayload>;
}

export interface ApplePurchaseVerificationOptions extends AppleSignedDataVerifierOptions {
    verifier?: TransactionJwsVerifier;
}

export interface AppleNotificationVerificationOptions extends AppleSignedDataVerifierOptions {
    verifier?: NotificationJwsVerifier;
    nowMs?: number;
}

const MAX_JWS_LENGTH = 512 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TRANSACTION_IDENTIFIER = /^[^\s]{1,128}$/;
const CERTIFICATE_EXTENSIONS = new Set([".cer", ".der", ".crt", ".pem", ".b64"]);

// Apple publishes these trust anchors at https://www.apple.com/certificateauthority/.
// Pinning the fingerprints prevents an arbitrary self-signed certificate from becoming
// trusted merely because a runtime path was misconfigured.
const APPROVED_APPLE_ROOT_FINGERPRINTS = new Set([
    "B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24",
    "C2:B9:B0:42:DD:57:83:0E:7D:11:7D:AC:55:AC:8A:E1:94:07:D3:8E:41:D8:8F:32:15:BC:3A:89:04:44:A0:50",
    "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79",
]);

function fail(
    code: AppleCommerceVerificationErrorCode,
    message: string,
    causeValue?: unknown,
): never {
    throw new AppleCommerceVerificationError(code, message, causeValue);
}

function failSignedDataVerification(message: string, error: unknown): never {
    if (error instanceof VerificationException) {
        if (error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
            return fail("retryable_verification_failed", message, error);
        }
        if (error.status === VerificationStatus.INVALID_ENVIRONMENT) {
            return fail("invalid_environment", message, error);
        }
    }
    return fail("signature_verification_failed", message, error);
}

export function isRetryableAppleCommerceVerificationError(
    error: unknown,
): error is AppleCommerceVerificationError {
    return error instanceof AppleCommerceVerificationError &&
        error.code === "retryable_verification_failed";
}

function functionsDirectory(): string {
    return resolve(__dirname, "..");
}

function resolveCertificatePath(value: string): string {
    return isAbsolute(value) ? value : resolve(functionsDirectory(), value);
}

function parseCertificatePathsEnvironment(value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("[")) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch (error) {
            return fail(
                "invalid_certificate_configuration",
                "APPLE_ROOT_CERTIFICATE_PATHS contains invalid JSON.",
                error,
            );
        }
        if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
            return fail(
                "invalid_certificate_configuration",
                "APPLE_ROOT_CERTIFICATE_PATHS must be a JSON string array.",
            );
        }
        return parsed;
    }

    return trimmed.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function defaultCertificateDirectory(): string {
    const candidates = [
        join(__dirname, "appleRootCertificates"),
        join(__dirname, "..", "src", "appleRootCertificates"),
        join(process.cwd(), "src", "appleRootCertificates"),
    ];
    const match = candidates.find((candidate) => existsSync(candidate));
    if (!match) {
        return fail(
            "invalid_certificate_configuration",
            "Bundled Apple root certificates are missing.",
        );
    }
    return match;
}

function configuredCertificatePaths(options: AppleRootCertificateOptions): string[] {
    if (options.rootCertificatePaths && options.rootCertificateDirectory) {
        return fail(
            "invalid_certificate_configuration",
            "Configure Apple root certificate files or a directory, not both.",
        );
    }

    if (options.rootCertificatePaths) {
        return options.rootCertificatePaths.map(resolveCertificatePath);
    }

    const environmentPaths = options.rootCertificateDirectory
        ? undefined
        : process.env.APPLE_ROOT_CERTIFICATE_PATHS;
    const environmentDirectory = options.rootCertificateDirectory
        ? undefined
        : process.env.APPLE_ROOT_CERTIFICATES_DIR;
    if (environmentPaths && environmentDirectory) {
        return fail(
            "invalid_certificate_configuration",
            "Configure APPLE_ROOT_CERTIFICATE_PATHS or APPLE_ROOT_CERTIFICATES_DIR, not both.",
        );
    }

    if (environmentPaths) {
        return parseCertificatePathsEnvironment(environmentPaths).map(resolveCertificatePath);
    }

    const directory = resolveCertificatePath(
        options.rootCertificateDirectory ?? environmentDirectory ?? defaultCertificateDirectory(),
    );
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        return fail(
            "invalid_certificate_configuration",
            "The configured Apple root certificate directory does not exist.",
        );
    }

    return readdirSync(directory)
        .filter((name) => CERTIFICATE_EXTENSIONS.has(extname(name).toLowerCase()))
        .sort()
        .map((name) => join(directory, name));
}

function decodeCertificateFile(filePath: string): Buffer {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        return fail(
            "invalid_certificate_configuration",
            "A configured Apple root certificate file does not exist.",
        );
    }

    const file = readFileSync(filePath);
    if (extname(filePath).toLowerCase() !== ".b64") return file;

    const encoded = file.toString("utf8").replace(/\s+/g, "");
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        return fail(
            "invalid_certificate_configuration",
            "An Apple root certificate base64 file is malformed.",
        );
    }
    return Buffer.from(encoded, "base64");
}

/** Loads, validates, pins, and returns DER-encoded Apple root certificates. */
export function loadAppleRootCertificates(
    options: AppleRootCertificateOptions = {},
): Buffer[] {
    const paths = configuredCertificatePaths(options);
    if (paths.length === 0 || paths.length > 8) {
        return fail(
            "invalid_certificate_configuration",
            "Expected between one and eight Apple root certificates.",
        );
    }

    const certificates = new Map<string, Buffer>();
    for (const filePath of paths) {
        try {
            const certificate = new X509Certificate(decodeCertificateFile(filePath));
            if (
                !certificate.ca
                || !certificate.checkIssued(certificate)
                || !certificate.verify(certificate.publicKey)
            ) {
                return fail(
                    "invalid_certificate_configuration",
                    "An Apple trust anchor is not a self-issued CA certificate.",
                );
            }
            if (!APPROVED_APPLE_ROOT_FINGERPRINTS.has(certificate.fingerprint256)) {
                return fail(
                    "invalid_certificate_configuration",
                    "An Apple trust anchor has an unapproved SHA-256 fingerprint.",
                );
            }
            certificates.set(certificate.fingerprint256, certificate.raw);
        } catch (error) {
            if (error instanceof AppleCommerceVerificationError) throw error;
            return fail(
                "invalid_certificate_configuration",
                "An Apple root certificate could not be decoded.",
                error,
            );
        }
    }

    return [...certificates.values()];
}

function appleLibraryEnvironment(environment: AppleCommerceEnvironment): Environment {
    return environment === "production" ? Environment.PRODUCTION : Environment.SANDBOX;
}

/** Creates an Apple verifier bound to exactly one App Store environment. */
export function createAppleSignedDataVerifier(
    environment: AppleCommerceEnvironment,
    options: AppleSignedDataVerifierOptions = {},
): SignedDataVerifier {
    if (environment !== "sandbox" && environment !== "production") {
        return fail("invalid_environment", "Unsupported Apple commerce environment.");
    }

    const enableOnlineChecks = options.enableOnlineChecks ?? true;
    if (
        !enableOnlineChecks
        && process.env.NODE_ENV !== "test"
        && process.env.FUNCTIONS_EMULATOR !== "true"
    ) {
        return fail(
            "invalid_certificate_configuration",
            "Apple online certificate checks may only be disabled in tests or the emulator.",
        );
    }

    return new SignedDataVerifier(
        loadAppleRootCertificates(options),
        enableOnlineChecks,
        appleLibraryEnvironment(environment),
        APPLE_BUNDLE_ID,
        environment === "production" ? APPLE_APP_ID : undefined,
    );
}

const defaultVerifierCache: Partial<Record<AppleCommerceEnvironment, SignedDataVerifier>> = {};

/**
 * Reuses the verifier's verified-public-key cache for normal function traffic.
 * Explicit certificate or test settings intentionally receive an isolated instance.
 */
export function getAppleSignedDataVerifier(
    environment: AppleCommerceEnvironment,
    options: AppleSignedDataVerifierOptions = {},
): SignedDataVerifier {
    const usesDefaultConfiguration = options.rootCertificatePaths === undefined
        && options.rootCertificateDirectory === undefined
        && options.enableOnlineChecks === undefined;
    if (!usesDefaultConfiguration) {
        return createAppleSignedDataVerifier(environment, options);
    }

    const cached = defaultVerifierCache[environment];
    if (cached) return cached;
    const verifier = createAppleSignedDataVerifier(environment);
    defaultVerifierCache[environment] = verifier;
    return verifier;
}

function requireCompactJws(value: unknown, fieldName: string): asserts value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_JWS_LENGTH) {
        return fail("invalid_input", `${fieldName} is not a valid compact JWS.`);
    }
    const sections = value.split(".");
    if (
        sections.length !== 3
        || sections.some((section) => !section || !/^[A-Za-z0-9_-]+$/.test(section))
    ) {
        return fail("invalid_input", `${fieldName} is not a valid compact JWS.`);
    }
}

function requireIdentifier(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || !SAFE_TRANSACTION_IDENTIFIER.test(value)) {
        return fail("invalid_input", `${fieldName} is missing or malformed.`);
    }
    return value;
}

function requireUuid(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        return fail("invalid_input", `${fieldName} is missing or malformed.`);
    }
    return value;
}

function requireTimestamp(value: unknown, fieldName: string, nowMs: number): number {
    if (
        typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value <= 0
        || value > nowMs + MAX_CLOCK_SKEW_MS
    ) {
        return fail("invalid_input", `${fieldName} is missing or malformed.`);
    }
    return value;
}

function decodedEnvironment(value: unknown): AppleCommerceEnvironment | null {
    if (value === Environment.PRODUCTION) return "production";
    if (value === Environment.SANDBOX) return "sandbox";
    return null;
}

/**
 * Performs pure, deterministic validation of a decoded Apple transaction.
 * Set requireActive for a new purchase. Lifecycle notifications intentionally
 * use false so an expired or revoked transaction can remove an entitlement.
 */
export function validateAppleTransactionPayload(
    decoded: JWSTransactionDecodedPayload,
    expectation: AppleTransactionExpectation,
): ValidatedAppleTransaction {
    const nowMs = expectation.nowMs ?? Date.now();
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
        return fail("invalid_input", "nowMs must be a positive millisecond timestamp.");
    }

    if (decoded.bundleId !== APPLE_BUNDLE_ID) {
        return fail("invalid_bundle", "The Apple transaction belongs to another bundle.");
    }
    const environment = decodedEnvironment(decoded.environment);
    if (!environment || environment !== expectation.environment) {
        return fail("invalid_environment", "The Apple transaction environment does not match.");
    }

    const productId = requireIdentifier(decoded.productId, "productId");
    const product = getAppleProduct(productId);
    if (!product) {
        return fail("unknown_product", "The Apple transaction product is not in the server catalog.");
    }
    if (expectation.productId !== undefined && productId !== expectation.productId) {
        return fail("product_mismatch", "The Apple transaction product does not match the request.");
    }

    const transactionId = requireIdentifier(decoded.transactionId, "transactionId");
    if (expectation.transactionId !== undefined && transactionId !== expectation.transactionId) {
        return fail(
            "transaction_mismatch",
            "The Apple transaction identifier does not match the request.",
        );
    }
    const originalTransactionId = requireIdentifier(
        decoded.originalTransactionId,
        "originalTransactionId",
    );

    const appAccountToken = requireUuid(decoded.appAccountToken, "appAccountToken");
    if (
        expectation.appAccountToken !== undefined
        && appAccountToken !== requireUuid(expectation.appAccountToken, "expected appAccountToken")
    ) {
        return fail(
            "account_token_mismatch",
            "The Apple transaction account token does not match the signed-in account.",
        );
    }

    if (decoded.quantity !== 1) {
        return fail("invalid_quantity", "Only a quantity of one is accepted.");
    }

    const expectedType = product.kind === "subscription"
        ? Type.AUTO_RENEWABLE_SUBSCRIPTION
        : Type.CONSUMABLE;
    if (decoded.type !== expectedType) {
        return fail("type_mismatch", "The Apple transaction product type does not match the catalog.");
    }

    if (decoded.inAppOwnershipType !== InAppOwnershipType.PURCHASED) {
        return fail(
            "invalid_ownership",
            "Only purchases owned by the signed-in Apple account are accepted.",
        );
    }

    const purchaseDate = requireTimestamp(decoded.purchaseDate, "purchaseDate", nowMs);
    const signedDate = requireTimestamp(decoded.signedDate, "signedDate", nowMs);

    let expiresDate: number | null = null;
    if (product.kind === "subscription") {
        if (
            typeof decoded.expiresDate !== "number"
            || !Number.isSafeInteger(decoded.expiresDate)
            || decoded.expiresDate <= 0
        ) {
            return fail("type_mismatch", "The subscription transaction has no valid expiration.");
        }
        expiresDate = decoded.expiresDate;
    } else if (decoded.expiresDate !== undefined) {
        return fail("type_mismatch", "A consumable credit transaction cannot have an expiration.");
    }

    const isRevoked = decoded.revocationDate !== undefined;
    if (
        isRevoked
        && (
            typeof decoded.revocationDate !== "number"
            || !Number.isSafeInteger(decoded.revocationDate)
            || decoded.revocationDate <= 0
            || decoded.revocationDate > nowMs + MAX_CLOCK_SKEW_MS
        )
    ) {
        return fail("invalid_input", "revocationDate is malformed.");
    }
    const isExpired = expiresDate !== null && expiresDate <= nowMs;
    const isUpgraded = decoded.isUpgraded === true;

    if (expectation.requireActive) {
        if (isRevoked || isUpgraded) {
            return fail("revoked", "The Apple transaction is revoked or superseded.");
        }
        if (isExpired) {
            return fail("expired", "The Apple subscription transaction has expired.");
        }
    }

    return {
        decoded,
        product,
        environment,
        productId,
        transactionId,
        originalTransactionId,
        appAccountToken,
        purchaseDate,
        signedDate,
        expiresDate,
        isExpired,
        isRevoked,
        isUpgraded,
    };
}

/** Verifies Apple's signature and validates an exact client purchase request. */
export async function verifyApplePurchaseTransaction(
    input: VerifyApplePurchaseInput,
    options: ApplePurchaseVerificationOptions = {},
): Promise<ValidatedAppleTransaction> {
    requireCompactJws(input.signedTransactionInfo, "signedTransactionInfo");
    requireIdentifier(input.productId, "productId");
    requireIdentifier(input.transactionId, "transactionId");
    requireUuid(input.appAccountToken, "appAccountToken");

    const verifier = options.verifier
        ?? getAppleSignedDataVerifier(input.environment, options);
    let decoded: JWSTransactionDecodedPayload;
    try {
        decoded = await verifier.verifyAndDecodeTransaction(input.signedTransactionInfo);
    } catch (error) {
        return failSignedDataVerification(
            "Apple could not verify the signed transaction.",
            error,
        );
    }

    return validateAppleTransactionPayload(decoded, {
        environment: input.environment,
        productId: input.productId,
        transactionId: input.transactionId,
        appAccountToken: input.appAccountToken,
        requireActive: true,
        nowMs: input.nowMs,
    });
}

function validateRenewalInfo(
    decoded: JWSRenewalInfoDecodedPayload,
    environment: AppleCommerceEnvironment,
    nowMs: number,
): ValidatedAppleRenewalInfo {
    if (decodedEnvironment(decoded.environment) !== environment) {
        return fail("invalid_environment", "The Apple renewal environment does not match.");
    }
    const originalTransactionId = requireIdentifier(
        decoded.originalTransactionId,
        "renewal originalTransactionId",
    );

    const productId = decoded.productId === undefined
        ? null
        : requireIdentifier(decoded.productId, "renewal productId");
    if (productId && getAppleProduct(productId)?.kind !== "subscription") {
        return fail("unknown_product", "The Apple renewal product is not in the server catalog.");
    }

    const autoRenewProductId = decoded.autoRenewProductId === undefined
        ? null
        : requireIdentifier(decoded.autoRenewProductId, "autoRenewProductId");
    if (autoRenewProductId && getAppleProduct(autoRenewProductId)?.kind !== "subscription") {
        return fail("unknown_product", "The Apple auto-renew product is not in the server catalog.");
    }

    const appAccountToken = requireUuid(decoded.appAccountToken, "renewal appAccountToken");
    const signedDate = requireTimestamp(decoded.signedDate, "renewal signedDate", nowMs);
    let gracePeriodExpiresDate: number | null = null;
    if (decoded.gracePeriodExpiresDate !== undefined) {
        if (typeof decoded.gracePeriodExpiresDate !== "number" ||
            !Number.isSafeInteger(decoded.gracePeriodExpiresDate) ||
            decoded.gracePeriodExpiresDate <= 0) {
            return fail("invalid_input", "gracePeriodExpiresDate is malformed.");
        }
        gracePeriodExpiresDate = decoded.gracePeriodExpiresDate;
    }

    return {
        decoded,
        environment,
        originalTransactionId,
        productId,
        autoRenewProductId,
        appAccountToken,
        gracePeriodExpiresDate,
        signedDate,
    };
}

function validateNotificationEnvelope(
    decoded: ResponseBodyV2DecodedPayload,
    environment: AppleCommerceEnvironment,
    nowMs: number,
): void {
    requireIdentifier(decoded.notificationType, "notificationType");
    requireUuid(decoded.notificationUUID, "notificationUUID");
    if (decoded.version !== "2.0") {
        return fail("invalid_notification", "Only App Store Server Notifications V2 are accepted.");
    }
    requireTimestamp(decoded.signedDate, "notification signedDate", nowMs);

    if (decoded.data) {
        if (decoded.data.bundleId !== APPLE_BUNDLE_ID) {
            return fail("invalid_bundle", "The Apple notification belongs to another bundle.");
        }
        if (decodedEnvironment(decoded.data.environment) !== environment) {
            return fail("invalid_environment", "The Apple notification environment does not match.");
        }
        if (environment === "production" && decoded.data.appAppleId !== APPLE_APP_ID) {
            return fail("invalid_app_id", "The Apple notification belongs to another app.");
        }
    }
}

/**
 * Verifies a V2 notification and every nested JWS with a verifier bound to the
 * caller-selected environment. The returned lifecycle transaction reports
 * revocation/expiration state instead of rejecting it, allowing the caller to
 * remove or update an entitlement atomically.
 */
export async function verifyAppleServerNotification(
    signedPayload: string,
    environment: AppleCommerceEnvironment,
    options: AppleNotificationVerificationOptions = {},
): Promise<VerifiedAppleServerNotification> {
    requireCompactJws(signedPayload, "signedPayload");
    const nowMs = options.nowMs ?? Date.now();
    const verifier = options.verifier
        ?? getAppleSignedDataVerifier(environment, options);

    let decoded: ResponseBodyV2DecodedPayload;
    try {
        decoded = await verifier.verifyAndDecodeNotification(signedPayload);
    } catch (error) {
        return failSignedDataVerification(
            "Apple could not verify the signed server notification.",
            error,
        );
    }
    validateNotificationEnvelope(decoded, environment, nowMs);

    let transaction: ValidatedAppleTransaction | null = null;
    if (decoded.data?.signedTransactionInfo) {
        requireCompactJws(decoded.data.signedTransactionInfo, "notification signedTransactionInfo");
        let transactionPayload: JWSTransactionDecodedPayload;
        try {
            transactionPayload = await verifier.verifyAndDecodeTransaction(
                decoded.data.signedTransactionInfo,
            );
        } catch (error) {
            return failSignedDataVerification(
                "Apple could not verify the notification transaction.",
                error,
            );
        }
        transaction = validateAppleTransactionPayload(transactionPayload, {
            environment,
            requireActive: false,
            nowMs,
        });
    }

    let renewalInfo: ValidatedAppleRenewalInfo | null = null;
    if (decoded.data?.signedRenewalInfo) {
        requireCompactJws(decoded.data.signedRenewalInfo, "notification signedRenewalInfo");
        let renewalPayload: JWSRenewalInfoDecodedPayload;
        try {
            renewalPayload = await verifier.verifyAndDecodeRenewalInfo(
                decoded.data.signedRenewalInfo,
            );
        } catch (error) {
            return failSignedDataVerification(
                "Apple could not verify the notification renewal information.",
                error,
            );
        }
        renewalInfo = validateRenewalInfo(renewalPayload, environment, nowMs);
    }

    if (transaction && renewalInfo) {
        if (transaction.originalTransactionId !== renewalInfo.originalTransactionId) {
            return fail(
                "invalid_notification",
                "The nested Apple transaction and renewal identifiers do not match.",
            );
        }
        if (
            renewalInfo.appAccountToken
            && renewalInfo.appAccountToken !== transaction.appAccountToken
        ) {
            return fail(
                "account_token_mismatch",
                "The nested Apple transaction and renewal account tokens do not match.",
            );
        }
    }

    return {
        decoded,
        environment,
        transaction,
        renewalInfo,
    };
}
