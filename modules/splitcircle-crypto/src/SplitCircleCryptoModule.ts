import { requireOptionalNativeModule } from 'expo';

/** Public prekey material for one device — safe to publish to Firestore. */
export interface PublishableBundle {
  registrationId: number;
  identityKey: string;
  signedPreKeyId: number;
  signedPreKeyPublic: string;
  signedPreKeySignature: string;
  kyberPreKeyId: number;
  kyberPreKeyPublic: string;
  kyberPreKeySignature: string;
  oneTimePreKeys: { keyId: number; publicKey: string }[];
}

/**
 * A peer's bundle as consumed by `establishSession`. Same shape as
 * `PublishableBundle` except the caller passes ONE claimed one-time prekey
 * instead of the whole list. Omitting it is legal — the peer is then out of
 * one-time prekeys and the handshake falls back to the signed prekey (weaker
 * forward secrecy for that one handshake, which is why they get replenished).
 */
export type PeerBundle = Omit<PublishableBundle, 'oneTimePreKeys'> & {
  oneTimePreKey?: { keyId: number; publicKey: string };
};

/**
 * Ciphertext envelope. `type` is libsignal's message type and the receiver
 * MUST dispatch on it (prekey vs. whisper decrypt paths differ) — it is
 * protocol data, not a hint.
 */
export interface SignalEnvelope {
  type: number;
  body: string;
}

export interface SplitCircleCryptoNativeModule {
  /** `deviceId` is libsignal's small-integer device id (1-127), NOT the UUID installation id. */
  bootstrap(
    userId: string,
    deviceId: number,
  ): Promise<{ registrationId: number; identityKey: string; deviceId: number }>;
  hasIdentity(): Promise<boolean>;
  generatePublishableBundle(oneTimeCount: number): Promise<PublishableBundle>;
  establishSession(userId: string, deviceId: number, bundle: PeerBundle): Promise<void>;
  hasSession(userId: string, deviceId: number): Promise<boolean>;
  /** Takes base64 plaintext; returns an envelope whose body is base64. */
  encrypt(userId: string, deviceId: number, plaintextBase64: string): Promise<SignalEnvelope>;
  /** Returns base64 plaintext. */
  decrypt(userId: string, deviceId: number, type: number, bodyBase64: string): Promise<string>;
  /** Signs base64 bytes with this device's Signal identity key (§3.7 attestation). */
  signWithIdentity(payloadBase64: string): Promise<string>;
  verifyWithIdentity(
    payloadBase64: string,
    signatureBase64: string,
    identityKey: string,
  ): Promise<boolean>;
  /**
   * HPKE-seals base64 plaintext to a published Signal identity public key.
   * Used only as the nearby/offline recovery path when a prepared Double
   * Ratchet session is unavailable and cannot be rebuilt without Internet.
   */
  sealToIdentity(
    plaintextBase64: string,
    identityKey: string,
    info: string,
    associatedDataBase64: string,
  ): Promise<string>;
  /** Opens an HPKE identity-sealed ciphertext with this device's private key. */
  openWithIdentity(
    ciphertextBase64: string,
    info: string,
    associatedDataBase64: string,
  ): Promise<string>;
  wipe(): Promise<void>;
}

export default requireOptionalNativeModule<SplitCircleCryptoNativeModule>('SplitCircleCrypto');
