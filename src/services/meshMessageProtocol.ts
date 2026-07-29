/**
 * Signed application protocol carried by SplitCircleMesh.
 *
 * MultipeerConnectivity encrypts each radio link. The Signal identity
 * signature additionally proves that the claimed sender/device is one the
 * recipient learned from Firebase while previously online.
 */
import type { ChatMessage, ChatThread } from '@/models';
import { getCachedPeerIdentityKey } from '@/services/signalCryptoService';
import {
  decryptMessageEnvelope,
  encryptMessageForRecipient,
  type EncryptedFields,
  type StoredEnvelope,
} from '@/services/messageEnvelope';
import { getPersistedSignalDeviceId } from '@/services/signalCryptoService';
import {
  isCryptoAvailable,
  signWithIdentity,
  verifyWithIdentity,
} from '../../modules/splitcircle-crypto';

export const MESH_PROTOCOL_VERSION = 1 as const;
export const MAX_MESH_ENVELOPE_BYTES = 256 * 1024;
export const MAX_MESH_MESSAGE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface MeshMessageBody {
  v: typeof MESH_PROTOCOL_VERSION;
  kind: 'chat-message';
  message: ChatMessage;
  chatType: ChatThread['type'];
  groupId?: string;
  audienceUserIds: string[];
  originUserId: string;
  originDeviceId: string;
  createdAt: number;
  senderSignalDeviceId: number;
  encryptedForDevices: Record<string, StoredEnvelope>;
}

export interface SignedMeshEnvelope {
  v: typeof MESH_PROTOCOL_VERSION;
  bodyBase64: string;
  signatureBase64: string;
}

const encodeUtf8Base64 = (value: string): string =>
  globalThis.btoa(unescape(encodeURIComponent(value)));

const decodeUtf8Base64 = (value: string): string =>
  decodeURIComponent(escape(globalThis.atob(value)));

/**
 * Hermes does not guarantee the Web TextEncoder global. Keep envelope-size
 * validation runtime-native by counting UTF-8 bytes directly, including
 * surrogate pairs and replacement bytes for malformed lone surrogates.
 */
export const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      // Three bytes covers BMP characters, low surrogates without a leading
      // high surrogate, and the replacement-character behavior of TextEncoder.
      bytes += 3;
    }
  }
  return bytes;
};

const normalizedAudience = (ids: readonly string[]): string[] =>
  [...new Set(ids.filter(Boolean))].sort();

export const buildMeshMessageBody = async ({
  message,
  thread,
  originUserId,
  originDeviceId,
}: {
  message: ChatMessage;
  thread: ChatThread;
  originUserId: string;
  originDeviceId: string;
}): Promise<MeshMessageBody | null> => {
  // Local paths are meaningful only on the originating sandbox and must never
  // be mistaken for an attachment the receiver can open.
  const transmittedMessage = { ...message };
  delete transmittedMessage.localMediaPath;
  delete transmittedMessage.isFromMe;
  transmittedMessage.content = '';
  if (transmittedMessage.replyTo) {
    transmittedMessage.replyTo = { ...transmittedMessage.replyTo, content: '' };
  }
  delete transmittedMessage.location;

  const senderSignalDeviceId = await getPersistedSignalDeviceId();
  if (!senderSignalDeviceId) return null;

  const fields: EncryptedFields = {
    content: message.content,
    replyToContent: message.replyTo?.content,
    location: message.location,
  };
  const encryptedForDevices: Record<string, StoredEnvelope> = {};
  for (const recipientId of normalizedAudience(thread.participantIds)) {
    if (recipientId === originUserId) continue;
    try {
      // Nearby delivery must never wait for Firestore or a Cloud Function.
      // Public device metadata and Signal sessions are prepared while online;
      // a missing cache/session fails this recipient immediately and visibly.
      const encrypted = await encryptMessageForRecipient(
        recipientId,
        fields,
        // Installation ids are intended to be globally unique. If this exact
        // phone still appears under a different account after an old sign-out,
        // that cloud record is stale — encrypting to it creates a self-address
        // collision and can make strict all-device coverage fail. Never target
        // the originating installation, regardless of which cached user
        // directory contained it.
        originDeviceId,
        'cache-only',
        // Nearby is an opportunistic per-device route. A stale or unprepared
        // sibling phone must not prevent another present phone with a healthy
        // session from receiving. Every included copy remains Signal
        // encrypted; the normal cloud path retains strict all-device coverage.
        'available-devices',
      );
      if (encrypted) Object.assign(encryptedForDevices, encrypted.envelopes);
    } catch {
      // Other eligible group members still receive the message. The durable
      // group cloud relay retries the normal all-device delivery once online.
    }
  }
  if (Object.keys(encryptedForDevices).length === 0) return null;

  return {
    v: MESH_PROTOCOL_VERSION,
    kind: 'chat-message',
    message: transmittedMessage,
    chatType: thread.type,
    ...(thread.groupId ? { groupId: thread.groupId } : {}),
    audienceUserIds: normalizedAudience(thread.participantIds),
    originUserId,
    originDeviceId,
    createdAt: Date.now(),
    senderSignalDeviceId,
    encryptedForDevices,
  };
};

export const signMeshMessageBody = async (
  body: MeshMessageBody,
): Promise<string> => {
  if (!isCryptoAvailable()) {
    throw new Error('Secure nearby messaging is unavailable in this build.');
  }
  const bodyBase64 = encodeUtf8Base64(JSON.stringify(body));
  const signatureBase64 = await signWithIdentity(bodyBase64);
  return JSON.stringify({
    v: MESH_PROTOCOL_VERSION,
    bodyBase64,
    signatureBase64,
  } satisfies SignedMeshEnvelope);
};

export const parseSignedMeshEnvelope = (
  raw: string,
): { envelope: SignedMeshEnvelope; body: MeshMessageBody } | null => {
  if (utf8ByteLength(raw) > MAX_MESH_ENVELOPE_BYTES) return null;
  try {
    const envelope = JSON.parse(raw) as Partial<SignedMeshEnvelope>;
    if (
      envelope.v !== MESH_PROTOCOL_VERSION
      || typeof envelope.bodyBase64 !== 'string'
      || typeof envelope.signatureBase64 !== 'string'
    ) {
      return null;
    }
    const body = JSON.parse(decodeUtf8Base64(envelope.bodyBase64)) as Partial<MeshMessageBody>;
    if (
      body.v !== MESH_PROTOCOL_VERSION
      || body.kind !== 'chat-message'
      || !body.message
      || typeof body.message.id !== 'string'
      || typeof body.message.chatId !== 'string'
      || typeof body.originUserId !== 'string'
      || typeof body.originDeviceId !== 'string'
      || !Array.isArray(body.audienceUserIds)
      || typeof body.createdAt !== 'number'
      || !Number.isFinite(body.senderSignalDeviceId)
      || !body.encryptedForDevices
      || typeof body.encryptedForDevices !== 'object'
    ) {
      return null;
    }
    return {
      envelope: envelope as SignedMeshEnvelope,
      body: body as MeshMessageBody,
    };
  } catch {
    return null;
  }
};

export const isMeshBodyAuthorizedForThread = (
  body: MeshMessageBody,
  thread: ChatThread,
  currentUserId: string,
  now = Date.now(),
): boolean => {
  if (body.message.chatId !== thread.chatId) return false;
  if (body.chatType !== thread.type) return false;
  if (body.groupId !== thread.groupId) return false;
  if (body.message.senderId !== body.originUserId) return false;
  if (!thread.participantIds.includes(body.originUserId)) return false;
  if (!thread.participantIds.includes(currentUserId)) return false;
  if (!body.audienceUserIds.includes(currentUserId)) return false;
  if (now - body.createdAt > MAX_MESH_MESSAGE_AGE_MS || body.createdAt > now + 60_000) return false;

  const expectedAudience = normalizedAudience(thread.participantIds);
  return expectedAudience.length === body.audienceUserIds.length
    && expectedAudience.every((id, index) => id === normalizedAudience(body.audienceUserIds)[index]);
};

export const verifyMeshEnvelopeForThread = async (
  raw: string,
  thread: ChatThread,
  currentUserId: string,
): Promise<MeshMessageBody | null> => {
  const parsed = parseSignedMeshEnvelope(raw);
  if (!parsed || !isMeshBodyAuthorizedForThread(parsed.body, thread, currentUserId)) {
    return null;
  }
  const identityKey = await getCachedPeerIdentityKey(
    parsed.body.originUserId,
    parsed.body.originDeviceId,
  );
  if (!identityKey || !isCryptoAvailable()) return null;

  const verified = await verifyWithIdentity(
    parsed.envelope.bodyBase64,
    parsed.envelope.signatureBase64,
    identityKey,
  ).catch(() => false);
  return verified ? parsed.body : null;
};

export const decryptMeshBodyForDevice = async (
  body: MeshMessageBody,
  currentDeviceId: string,
): Promise<ChatMessage | null> => {
  const envelope = body.encryptedForDevices[currentDeviceId];
  if (!envelope) return null;
  const decrypted = await decryptMessageEnvelope(
    body.originUserId,
    body.senderSignalDeviceId,
    envelope,
  );
  if (!decrypted) return null;

  return {
    ...body.message,
    content: decrypted.content ?? '',
    ...(body.message.replyTo
      ? {
          replyTo: {
            ...body.message.replyTo,
            content: decrypted.replyToContent ?? '',
          },
        }
      : {}),
    ...(decrypted.location ? { location: decrypted.location } : {}),
  };
};
