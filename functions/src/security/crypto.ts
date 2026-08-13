import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";

export interface EnvelopeKeyProvider {
    wrapKey(plaintext: Buffer): Promise<Buffer>;
    unwrapKey(ciphertext: Buffer): Promise<Buffer>;
}

export interface EncryptedIdentityValue {
    algorithm: "A256GCM";
    keyVersion: 1;
    ciphertext: string;
    iv: string;
    tag: string;
    /** Legacy per-record wrapped key. New records use the monitor's per-user wrappedDek. */
    wrappedDek?: string;
}

export class GoogleKmsKeyProvider implements EnvelopeKeyProvider {
    private readonly client: KeyManagementServiceClient;

    constructor(private readonly keyName: string, client?: KeyManagementServiceClient) {
        if (!keyName.trim()) throw new Error("SECURITY_MONITORING_KMS_KEY is not configured");
        this.client = client ?? new KeyManagementServiceClient();
    }

    async wrapKey(plaintext: Buffer): Promise<Buffer> {
        const [response] = await this.client.encrypt({ name: this.keyName, plaintext });
        if (!response.ciphertext) throw new Error("KMS did not return wrapped key material");
        return Buffer.from(response.ciphertext as Uint8Array);
    }

    async unwrapKey(ciphertext: Buffer): Promise<Buffer> {
        const [response] = await this.client.decrypt({ name: this.keyName, ciphertext });
        if (!response.plaintext) throw new Error("KMS did not return unwrapped key material");
        return Buffer.from(response.plaintext as Uint8Array);
    }
}

export const identityAad = (uid: string, identityId: string, type: string): Buffer =>
    Buffer.from(`manasplit-security:v1:${uid}:${identityId}:${type}`, "utf8");

export async function encryptIdentityValue(
    plaintext: string,
    aad: Buffer,
    keyProvider: EnvelopeKeyProvider,
    existingWrappedDek?: string,
): Promise<EncryptedIdentityValue> {
    const dek = existingWrappedDek
        ? await keyProvider.unwrapKey(Buffer.from(existingWrappedDek, "base64"))
        : randomBytes(32);
    const iv = randomBytes(12);
    try {
        const cipher = createCipheriv("aes-256-gcm", dek, iv);
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const wrappedDek = existingWrappedDek ? null : await keyProvider.wrapKey(dek);
        return {
            algorithm: "A256GCM",
            keyVersion: 1,
            ciphertext: ciphertext.toString("base64"),
            iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            ...(wrappedDek ? { wrappedDek: wrappedDek.toString("base64") } : {}),
        };
    } finally {
        dek.fill(0);
    }
}

export async function decryptIdentityValue(
    encrypted: EncryptedIdentityValue,
    aad: Buffer,
    keyProvider: EnvelopeKeyProvider,
    userWrappedDek?: string,
): Promise<string> {
    if (encrypted.algorithm !== "A256GCM" || encrypted.keyVersion !== 1) {
        throw new Error("Unsupported identity encryption format");
    }
    const wrappedDek = userWrappedDek ?? encrypted.wrappedDek;
    if (!wrappedDek) throw new Error("Missing wrapped user data-encryption key");
    const dek = await keyProvider.unwrapKey(Buffer.from(wrappedDek, "base64"));
    try {
        const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(encrypted.iv, "base64"));
        decipher.setAAD(aad);
        decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
        return Buffer.concat([
            decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
            decipher.final(),
        ]).toString("utf8");
    } finally {
        dek.fill(0);
    }
}

export async function generateWrappedDek(keyProvider: EnvelopeKeyProvider): Promise<string> {
    const dek = randomBytes(32);
    try {
        return (await keyProvider.wrapKey(dek)).toString("base64");
    } finally {
        dek.fill(0);
    }
}

export function blindIndex(uid: string, type: string, normalizedValue: string, secret: string): string {
    if (secret.length < 32) throw new Error("SECURITY_BLIND_INDEX_KEY must contain at least 32 characters");
    return createHmac("sha256", secret)
        .update(`v1\0${uid}\0${type}\0${normalizedValue}`, "utf8")
        .digest("base64url");
}
