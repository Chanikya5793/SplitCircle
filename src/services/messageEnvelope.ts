/**
 * Message-level E2E envelope encoding (doc 31 §3.3, Phase 3).
 *
 * Bridges the chat message shape and `signalCryptoService`'s per-device
 * primitives. §3.3 scopes exactly which fields are private — `content`, the
 * `replyTo` snippet that quotes it, and `location` — and which stay plaintext
 * (chatId, senderId, timestamp, type, delivery bookkeeping, expenseRef). Those
 * private fields are bundled into one JSON payload and encrypted as a unit, so
 * a single Signal session per device covers all of them.
 */

import {
  encryptForAllDevices,
  decryptEnvelope,
  getCachedSignalDeviceId,
  listSignalDevices,
  markSessionForRebuild,
  type SignalNetworkPolicy,
} from '@/services/signalCryptoService';
import { isCryptoAvailable, type SignalEnvelope } from '../../modules/splitcircle-crypto';

/** The private half of a message — everything §3.3 says must not sit in transit. */
export interface EncryptedFields {
  content?: string;
  replyToContent?: string;
  location?: { latitude: number; longitude: number; address?: string } | null;
}

/** One recipient device's ciphertext, plus what the receiver needs to address the session. */
export interface StoredEnvelope {
  /** libsignal message type — the receiver MUST dispatch on it. */
  t: number;
  /** base64 ciphertext. */
  b: string;
}

export interface EncryptedMessageParts {
  envelopes: Record<string, StoredEnvelope>;
  senderSignalDeviceId: number;
}

export type RecipientCoveragePolicy = 'all-devices' | 'available-devices';

// base64 without pulling in a polyfill: RN provides global btoa/atob via
// react-native-get-random-values' environment, but encoding UTF-8 through it
// mangles non-ASCII, so go via percent-encoding.
const toBase64 = (input: string): string =>
  // eslint-disable-next-line no-undef
  globalThis.btoa(unescape(encodeURIComponent(input)));

const fromBase64 = (input: string): string =>
  // eslint-disable-next-line no-undef
  decodeURIComponent(escape(globalThis.atob(input)));

/** Thrown when a recipient HAS encryption keys but we could not encrypt for all of their devices. */
export class EncryptionRequiredError extends Error {
  constructor(recipientId: string, covered: number, total: number) {
    super(
      `Could not encrypt for all of ${recipientId}'s devices (${covered}/${total}). ` +
        'Refusing to send this message unencrypted.',
    );
    this.name = 'EncryptionRequiredError';
  }
}

/**
 * Encrypts a message's private fields for every device of `recipientId`.
 *
 * Returns null — meaning "send plaintext" — ONLY when the recipient has no
 * published keys at all (a client that predates E2E), or crypto is unavailable
 * on this device. That is the sole remaining downgrade path and it exists
 * purely so messaging to not-yet-upgraded accounts keeps working.
 *
 * THROWS `EncryptionRequiredError` when the recipient demonstrably HAS keys but
 * we could not encrypt for every device. That case used to fall back to
 * plaintext too, which was a downgrade vector: anyone able to make one device's
 * key material unavailable could force the whole message into the clear. A
 * visible send failure is the correct outcome — silently weakening the
 * guarantee is not.
 */
export const encryptMessageForRecipient = async (
  recipientId: string,
  fields: EncryptedFields,
  excludeDeviceId?: string,
  networkPolicy: SignalNetworkPolicy = 'network-preferred',
  coveragePolicy: RecipientCoveragePolicy = 'all-devices',
): Promise<EncryptedMessageParts | null> => {
  if (!isCryptoAvailable()) return null;

  const senderSignalDeviceId = getCachedSignalDeviceId();
  // Without our own libsignal address the recipient cannot name the session to
  // decrypt against, so there is nothing safe to send.
  if (!senderSignalDeviceId) return null;

  const devices = (await listSignalDevices(recipientId, networkPolicy)).filter(
    (device) => device.deviceId !== excludeDeviceId,
  );
  // Zero devices is legitimate for a SELF fan-out (this is the account's only
  // device), and means there is simply nothing to send — distinct from "we
  // could not encrypt", which is why callers check for an empty envelope map.
  if (devices.length === 0) return null;

  const plaintext = toBase64(JSON.stringify(fields));
  const results = await encryptForAllDevices(
    recipientId,
    plaintext,
    excludeDeviceId,
    networkPolicy,
  );

  // Strict equality, not >= 1: partial coverage means at least one device
  // would receive nothing it can open. The recipient HAS keys here, so this is
  // a genuine failure, not a reason to downgrade — see the doc comment.
  if (coveragePolicy === 'all-devices' && results.length !== devices.length) {
    throw new EncryptionRequiredError(recipientId, results.length, devices.length);
  }
  if (results.length === 0) return null;

  const envelopes: Record<string, StoredEnvelope> = {};
  for (const result of results) {
    envelopes[result.deviceId] = { t: result.envelope.type, b: result.envelope.body };
  }

  return { envelopes, senderSignalDeviceId };
};

/**
 * Decrypts an envelope delivered to this device. Returns null when the message
 * isn't encrypted or can't be opened; callers fall back to whatever plaintext
 * the payload carried rather than dropping the message entirely.
 */
/** Reason the most recent decrypt failed, surfaced in the placeholder so a
 *  broken session is diagnosable from the phone instead of by guesswork. */
let lastDecryptError: string | null = null;

export const isDuplicateSignalMessageError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const coded = error as { code?: unknown; name?: unknown; message?: unknown };
  return coded.code === 'DuplicateSignalMessage'
    || coded.name === 'DuplicateSignalMessage'
    // Defensive compatibility for Expo bridge versions that prefix native
    // exception names in the rendered JS message instead of preserving code.
    || (
      typeof coded.message === 'string'
      && coded.message.includes('DuplicateSignalMessage')
    );
};

export const consumeLastDecryptError = (): string | null => {
  const value = lastDecryptError;
  lastDecryptError = null;
  return value;
};

export const decryptMessageEnvelope = async (
  senderId: string,
  senderSignalDeviceId: number,
  envelope: StoredEnvelope,
): Promise<EncryptedFields | null> => {
  if (!isCryptoAvailable()) return null;

  try {
    const signalEnvelope: SignalEnvelope = { type: envelope.t, body: envelope.b };
    const plaintextBase64 = await decryptEnvelope(senderId, senderSignalDeviceId, signalEnvelope);
    return JSON.parse(fromBase64(plaintextBase64)) as EncryptedFields;
  } catch (error) {
    // A failed decrypt is expected in real deployments (a peer that reinstalled
    // has a new identity, so old sessions are dead) and must never take the
    // listener down — the message is surfaced with whatever plaintext exists.
    console.warn('Failed to decrypt message envelope', error);
    // Most failures are ground truth that the session needs repair. A
    // duplicated ciphertext is the exception: gossip/retry can legitimately
    // replay a packet after it was consumed, and libsignal explicitly reports
    // that condition without implying the live session is damaged.
    lastDecryptError = error instanceof Error ? error.message : String(error);
    if (!isDuplicateSignalMessageError(error)) {
      void markSessionForRebuild(senderId, senderSignalDeviceId).catch(() => {});
    }
    return null;
  }
};
