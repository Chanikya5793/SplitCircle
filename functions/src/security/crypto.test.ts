import { describe, expect, it } from "vitest";
import {
    blindIndex,
    decryptIdentityValue,
    encryptIdentityValue,
    generateWrappedDek,
    identityAad,
    type EnvelopeKeyProvider,
} from "./crypto";

const provider: EnvelopeKeyProvider = {
    wrapKey: async (plaintext) => Buffer.from(plaintext.map((value) => value ^ 0xa5)),
    unwrapKey: async (ciphertext) => Buffer.from(ciphertext.map((value) => value ^ 0xa5)),
};

describe("security identity envelope encryption", () => {
    it("round-trips with a unique DEK and never embeds plaintext", async () => {
        const value = "owner@example.com";
        const aad = identityAad("u1", "i1", "email");
        const first = await encryptIdentityValue(value, aad, provider);
        const second = await encryptIdentityValue(value, aad, provider);

        expect(JSON.stringify(first)).not.toContain(value);
        expect(first.ciphertext).not.toBe(second.ciphertext);
        expect(first.wrappedDek).not.toBe(second.wrappedDek);
        await expect(decryptIdentityValue(first, aad, provider)).resolves.toBe(value);
    });

    it("binds ciphertext to user, identity, and type through authenticated data", async () => {
        const encrypted = await encryptIdentityValue(
            "owner@example.com",
            identityAad("u1", "i1", "email"),
            provider,
        );
        await expect(
            decryptIdentityValue(encrypted, identityAad("u2", "i1", "email"), provider),
        ).rejects.toThrow();
    });

    it("uses one wrapped per-user DEK across identities and supports rotation", async () => {
        const firstWrappedDek = await generateWrappedDek(provider);
        const email = await encryptIdentityValue(
            "owner@example.com",
            identityAad("u1", "email-1", "email"),
            provider,
            firstWrappedDek,
        );
        const domain = await encryptIdentityValue(
            "example.com",
            identityAad("u1", "domain-1", "domain"),
            provider,
            firstWrappedDek,
        );
        expect(email.wrappedDek).toBeUndefined();
        expect(domain.wrappedDek).toBeUndefined();
        await expect(decryptIdentityValue(email, identityAad("u1", "email-1", "email"), provider, firstWrappedDek))
            .resolves.toBe("owner@example.com");

        const nextWrappedDek = await generateWrappedDek(provider);
        const plaintext = await decryptIdentityValue(email, identityAad("u1", "email-1", "email"), provider, firstWrappedDek);
        const rotated = await encryptIdentityValue(plaintext, identityAad("u1", "email-1", "email"), provider, nextWrappedDek);
        await expect(decryptIdentityValue(rotated, identityAad("u1", "email-1", "email"), provider, nextWrappedDek))
            .resolves.toBe("owner@example.com");
        await expect(decryptIdentityValue(rotated, identityAad("u1", "email-1", "email"), provider, firstWrappedDek))
            .rejects.toThrow();
    });

    it("scopes blind indexes per user and rejects weak indexing secrets", () => {
        const secret = "a-security-secret-with-more-than-thirty-two-characters";
        expect(blindIndex("u1", "email", "owner@example.com", secret)).not.toBe(
            blindIndex("u2", "email", "owner@example.com", secret),
        );
        expect(blindIndex("u1", "email", "owner@example.com", secret)).toBe(
            blindIndex("u1", "email", "owner@example.com", secret),
        );
        expect(() => blindIndex("u1", "email", "owner@example.com", "weak")).toThrow();
    });
});
