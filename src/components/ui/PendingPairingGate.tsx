// Blocks the app while THIS device's pairing is pending_confirmation (doc 31
// §3.4 point 6) — a device that has signed in but is not yet trusted must not
// see account data, and must be told why.
//
// It no longer renders a waiting panel itself: DeviceSetupChoice does, because
// "waiting" turned out to be only one of the answers. This file's remaining
// job is deciding WHEN the gate applies, and handling revocation while it is
// up. Mirrors AppLockGate's mounting pattern (App.tsx, absolute sibling of
// AppNavigator).

import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import {
  getCurrentDeviceId,
  revokeDevice,
  subscribeToOwnPairedDevice,
  type PairedDevice,
} from '@/services/pairingService';
import { DeviceSetupChoice } from '@/components/ui/DeviceSetupChoice';
import { resetHandoffState } from '@/services/deviceSyncCoordinator';
import { errorHaptic } from '@/utils/haptics';
import { wipeSignalState } from '../../../modules/splitcircle-crypto';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

export const PendingPairingGate = () => {
  const { user, signOutUser } = useAuth();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [ownRecord, setOwnRecord] = useState<PairedDevice | null | undefined>(undefined);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getCurrentDeviceId().then((id) => {
      if (!cancelled) setDeviceId(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user || !deviceId) {
      setOwnRecord(undefined);
      return;
    }

    return subscribeToOwnPairedDevice(user.userId, deviceId, (device) => {
      setOwnRecord(device);
    });
  }, [user, deviceId]);

  const isPending = ownRecord?.pairingStatus === 'pending_confirmation';
  // A record that existed and is now GONE means denied/revoked — sign out.
  // `ownRecord === null` alone is NOT sufficient evidence of that: on a fresh
  // sign-in the pairedDevices row doesn't exist yet (it's created
  // asynchronously by syncNotificationDeviceRecord), so the subscription's
  // first emission is legitimately null and treating it as a denial signed
  // brand-new devices straight back out. Only a null that FOLLOWS a record we
  // actually saw is a revocation.
  const [everSawRecord, setEverSawRecord] = useState(false);
  useEffect(() => {
    if (ownRecord) setEverSawRecord(true);
  }, [ownRecord]);
  const wasDeniedOrRevoked = ownRecord === null && deviceId !== null && everSawRecord;

  useEffect(() => {
    if (!wasDeniedOrRevoked || signingOut) return;
    setSigningOut(true);
    errorHaptic();
    // Destroy this device's Signal identity and sessions before signing out
    // (doc 31 §3.7). Revocation means this device is no longer trusted: the
    // server has already deleted its published prekeys, and leaving the
    // identity + session state on disk would let a re-registration silently
    // reuse a revoked identity, and keep already-delivered ciphertext
    // decryptable on a device the owner deliberately cut off.
    //
    // Deliberately NOT done on ordinary sign-out: the identity is what peers'
    // existing sessions are built against, so wiping on every sign-out would
    // break every peer session until each re-handshakes — and during that
    // window their messages would fail to decrypt.
    void wipeSignalState()
      // Handoff bookkeeping goes with the identity. Without this, a device
      // that is revoked and later re-paired stays in the main device's
      // "already handed off" set and silently receives no history at all.
      .then(() => resetHandoffState())
      .catch(() => {
        // Best-effort: never block the sign-out that removes access.
      })
      .finally(() => {
        void signOutUser().finally(() => setSigningOut(false));
      });
  }, [wasDeniedOrRevoked, signingOut]);

  if (!isPending) {
    return null;
  }

  const expiresAt = ownRecord?.confirmationExpiresAt ?? null;
  const expired = typeof expiresAt === 'number' && Date.now() > expiresAt;

  /**
   * The fork REPLACES the old waiting panel outright.
   *
   * Previously this rendered "waiting for confirmation" with a Cancel button,
   * which asked the user to go and approve from a device they may not have,
   * and offered no other route. Recovery was reachable only through a
   * secondary button framed as an escape hatch. Now the choice — new phone or
   * extra device — IS the screen, and the approval spinner is just one branch
   * of it, so nobody is ever parked with nothing to do.
   */
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="auto">
      <LiquidBackground>
        <DeviceSetupChoice
          confirmationCode={expired ? null : (ownRecord?.confirmationCode ?? null)}
          waitingForApproval={!expired}
          onCancel={() => {
            if (deviceId) void revokeDevice(deviceId).catch(() => {});
            setSigningOut(true);
            void signOutUser().finally(() => setSigningOut(false));
          }}
          onBecameMain={() => {
            // Nothing to navigate: the pairedDevices subscription sees this
            // device flip to confirmed main and the gate unmounts itself.
          }}
        />
      </LiquidBackground>
    </View>
  );
};

const styles = StyleSheet.create({});
