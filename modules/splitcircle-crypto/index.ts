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
 * Destroys all Signal state on this device (revocation §3.7, account deletion
 * doc 28). Stale sessions would otherwise keep decrypting a revoked peer's
 * ciphertext.
 */
export function wipeSignalState(): Promise<void> {
  return requireModule().wipe();
}
