import { describe, expect, it, vi } from "vitest";

import {
    appleNotificationHttpStatusForError,
    verifyNotificationInEitherEnvironment,
} from "./appleCommerce";
import {
    AppleCommerceVerificationError,
    type VerifiedAppleServerNotification,
} from "./appleCommerceVerification";

const COMPACT_JWS = "eyJhbGciOiJFUzI1NiJ9.e30.AA";

function verificationError(
    code: ConstructorParameters<typeof AppleCommerceVerificationError>[0],
): AppleCommerceVerificationError {
    return new AppleCommerceVerificationError(code, code);
}

describe("App Store notification delivery reliability", () => {
    it("falls back to sandbox only after a genuine production environment mismatch", async () => {
        const sandboxNotification = {
            environment: "sandbox",
            decoded: {},
            transaction: null,
            renewalInfo: null,
        } as VerifiedAppleServerNotification;
        const verify = vi.fn()
            .mockRejectedValueOnce(verificationError("invalid_environment"))
            .mockResolvedValueOnce(sandboxNotification);

        await expect(verifyNotificationInEitherEnvironment(
            COMPACT_JWS,
            verify,
        )).resolves.toBe(sandboxNotification);
        expect(verify.mock.calls.map((call) => call[1])).toEqual([
            "production",
            "sandbox",
        ]);
    });

    it.each([
        "signature_verification_failed",
        "retryable_verification_failed",
        "invalid_app_id",
    ] as const)("does not try sandbox after %s in production", async (code) => {
        const error = verificationError(code);
        const verify = vi.fn().mockRejectedValue(error);

        await expect(verifyNotificationInEitherEnvironment(
            COMPACT_JWS,
            verify,
        )).rejects.toBe(error);
        expect(verify).toHaveBeenCalledTimes(1);
        expect(verify).toHaveBeenCalledWith(COMPACT_JWS, "production");
    });

    it("maps transient verifier failures to a retryable HTTP response", () => {
        expect(appleNotificationHttpStatusForError(
            verificationError("retryable_verification_failed"),
        )).toBe(503);
        expect(appleNotificationHttpStatusForError(
            verificationError("signature_verification_failed"),
        )).toBe(400);
    });
});
