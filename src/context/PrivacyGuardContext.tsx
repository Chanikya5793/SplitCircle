// PrivacyGuardContext — arms the accelerometer when the hidden guard is
// enabled and trips it on a firm shake. Consumers ask `isShielded(target)`
// and honor `action` ('scramble' renders redacted content, 'vanish' renders
// nothing). expo-sensors is required lazily and guarded: on a binary built
// before the dependency existed the guard simply never arms.

import {
  getGuardSync,
  hydrateGuard,
  inScope,
  onGuardChanged,
  SHAKE_THRESHOLDS,
  updateGuard,
  verifyCode,
  type GuardAction,
  type GuardTargets,
  type PrivacyGuardSettings,
} from '@/services/privacyGuardService';
import { errorHaptic, successHaptic, warningHaptic } from '@/utils/haptics';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';

type GuardTarget = keyof GuardTargets;

interface PrivacyGuardContextValue {
  settings: PrivacyGuardSettings;
  /**
   * True when `target` (or "everything") is currently hidden. Pass the
   * entity id (groupId for expenses, chatId for chats) to honor the
   * user's All / Only-selected / All-except scope configuration.
   */
  isShielded: (target: Exclude<GuardTarget, 'everything'>, entityId?: string) => boolean;
  /** Shields are up (tripped) — for global effects like wallpaper/profile hiding. */
  active: boolean;
  /** Whole-app lockdown active. */
  fullLock: boolean;
  action: GuardAction;
  trip: () => void;
  unlock: (code: string) => Promise<boolean>;
}

const PrivacyGuardContext = createContext<PrivacyGuardContextValue>({
  settings: getGuardSync(),
  isShielded: () => false,
  active: false,
  fullLock: false,
  action: 'scramble',
  trip: () => {},
  unlock: async () => false,
});

export const usePrivacyGuard = () => useContext(PrivacyGuardContext);

export const PrivacyGuardProvider = ({ children }: { children: React.ReactNode }) => {
  const [settings, setSettings] = useState<PrivacyGuardSettings>(getGuardSync());
  const lastTripRef = useRef(0);
  const promptingRef = useRef(false);

  useEffect(() => {
    void hydrateGuard().then(setSettings);
    return onGuardChanged(() => setSettings({ ...getGuardSync() }));
  }, []);

  // Shake detection — subscribed whenever the guard is armed WITH a code,
  // regardless of active state, so the SAME gesture both hides (when idle)
  // and offers to reveal (when tripped). This is the primary deactivation
  // path: shake again → enter code → shields drop.
  useEffect(() => {
    if (!settings.enabled || !settings.codeHash) return;

    let subscription: { remove: () => void } | null = null;
    let cancelled = false;

    void (async () => {
      // Probe for the NATIVE module before evaluating expo-sensors' JS:
      // requireNativeModule throws during module initialization when the
      // binary predates the dependency, and a throw at that point segfaults
      // release Hermes (observed SIGSEGV in DictPropertyMap::lookupEntryFor)
      // — a try/catch around the require is NOT sufficient.
      let Accelerometer: typeof import('expo-sensors').Accelerometer;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { requireOptionalNativeModule } = require('expo-modules-core');
        if (!requireOptionalNativeModule('ExponentAccelerometer')) {
          return; // Binary predates expo-sensors — guard can't arm.
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        Accelerometer = require('expo-sensors').Accelerometer;
      } catch {
        return;
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

        // Read fresh state (the listener isn't re-created on every trip).
        const current = getGuardSync();
        if (!current.active) {
          warningHaptic();
          void updateGuard({ active: true });
          return;
        }
        // Already tripped → shake to reveal: prompt for the code.
        if (promptingRef.current) return;
        promptingRef.current = true;
        warningHaptic();
        Alert.prompt(
          'Enter code',
          'Shake detected — enter your code to reveal.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => { promptingRef.current = false; } },
            {
              text: 'Reveal',
              onPress: (code?: string) => {
                void verifyCode(code ?? '').then((ok) => {
                  promptingRef.current = false;
                  if (ok) {
                    successHaptic();
                    void updateGuard({ active: false });
                  } else {
                    errorHaptic();
                  }
                });
              },
            },
          ],
          'secure-text',
        );
      });
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [settings.enabled, settings.codeHash, settings.sensitivity]);

  // Optional lock-on-exit: trip the guard whenever the app leaves the
  // foreground (Face-ID-style behavior, but with the secret code).
  useEffect(() => {
    if (!settings.enabled || !settings.rearmOnBackground || !settings.codeHash) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') void updateGuard({ active: true });
    });
    return () => sub.remove();
  }, [settings.enabled, settings.rearmOnBackground, settings.codeHash]);

  const value = useMemo<PrivacyGuardContextValue>(() => {
    // `enabled` arms the SHAKE listener only; `active` raises the shields no
    // matter how they were tripped (shake or the manual Activate button).
    // A code must exist so there is always a way back out.
    const active = settings.active && Boolean(settings.codeHash);
    return {
      settings,
      action: settings.action,
      active,
      fullLock: active && settings.targets.everything,
      isShielded: (target, entityId) => {
        if (!active) return false;
        if (settings.targets.everything) return true;
        if (!settings.targets[target]) return false;
        if (target === 'expenses' || target === 'charts') return inScope(settings.groupScope, entityId);
        if (target === 'chats') return inScope(settings.chatScope, entityId);
        return true;
      },
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
