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

// base64 without pulling in a polyfill: RN provides global btoa/atob via
// react-native-get-random-values' environment, but encoding UTF-8 through it
// mangles non-ASCII, so go via percent-encoding.
const toBase64 = (input: string): string =>
  // eslint-disable-next-line no-undef
  globalThis.btoa(unescape(encodeURIComponent(input)));

const fromBase64 = (input: string): string =>
  // eslint-disable-next-line no-undef
  decodeURIComponent(escape(globalThis.atob(input)));

/**
 * Encrypts a message's private fields for every device of `recipientId`.
 *
 * Returns null — meaning "send plaintext" — when crypto is unavailable, the
 * recipient has published no keys, or ANY device could not be encrypted for.
 * Partial coverage is deliberately treated as failure: a device that receives
 * no envelope it can open would silently lose the message.
 */
export const encryptMessageForRecipient = async (
  recipientId: string,
  fields: EncryptedFields,
): Promise<EncryptedMessageParts | null> => {
  if (!isCryptoAvailable()) return null;

  const senderSignalDeviceId = getCachedSignalDeviceId();
  // Without our own libsignal address the recipient cannot name the session to
  // decrypt against, so there is nothing safe to send.
  if (!senderSignalDeviceId) return null;

  const devices = await listSignalDevices(recipientId);
  if (devices.length === 0) return null;

  const plaintext = toBase64(JSON.stringify(fields));
  const results = await encryptForAllDevices(recipientId, plaintext);

  // Strict equality, not >= 1: see the all-or-nothing note above.
  if (results.length !== devices.length) return null;

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
    return null;
  }
};
