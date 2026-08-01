/**
 * LAN transport native bridge (ai_layer/docs/33 Phase 5).
 *
 * mDNS/Bonjour discovery plus a length-prefixed TCP stream. The fast nearby
 * link when two devices share a network; BLE remains the universal floor that
 * works with no infrastructure at all.
 *
 * WIRE CONTRACT — both native halves must agree, and this is all of it:
 *
 *     4-byte BIG-ENDIAN unsigned length, then that many UTF-8 bytes.
 *
 * Framing lives natively rather than in shared TypeScript (unlike BLE's
 * chunking) because TCP is a stream and the layer that owns the socket buffer
 * is the only one that can see message boundaries. JS receives whole frames.
 *
 * iOS needs `NSLocalNetworkUsageDescription` and `_manasplit-mesh._tcp` under
 * `NSBonjourServices` — both already present. Without the Bonjour entry iOS
 * returns no results at all, which is indistinguishable from an empty network.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

import type { NativeLanModule, NativeLanPeer } from '@/services/mesh/lanTransport';

interface FrameEvent {
  peerDeviceId: string;
  frame: string;
}

interface PeersEvent {
  peers: NativeLanPeer[];
}

interface NativeModuleShape {
  isAvailable(): boolean;
  start(deviceId: string, trustedDeviceIds: string[]): Promise<boolean>;
  stop(): void;
  updateTrust(trustedDeviceIds: string[]): void;
  connectedPeers(): NativeLanPeer[];
  sendFrame(peerDeviceId: string, frame: string): Promise<boolean>;
  addListener(event: string, listener: (payload: never) => void): { remove(): void };
}

/**
 * PROBED, never `require`d directly. Hermes SIGSEGVs — it does not throw — when
 * a package whose native half is missing is imported (CLAUDE.md), which is the
 * state of every JS-only jsbundle hot-swap.
 */
const Native = requireOptionalNativeModule<NativeModuleShape>('SplitCircleLan');

export const isLanNativeAvailable = (): boolean => Native != null;

/**
 * Adapter onto the `NativeLanModule` contract `lanTransport.ts` consumes.
 *
 * Every method degrades to "unavailable" rather than throwing: LAN is one
 * transport among several and the switch routes around a dead one.
 */
export const nativeLan: NativeLanModule = {
  isAvailable: () => {
    if (!Native) return false;
    try {
      return Native.isAvailable();
    } catch {
      return false;
    }
  },

  start: async ({ deviceId, trustedDeviceIds }) => {
    if (!Native) return false;
    try {
      return await Native.start(deviceId, trustedDeviceIds);
    } catch {
      // iOS local-network permission denial arrives here. An ordinary state.
      return false;
    }
  },

  stop: () => {
    try {
      Native?.stop();
    } catch {
      // Teardown must never throw.
    }
  },

  updateTrust: (trustedDeviceIds) => {
    try {
      Native?.updateTrust(trustedDeviceIds);
    } catch {
      // Re-sent by the next threads change.
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

  sendFrame: async (peerDeviceId, frame) => {
    if (!Native) return false;
    try {
      return await Native.sendFrame(peerDeviceId, frame);
    } catch {
      // Resolving false, never throwing, is what lets the transport count the
      // peer undelivered and the router store-and-forward.
      return false;
    }
  },

  addFrameListener: (cb) => {
    if (!Native) return () => undefined;
    const subscription = Native.addListener('onFrame', (payload: never) => {
      const event = payload as unknown as FrameEvent;
      cb(event.peerDeviceId, event.frame);
    });
    return () => subscription.remove();
  },

  addPeersChangedListener: (cb) => {
    if (!Native) return () => undefined;
    const subscription = Native.addListener('onPeersChanged', (payload: never) => {
      const event = payload as unknown as PeersEvent;
      cb(event.peers ?? []);
    });
    return () => subscription.remove();
  },
};
