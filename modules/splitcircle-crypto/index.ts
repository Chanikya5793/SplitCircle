/**
 * splitcircle-crypto — E2E message encryption via libsignal (doc 31 §3.3).
 *
 * Phase 3 gate-2 spike only: `spikeGenerateIdentityKeyPair` exists purely to
 * prove LibSignalClient links and a real libsignal call executes on-device,
 * inside this repo's New-Architecture + STATIC-framework build. Not a real
 * API surface yet — real per-device identity/session/store logic replaces
 * this once the spike is verified on a real build. Nothing calls it yet:
 * linkage is verified, runtime execution is not (doc 31 §5 Phase 3).
 */

import NativeModule from './src/SplitCircleCryptoModule';

export async function spikeGenerateIdentityKeyPair(): Promise<string> {
  if (!NativeModule) {
    throw new Error('SplitCircleCrypto native module is not available on this platform/build');
  }
  return NativeModule.spikeGenerateIdentityKeyPair();
}
