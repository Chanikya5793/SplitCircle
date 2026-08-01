/**
 * Sealed gap-fill batches (ai_layer/docs/34 §3.1/§3.2 — step 4).
 *
 * The transport half of `syncBatchFormat.ts`. That module decides WHAT a batch
 * contains and whether one is honest; this one seals it, signs it, moves it and
 * verifies it. Split so the security-relevant invariants stay testable without
 * a device.
 *
 * Replaces per-message replay (M messages × D devices of encryptions, RTDB
 * writes and function invocations) with ONE sealed payload per (chat,
 * requester).
 *
 * WHY BOTH SEAL AND SIGN. HPKE gives confidentiality but NOT sender
 * authenticity — anyone holding the requester's published identity key can seal
 * to it, and gap requests are readable in RTDB. Without a signature a third
 * party could answer a request with fabricated history that decrypts perfectly.
 * The seal decides who can READ it; the signature decides whose history it IS.
 */
import { getDatabase, onChildAdded, ref, remove, set } from 'firebase/database';
import type { ChatMessage } from '@/models';
import {
  isBatchForRequest,
  packSyncBatch,
  parseSyncBatchBody,
  type SyncBatchBody,
} from '@/services/syncBatchFormat';
import { listSignalDevices } from '@/services/signalCryptoService';
import {
  isCryptoAvailable,
  openWithIdentity,
  sealToIdentity,
  signWithIdentity,
  verifyWithIdentity,
} from '../../modules/splitcircle-crypto';

const rtdb = getDatabase();

const BATCH_ROOT = 'syncGapBatches';

/**
 * HPKE info string. Distinct from the mesh envelope's, so a batch can never be
 * opened as a chat envelope or vice versa even if one were replayed into the
 * wrong path — domain separation is free here and expensive to retrofit.
 */
const SYNC_BATCH_HPKE_INFO = 'splitcircle/sync-batch/v1';

/**
 * `btoa`/`atob`, NOT `Buffer` — React Native has no Buffer without a polyfill,
 * and this repo does not ship one. A Buffer version typechecks, passes every
 * unit test under Node, and then throws on device. Matches
 * `meshMessageProtocol`'s implementation exactly, because the two encode the
 * same bytes for the same crypto.
 */
const encodeUtf8Base64 = (value: string): string =>
  globalThis.btoa(unescape(encodeURIComponent(value)));
const decodeBase64Utf8 = (value: string): string =>
  decodeURIComponent(escape(globalThis.atob(value)));

interface SealedBatch {
  v: 1;
  /** Device that produced this batch, so the requester knows whose key to check. */
  responderDeviceId: string;
  /** HPKE-sealed batch body. */
  b: string;
  /** Signature over `b`, by the responder's identity key. */
  sig: string;
}

const batchPath = (userId: string, requesterDeviceId: string, batchId: string): string =>
  `${BATCH_ROOT}/${userId}/${requesterDeviceId}/${batchId}`;

/**
 * Packs, seals and publishes one batch for a requesting device.
 *
 * Returns how many messages were sent, or 0 when there was nothing to send or
 * the requester has no usable identity key — 0 must leave the request
 * outstanding, exactly like the per-message path, so another device can still
 * serve it.
 */
export const sendSyncBatch = async (
  ownerUserId: string,
  responderDeviceId: string,
  request: { chatId: string; sinceTimestamp: number; requesterDeviceId: string },
  messages: readonly ChatMessage[],
): Promise<number> => {
  // No native crypto means nothing can be sealed. 0 leaves the request
  // outstanding for a device that can serve it.
  if (!isCryptoAvailable()) return 0;

  const body = packSyncBatch(request.chatId, request.sinceTimestamp, messages);
  if (body.messages.length === 0) return 0;

  const devices = await listSignalDevices(ownerUserId).catch(() => []);
  const requester = devices.find((device) => device.deviceId === request.requesterDeviceId);
  // No published identity key means nothing can be sealed TO this device yet.
  // Untouched work, not done work.
  if (!requester?.identityKey) return 0;

  const plaintext = encodeUtf8Base64(JSON.stringify(body));
  // Associated data binds the ciphertext to the chat and the requesting device,
  // so a batch cannot be lifted intact and replayed into another chat's slot.
  const associatedData = encodeUtf8Base64(
    JSON.stringify({ chatId: body.chatId, requesterDeviceId: request.requesterDeviceId }),
  );

  const sealed = await sealToIdentity(
    plaintext,
    requester.identityKey,
    SYNC_BATCH_HPKE_INFO,
    associatedData,
  );
  const signature = await signWithIdentity(sealed);

  const payload: SealedBatch = {
    v: 1,
    responderDeviceId,
    b: sealed,
    sig: signature,
  };

  // Keyed by chat AND responder: two devices answering the same request write
  // to different slots instead of clobbering each other, and the requester can
  // consume both.
  const batchId = `${body.chatId}__${responderDeviceId}`;
  await set(ref(rtdb, batchPath(ownerUserId, request.requesterDeviceId, batchId)), payload);
  return body.messages.length;
};

/**
 * Listens for batches addressed to this device, verifies them, and hands the
 * caller a batch that is both well-formed and honest.
 *
 * A batch is DISCARDED WHOLE on any failure — bad signature, unopenable,
 * malformed, or not matching the request (doc 34 §3.2). There is no
 * partially-trusted batch: accepting part of one is how a responder quietly
 * omits history.
 */
export const subscribeToSyncBatches = (
  userId: string,
  ownDeviceId: string,
  outstandingRequestFor: (chatId: string) => { chatId: string; sinceTimestamp: number } | null,
  onBatch: (body: SyncBatchBody) => Promise<void>,
): (() => void) => {
  const path = `${BATCH_ROOT}/${userId}/${ownDeviceId}`;

  return onChildAdded(ref(rtdb, path), (snapshot) => {
    void (async () => {
      const key = snapshot.key;
      if (!key) return;
      const raw = snapshot.val() as SealedBatch | null;
      // Consume regardless of outcome: leaving an unopenable batch in place
      // would have it retried on every reconnect forever, and RTDB must never
      // accumulate (CLAUDE.md).
      const consume = () => remove(ref(rtdb, `${path}/${key}`)).catch(() => undefined);

      try {
        if (!raw || raw.v !== 1 || !raw.b || !raw.sig || !raw.responderDeviceId) {
          await consume();
          return;
        }

        const devices = await listSignalDevices(userId).catch(() => []);
        const responder = devices.find((d) => d.deviceId === raw.responderDeviceId);
        if (!responder?.identityKey) {
          // Unknown responder: cannot establish whose history this is. Leave it
          // for a later pass, once the directory has caught up.
          return;
        }

        // AUTHENTICITY FIRST. Verify before opening, so a forged payload is
        // rejected without ever being handed to the crypto that decrypts it.
        const authentic = await verifyWithIdentity(raw.b, raw.sig, responder.identityKey);
        if (!authentic) {
          console.error('⚠️ Sync batch failed signature verification — discarded', {
            responderDeviceId: raw.responderDeviceId,
          });
          await consume();
          return;
        }

        const associatedData = encodeUtf8Base64(
          JSON.stringify({ chatId: key.split('__')[0], requesterDeviceId: ownDeviceId }),
        );
        const plaintext = await openWithIdentity(raw.b, SYNC_BATCH_HPKE_INFO, associatedData);
        const body = parseSyncBatchBody(JSON.parse(decodeBase64Utf8(plaintext)));
        if (!body) {
          await consume();
          return;
        }

        // Must match a request WE actually raised. Otherwise a device could
        // push unsolicited history into this one.
        const request = outstandingRequestFor(body.chatId);
        if (!request || !isBatchForRequest(body, request)) {
          console.error('⚠️ Sync batch did not match an outstanding request — discarded', {
            chatId: body.chatId,
          });
          await consume();
          return;
        }

        await onBatch(body);
        await consume();
      } catch (error) {
        // Never throw into an RTDB listener. Left in place deliberately: a
        // transient failure (crypto busy, storage full) should be retried, and
        // the reaper bounds how long it can linger.
        console.error('⚠️ Sync batch processing failed', error);
      }
    })();
  });
};
