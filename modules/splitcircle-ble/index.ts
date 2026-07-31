/**
 * BLE transport native bridge (ai_layer/docs/33 Phase 3).
 *
 * The only link that exists on BOTH platforms with no infrastructure:
 * MultipeerConnectivity cannot reach Android at all (doc 33 §0), and LAN needs
 * a shared network. This module is deliberately THIN — it connects to trusted
 * peers and moves opaque chunk strings. Fragmentation, reassembly, ordering
 * and bounds all live in `src/services/mesh/bleFraming.ts`, in one tested
 * TypeScript implementation, so the Swift and Kotlin halves cannot drift on
 * header layout — a class of bug that only appears between an iPhone and a
 * Pixel, on real radios, and looks like corruption rather than a mismatch.
 *
 * WIRE CONTRACT — both native halves must agree, byte for byte:
 *
 *   Service        5C1E0001-5B1E-4A7F-9C3D-6F9B8E2A1C3D
 *   Chunk char     5C1E0002-5B1E-4A7F-9C3D-6F9B8E2A1C3D  (write + notify)
 *   Identity char  5C1E0003-5B1E-4A7F-9C3D-6F9B8E2A1C3D  (read)
 *
 * Every device runs BOTH roles at once — peripheral (advertise + GATT server)
 * and central (scan + connect) — because a mesh has no clients or servers.
 * To stop two devices opening two redundant links to each other, the one whose
 * deviceId sorts LOWER connects as central; the higher one only advertises and
 * waits. Deterministic, needs no negotiation, and both sides compute it from
 * data they already have.
 *
 * A BLE advertisement has ~31 bytes and cannot carry a 36-char device UUID, so
 * discovery advertises the service plus a short prefix, and the full id is READ
 * from the identity characteristic after connecting. The trust allowlist is
 * applied at that point — an untrusted peer is disconnected before any chunk is
 * accepted. The prefix is a discovery hint only, never an identity claim.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

import type { NativeBleModule, NativeBlePeer } from '@/services/mesh/bleTransport';

/** Shared with both native halves; exported so tests and docs cite one source. */
export const BLE_SERVICE_UUID = '5C1E0001-5B1E-4A7F-9C3D-6F9B8E2A1C3D';
export const BLE_CHUNK_CHARACTERISTIC_UUID = '5C1E0002-5B1E-4A7F-9C3D-6F9B8E2A1C3D';
export const BLE_IDENTITY_CHARACTERISTIC_UUID = '5C1E0003-5B1E-4A7F-9C3D-6F9B8E2A1C3D';

interface ChunkEvent {
  peerDeviceId: string;
  chunk: string;
}

interface PeersEvent {
  peers: NativeBlePeer[];
}

interface NativeModuleShape {
  isAvailable(): boolean;
  start(deviceId: string, trustedDeviceIds: string[]): Promise<boolean>;
  stop(): void;
  updateTrust(trustedDeviceIds: string[]): void;
  connectedPeers(): NativeBlePeer[];
  sendChunk(peerDeviceId: string, chunk: string): Promise<boolean>;
  addListener(event: string, listener: (payload: never) => void): { remove(): void };
}

/**
 * PROBED, never `require`d directly. Hermes SIGSEGVs — it does not throw — when
 * a package whose native half is missing is imported (CLAUDE.md), and this
 * module is genuinely absent until a build carries it, which is exactly the
 * state every JS-only jsbundle hot-swap is in.
 */
const Native = requireOptionalNativeModule<NativeModuleShape>('SplitCircleBle');

/** True when a build actually carries the native half. */
export const isBleNativeAvailable = (): boolean => Native != null;

/**
 * Adapter onto the `NativeBleModule` contract `bleTransport.ts` consumes.
 *
 * Every method degrades to "unavailable" rather than throwing when the native
 * half is missing: BLE is one transport among several, and the switch is
 * expected to route around a dead one, not crash.
 */
export const nativeBle: NativeBleModule = {
  isAvailable: () => {
    if (!Native) return false;
    try {
      return Native.isAvailable();
    } catch {
      // Radio state is queried synchronously on both platforms and can throw
      // while Bluetooth is resetting.
      return false;
    }
  },

  start: async ({ deviceId, trustedDeviceIds }) => {
    if (!Native) return false;
    try {
      return await Native.start(deviceId, trustedDeviceIds);
    } catch {
      // A permission denial arrives here. It is a normal state, not an error
      // the app should surface as a crash.
      return false;
    }
  },

  stop: () => {
    try {
      Native?.stop();
    } catch {
      // Stopping an already-stopped radio must never throw into teardown.
    }
  },

  updateTrust: (trustedDeviceIds) => {
    try {
      Native?.updateTrust(trustedDeviceIds);
    } catch {
      // Trust refreshes fire on every threads change; a transient failure here
      // is re-sent by the next one.
    }
  },

  connectedPeers: () => {
    if (!Native) return [];
    try {
      return Native.connectedPeers() ?? [];
    } catch {
      return [];
    }
  },

  sendChunk: async (peerDeviceId, chunk) => {
    if (!Native) return false;
    try {
      return await Native.sendChunk(peerDeviceId, chunk);
    } catch {
      // Resolving false (never throwing) is the contract bleTransport relies on
      // to count a peer as undelivered and let the router store-and-forward.
      return false;
    }
  },

  addChunkListener: (cb) => {
    if (!Native) return () => undefined;
    const subscription = Native.addListener(
      'onChunk',
      (payload: never) => {
        const event = payload as unknown as ChunkEvent;
        cb(event.peerDeviceId, event.chunk);
      },
    );
    return () => subscription.remove();
  },

  addPeersChangedListener: (cb) => {
    if (!Native) return () => undefined;
    const subscription = Native.addListener(
      'onPeersChanged',
      (payload: never) => {
        const event = payload as unknown as PeersEvent;
        cb(event.peers ?? []);
      },
    );
    return () => subscription.remove();
  },
};
