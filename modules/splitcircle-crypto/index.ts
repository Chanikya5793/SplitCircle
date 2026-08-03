/**
 * splitcircle-crypto — per-device Signal sessions via libsignal (doc 31 §3.3).
 *
 * Every export throws if the native module is missing rather than silently
 * degrading: a "quietly unencrypted" fallback is the one failure mode this
 * module must never have. Callers decide how to surface that (§3.3's plaintext
 * scope is explicit and bounded; silently widening it is not an option).
 *
 * Verified on a physical iPhone 17 Pro 2026-07-25 that the libsignal toolchain
 * links and executes (doc 31 §5 Phase 3, gates 1+2).
 */

import NativeModule, {
  type PeerBundle,
  type PublishableBundle,
  type SignalEnvelope,
} from './src/SplitCircleCryptoModule';

export type { PeerBundle, PublishableBundle, SignalEnvelope };

/** True when this build can do E2E crypto at all (iOS with the pod linked). */
export function isCryptoAvailable(): boolean {
  return NativeModule != null;
}

function requireModule(): NonNullable<typeof NativeModule> {
  if (!NativeModule) {
    throw new Error('SplitCircleCrypto native module is not available on this platform/build');
  }
  return NativeModule;
}

/**
 * Creates this device's Signal identity if absent and records who we are.
 * Idempotent — safe on every app start. Minting a second identity would
 * invalidate every session peers already hold, so this must never be
 * "reset" casually.
 */
export function bootstrapSignalIdentity(
  userId: string,
  signalDeviceId: number,
): Promise<{ registrationId: number; identityKey: string; deviceId: number }> {
  return requireModule().bootstrap(userId, signalDeviceId);
}

export function hasSignalIdentity(): Promise<boolean> {
  return requireModule().hasIdentity();
}

/** Public prekey material to publish at `users/{uid}/signalPrekeys/{deviceId}`. */
export function generatePublishableBundle(oneTimeCount = 100): Promise<PublishableBundle> {
  return requireModule().generatePublishableBundle(oneTimeCount);
}

export function establishSession(
  userId: string,
  signalDeviceId: number,
  bundle: PeerBundle,
): Promise<void> {
  return requireModule().establishSession(userId, signalDeviceId, bundle);
}

export function hasSession(userId: string, signalDeviceId: number): Promise<boolean> {
  return requireModule().hasSession(userId, signalDeviceId);
}

export function encryptForDevice(
  userId: string,
  signalDeviceId: number,
  plaintextBase64: string,
): Promise<SignalEnvelope> {
  return requireModule().encrypt(userId, signalDeviceId, plaintextBase64);
}

export function decryptFromDevice(
  userId: string,
  signalDeviceId: number,
  envelope: SignalEnvelope,
): Promise<string> {
  return requireModule().decrypt(userId, signalDeviceId, envelope.type, envelope.body);
}

/**
 * Signs bytes with this device's Signal identity key — the trust anchor for
 * §3.7's retirement attestation. A device claiming its backup is complete must
 * prove it is the device peers already know, not just something able to write
 * to the user's CloudKit container.
 */
export function signWithIdentity(payloadBase64: string): Promise<string> {
  return requireModule().signWithIdentity(payloadBase64);
}

export function verifyWithIdentity(
  payloadBase64: string,
  signatureBase64: string,
  identityKey: string,
): Promise<boolean> {
  return requireModule().verifyWithIdentity(payloadBase64, signatureBase64, identityKey);
}

/**
 * Recovery encryption for offline nearby delivery when the peer's prepared
 * Signal ratchet is unavailable. Libsignal's RFC 9180 HPKE implementation
 * encrypts directly to the already-published device identity public key.
 */
export function sealToIdentity(
  plaintextBase64: string,
  identityKey: string,
  info: string,
  associatedDataBase64: string,
): Promise<string> {
  return requireModule().sealToIdentity(
    plaintextBase64,
    identityKey,
    info,
    associatedDataBase64,
  );
}

export function openWithIdentity(
  ciphertextBase64: string,
  info: string,
  associatedDataBase64: string,
): Promise<string> {
  return requireModule().openWithIdentity(
    ciphertextBase64,
    info,
    associatedDataBase64,
  );
}

/**
 * Destroys all Signal state on this device (revocation §3.7, account deletion
 * doc 28). Stale sessions would otherwise keep decrypting a revoked peer's
 * ciphertext.
 */
export function wipeSignalState(): Promise<void> {
  return requireModule().wipe();
}

/**
 * Publishes the installation id into the iOS App Group, for the Notification
 * Service Extension (ai_layer/docs/36 §4).
 *
 * The extension needs it to rebuild a preview's associated data
 * (`{chatId, deviceId}`) — the binding that stops a blob sealed for one device
 * opening on another.
 *
 * iOS-only and best-effort: Android decrypts previews in the app's own
 * background task and needs nothing shared. Returns false rather than throwing
 * when the native half or the App Group is absent, because a build without the
 * entitlement must keep working — just with generic notifications.
 */
export function publishInstallationId(installationId: string): boolean {
  const native = requireModule() as { publishInstallationId?: (id: string) => boolean };
  if (typeof native.publishInstallationId !== 'function') return false;
  try {
    return native.publishInstallationId(installationId);
  } catch {
    return false;
  }
}
