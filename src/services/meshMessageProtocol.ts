/**
 * Signed application protocol carried by SplitCircleMesh.
 *
 * MultipeerConnectivity encrypts each radio link. The Signal identity
 * signature additionally proves that the claimed sender/device is one the
 * recipient learned from Firebase while previously online.
 */
import type { ChatMessage, ChatThread } from '@/models';
import {
  getCachedPeerIdentityKey,
  getPersistedSignalDeviceId,
  listSignalDevices,
} from '@/services/signalCryptoService';
import {
  decryptMessageEnvelope,
  encryptMessageForRecipient,
  type EncryptedFields,
  type StoredEnvelope,
} from '@/services/messageEnvelope';
import {
  isCryptoAvailable,
  openWithIdentity,
  sealToIdentity,
  signWithIdentity,
  verifyWithIdentity,
} from '../../modules/splitcircle-crypto';
import {
  isAllowedMediaMimeType,
  MEDIA_MAX_FILE_SIZE_BYTES,
} from '@/services/mediaPolicy';

import { MAX_MESH_ENVELOPE_BYTES, MAX_MESH_MESSAGE_AGE_MS } from '@/services/mesh/constants';

export const MESH_PROTOCOL_VERSION = 1 as const;
// Imported AND re-exported (a bare `export ... from` creates no local binding
// and this module uses the value itself). Defined in a native-free leaf so
// bleTransport can share it without breaking its device-free tests.
export { MAX_MESH_ENVELOPE_BYTES };
// Imported AND re-exported: a bare `export ... from` creates no local binding,
// and this module uses the value itself. Lives in a native-free leaf module so
// pure consumers (originReseal) can share it without dragging crypto into their
// test collection.
export { MAX_MESH_MESSAGE_AGE_MS };

export interface MeshAttachmentManifest {
  v: 1;
  transferId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  chunkHashes: string[];
  encryptedChunkSizes: number[];
}

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
  encryptedForDevices: Record<string, MeshDeviceEnvelope>;
  attachment?: MeshAttachmentManifest;
}

export interface IdentitySealedMeshEnvelope {
  m: 'identity-hpke';
  b: string;
}

export type MeshDeviceEnvelope = StoredEnvelope | IdentitySealedMeshEnvelope;

const isIdentitySealedMeshEnvelope = (
  envelope: MeshDeviceEnvelope,
): envelope is IdentitySealedMeshEnvelope =>
  'm' in envelope && envelope.m === 'identity-hpke';

export interface SignedMeshEnvelope {
  v: typeof MESH_PROTOCOL_VERSION;
  bodyBase64: string;
  signatureBase64: string;
}

const encodeUtf8Base64 = (value: string): string =>
  globalThis.btoa(unescape(encodeURIComponent(value)));

const decodeUtf8Base64 = (value: string): string =>
  decodeURIComponent(escape(globalThis.atob(value)));

const MESH_IDENTITY_HPKE_INFO = 'ManaSplit nearby identity recovery v1';

/**
 * HPKE associated data is signed as part of the outer body and also bound into
 * the ciphertext. Moving a sealed device copy to another chat, message,
 * origin, recipient installation, or timestamp makes it undecryptable.
 */
const identityEnvelopeAssociatedData = (
  body: Pick<
    MeshMessageBody,
    'message' | 'originUserId' | 'originDeviceId' | 'createdAt'
  >,
  recipientDeviceId: string,
): string => encodeUtf8Base64(JSON.stringify({
  v: MESH_PROTOCOL_VERSION,
  chatId: body.message.chatId,
  messageId: body.message.id,
  originUserId: body.originUserId,
  originDeviceId: body.originDeviceId,
  recipientDeviceId,
  createdAt: body.createdAt,
}));

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

/**
 * Firestore chat snapshots created by older clients did not always keep
 * `participantIds` and the richer `participants` array in lockstep. That is
 * harmless online (the server fan-out has its own recipient list), but it made
 * nearby DMs asymmetric: one phone encrypted to the two ids in
 * `participants`, while the other authorized against a stale one-id
 * `participantIds` array.
 *
 * Treat both cached representations as one logical membership set. Group
 * membership remains exact. Direct chats must resolve to exactly two people,
 * which prevents a corrupt/stale record from broadening the audience.
 */
export const resolveMeshThreadAudience = (
  thread: Pick<ChatThread, 'type' | 'participantIds' | 'participants'>,
): string[] | null => {
  const audience = normalizedAudience([
    ...(Array.isArray(thread.participantIds) ? thread.participantIds : []),
    ...(Array.isArray(thread.participants)
      ? thread.participants.map((participant) => participant?.userId)
      : []),
  ]);
  if (thread.type === 'direct' && audience.length !== 2) return null;
  return audience;
};

export const buildMeshMessageBody = async ({
  message,
  thread,
  originUserId,
  originDeviceId,
  attachment,
  attachmentSecret,
}: {
  message: ChatMessage;
  thread: ChatThread;
  originUserId: string;
  originDeviceId: string;
  attachment?: MeshAttachmentManifest;
  attachmentSecret?: {
    transferId: string;
    keyBase64: string;
    nonceSeedBase64: string;
  };
}): Promise<MeshMessageBody | null> => {
  const audienceUserIds = resolveMeshThreadAudience(thread);
  if (!audienceUserIds || !audienceUserIds.includes(originUserId)) return null;

  // Local paths are meaningful only on the originating sandbox and must never
  // be mistaken for an attachment the receiver can open.
  const transmittedMessage = { ...message };
  delete transmittedMessage.localMediaPath;
  delete transmittedMessage.mediaDownloaded;
  delete transmittedMessage.isFromMe;
  if (transmittedMessage.mediaMetadata?.thumbnailUri) {
    transmittedMessage.mediaMetadata = { ...transmittedMessage.mediaMetadata };
    delete transmittedMessage.mediaMetadata.thumbnailUri;
  }
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
    ...(attachmentSecret ? { nearbyAttachment: attachmentSecret } : {}),
  };
  const createdAt = Date.now();
  const encryptedForDevices: Record<string, MeshDeviceEnvelope> = {};
  for (const recipientId of audienceUserIds) {
    if (recipientId === originUserId) continue;
    let devices = await listSignalDevices(recipientId, 'cache-only').catch(() => []);
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
      // Continue into the stateless identity-sealed recovery below. A broken
      // ratchet must not make an already-known nearby member disappear.
    }

    // A Signal session marked for rebuild cannot claim a fresh prekey while
    // offline. For only those device copies that Signal could not produce,
    // use libsignal's RFC 9180 HPKE against the cached, previously verified
    // identity public key. The signed outer envelope supplies authenticity;
    // HPKE supplies recipient-only confidentiality and metadata binding.
    for (const device of devices) {
      if (
        device.deviceId === originDeviceId
        || encryptedForDevices[device.deviceId]
        || typeof device.identityKey !== 'string'
        || device.identityKey.length === 0
      ) {
        continue;
      }
      try {
        const associatedData = identityEnvelopeAssociatedData({
          message,
          originUserId,
          originDeviceId,
          createdAt,
        }, device.deviceId);
        encryptedForDevices[device.deviceId] = {
          m: 'identity-hpke',
          b: await sealToIdentity(
            encodeUtf8Base64(JSON.stringify(fields)),
            device.identityKey,
            MESH_IDENTITY_HPKE_INFO,
            associatedData,
          ),
        };
      } catch {
        // Fail closed for this device. Other recipient copies and the group's
        // durable cloud relay remain independent.
      }
    }
  }
  if (Object.keys(encryptedForDevices).length === 0) return null;

  return {
    v: MESH_PROTOCOL_VERSION,
    kind: 'chat-message',
    message: transmittedMessage,
    chatType: thread.type,
    ...(thread.groupId ? { groupId: thread.groupId } : {}),
    audienceUserIds,
    originUserId,
    originDeviceId,
    createdAt,
    senderSignalDeviceId,
    encryptedForDevices,
    ...(attachment ? { attachment } : {}),
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
      || body.audienceUserIds.length === 0
      || !body.audienceUserIds.every(
        (userId) => typeof userId === 'string' && userId.length > 0,
      )
      || typeof body.createdAt !== 'number'
      || !Number.isFinite(body.createdAt)
      || typeof body.senderSignalDeviceId !== 'number'
      || !Number.isFinite(body.senderSignalDeviceId)
      || !Number.isInteger(body.senderSignalDeviceId)
      || body.senderSignalDeviceId <= 0
      || !body.encryptedForDevices
      || typeof body.encryptedForDevices !== 'object'
      || Array.isArray(body.encryptedForDevices)
    ) {
      return null;
    }
    if (
      Object.keys(body.encryptedForDevices).length === 0
      || !Object.entries(body.encryptedForDevices).every(([deviceId, candidate]) => {
        if (
          typeof deviceId !== 'string'
          || deviceId.length === 0
          || !candidate
          || typeof candidate !== 'object'
        ) {
          return false;
        }
        const envelope = candidate as unknown as Record<string, unknown>;
        if ('m' in envelope) {
          return envelope.m === 'identity-hpke'
            && typeof envelope.b === 'string'
            && envelope.b.length > 0;
        }
        return typeof envelope.t === 'number'
          && Number.isInteger(envelope.t)
          && typeof envelope.b === 'string'
          && envelope.b.length > 0;
      })
    ) {
      return null;
    }
    if (body.attachment) {
      const attachment = body.attachment as Partial<MeshAttachmentManifest>;
      if (
        attachment.v !== 1
        || typeof attachment.transferId !== 'string'
        || !/^[A-Za-z0-9_-]{1,80}$/.test(attachment.transferId)
        || typeof attachment.fileName !== 'string'
        || attachment.fileName.length < 1
        || attachment.fileName.length > 255
        || typeof attachment.mimeType !== 'string'
        || attachment.mimeType.length < 1
        || attachment.mimeType.length > 128
        || !isAllowedMediaMimeType(attachment.mimeType)
        || typeof attachment.fileSize !== 'number'
        || attachment.fileSize < 0
        || attachment.fileSize > MEDIA_MAX_FILE_SIZE_BYTES
        || typeof attachment.chunkSize !== 'number'
        || attachment.chunkSize < 64 * 1024
        || attachment.chunkSize > 4 * 1024 * 1024
        || !Number.isInteger(attachment.chunkCount)
        || (attachment.chunkCount ?? 0) <= 0
        || (attachment.chunkCount ?? 0) > 1_600
        || !Array.isArray(attachment.chunkHashes)
        || attachment.chunkHashes.length !== attachment.chunkCount
        || !attachment.chunkHashes.every(
          (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash),
        )
        || !Array.isArray(attachment.encryptedChunkSizes)
        || attachment.encryptedChunkSizes.length !== attachment.chunkCount
        || attachment.chunkCount !== Math.max(
          1,
          Math.ceil(attachment.fileSize / attachment.chunkSize),
        )
        || !attachment.encryptedChunkSizes.every((size, index) => {
          if (!Number.isInteger(size)) return false;
          const plaintextSize = index < (attachment.chunkCount ?? 0) - 1
            ? attachment.chunkSize ?? 0
            : Math.max(
                0,
                (attachment.fileSize ?? 0)
                  - ((attachment.chunkCount ?? 1) - 1) * (attachment.chunkSize ?? 0),
              );
          return size === plaintextSize + 16;
        })
      ) {
        return null;
      }
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
  // Firestore materializes an absent optional field as `null` in a number of
  // legacy direct-thread snapshots, while the signed JSON envelope omits it
  // and therefore parses as `undefined`. Comparing those values literally
  // rejected every otherwise-valid nearby DM. Group identity is strict;
  // direct chats require only that neither side claims a group.
  if (thread.type === 'group') {
    if (
      typeof thread.groupId !== 'string'
      || thread.groupId.length === 0
      || body.groupId !== thread.groupId
    ) {
      return false;
    }
  } else if (body.groupId != null || thread.groupId != null) {
    return false;
  }
  if (body.message.senderId !== body.originUserId) return false;
  const expectedAudience = resolveMeshThreadAudience(thread);
  if (!expectedAudience) return false;
  if (!expectedAudience.includes(body.originUserId)) return false;
  if (!expectedAudience.includes(currentUserId)) return false;
  if (!body.audienceUserIds.includes(currentUserId)) return false;
  if (now - body.createdAt > MAX_MESH_MESSAGE_AGE_MS || body.createdAt > now + 60_000) return false;

  const receivedAudience = normalizedAudience(body.audienceUserIds);
  return expectedAudience.length === receivedAudience.length
    && expectedAudience.every((id, index) => id === receivedAudience[index]);
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

const decryptMeshFieldsForDevice = async (
  body: MeshMessageBody,
  currentDeviceId: string,
): Promise<EncryptedFields | null> => {
  const envelope = body.encryptedForDevices[currentDeviceId];
  if (!envelope) return null;
  if (isIdentitySealedMeshEnvelope(envelope)) {
    try {
      const plaintextBase64 = await openWithIdentity(
        envelope.b,
        MESH_IDENTITY_HPKE_INFO,
        identityEnvelopeAssociatedData(body, currentDeviceId),
      );
      return JSON.parse(decodeUtf8Base64(plaintextBase64)) as EncryptedFields;
    } catch {
      return null;
    }
  }
  return decryptMessageEnvelope(
    body.originUserId,
    body.senderSignalDeviceId,
    envelope,
  );
};

const messageWithDecryptedFields = (
  body: MeshMessageBody,
  decrypted: EncryptedFields,
): ChatMessage => ({
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
});

export const decryptMeshBodyForDevice = async (
  body: MeshMessageBody,
  currentDeviceId: string,
): Promise<ChatMessage | null> => {
  const decrypted = await decryptMeshFieldsForDevice(body, currentDeviceId);
  if (!decrypted) return null;
  return messageWithDecryptedFields(body, decrypted);
};

export interface DecryptedMeshPayload {
  message: ChatMessage;
  attachment?: {
    manifest: MeshAttachmentManifest;
    secret: {
      transferId: string;
      keyBase64: string;
      nonceSeedBase64: string;
    };
  };
}

export const decryptMeshPayloadForDevice = async (
  body: MeshMessageBody,
  currentDeviceId: string,
): Promise<DecryptedMeshPayload | null> => {
  const decrypted = await decryptMeshFieldsForDevice(body, currentDeviceId);
  if (!decrypted) return null;
  const message = messageWithDecryptedFields(body, decrypted);
  if (!body.attachment) return { message };
  if (
    !decrypted.nearbyAttachment
    || decrypted.nearbyAttachment.transferId !== body.attachment.transferId
  ) {
    return null;
  }
  return {
    message,
    attachment: {
      manifest: body.attachment,
      secret: decrypted.nearbyAttachment,
    },
  };
};
