// PrivacyGuardContext — arms the accelerometer when the hidden guard is
// enabled and trips it on a firm shake. Consumers ask `isShielded(target)`
// and honor `action` ('scramble' renders redacted content, 'vanish' renders
// nothing). expo-sensors is required lazily and guarded: on a binary built
// before the dependency existed the guard simply never arms.

import {
  getGuardSync,
  hydrateGuard,
  onGuardChanged,
  SHAKE_THRESHOLDS,
  updateGuard,
  verifyCode,
  type GuardAction,
  type GuardTargets,
  type PrivacyGuardSettings,
} from '@/services/privacyGuardService';
import { warningHaptic } from '@/utils/haptics';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

type GuardTarget = keyof GuardTargets;

interface PrivacyGuardContextValue {
  settings: PrivacyGuardSettings;
  /** True when `target` (or "everything") is currently hidden. */
  isShielded: (target: Exclude<GuardTarget, 'everything'>) => boolean;
  /** Whole-app lockdown active. */
  fullLock: boolean;
  action: GuardAction;
  trip: () => void;
  unlock: (code: string) => Promise<boolean>;
}

const PrivacyGuardContext = createContext<PrivacyGuardContextValue>({
  settings: getGuardSync(),
  isShielded: () => false,
  fullLock: false,
  action: 'scramble',
  trip: () => {},
  unlock: async () => false,
});

export const usePrivacyGuard = () => useContext(PrivacyGuardContext);

export const PrivacyGuardProvider = ({ children }: { children: React.ReactNode }) => {
  const [settings, setSettings] = useState<PrivacyGuardSettings>(getGuardSync());
  const lastTripRef = useRef(0);

  useEffect(() => {
    void hydrateGuard().then(setSettings);
    return onGuardChanged(() => setSettings({ ...getGuardSync() }));
  }, []);

  // Shake detection — only subscribed while armed and not already tripped.
  useEffect(() => {
    if (!settings.enabled || settings.active || !settings.codeHash) return;

    let subscription: { remove: () => void } | null = null;
    let cancelled = false;

    void (async () => {
      let Accelerometer: typeof import('expo-sensors').Accelerometer;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        Accelerometer = require('expo-sensors').Accelerometer;
      } catch {
        return; // Binary predates expo-sensors — guard can't arm.
      }
      if (cancelled) return;

      Accelerometer.setUpdateInterval(140);
      const threshold = SHAKE_THRESHOLDS[settings.sensitivity];
      subscription = Accelerometer.addListener(({ x, y, z }) => {
        const magnitude = Math.sqrt(x * x + y * y + z * z);
        if (magnitude < threshold) return;
        const now = Date.now();
        if (now - lastTripRef.current < 1800) return; // debounce
        lastTripRef.current = now;
        warningHaptic();
        void updateGuard({ active: true });
      });
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [settings.enabled, settings.active, settings.codeHash, settings.sensitivity]);

  const value = useMemo<PrivacyGuardContextValue>(() => {
    // `enabled` arms the SHAKE listener only; `active` raises the shields no
    // matter how they were tripped (shake or the manual Activate button).
    // A code must exist so there is always a way back out.
    const active = settings.active && Boolean(settings.codeHash);
    return {
      settings,
      action: settings.action,
      fullLock: active && settings.targets.everything,
      isShielded: (target) =>
        active && (settings.targets.everything || settings.targets[target]),
      trip: () => void updateGuard({ active: true }),
      unlock: async (code: string) => {
        const ok = await verifyCode(code);
        if (ok) await updateGuard({ active: false });
        return ok;
      },
    };
  }, [settings]);

  return <PrivacyGuardContext.Provider value={value}>{children}</PrivacyGuardContext.Provider>;
};
