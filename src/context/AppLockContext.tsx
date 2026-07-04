// AppLockContext — whole-app biometric lock (WhatsApp "App Lock").
//
// When enabled, the app is locked on cold start and re-locked after it has
// been in the background longer than the chosen auto-lock delay. While locked,
// AppLockGate renders a full-screen unlock panel; nothing behind it is
// interactive. Unlock requires Face ID / Touch ID (with device-passcode
// fallback so the user can never be permanently locked out).

import {
  getAppLockSync,
  hydrateAppLock,
  onAppLockChanged,
  type AppLockSettings,
} from '@/services/appLockService';
import { authenticate, isBiometricAvailable } from '@/services/biometrics';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

interface AppLockContextValue {
  settings: AppLockSettings;
  locked: boolean;
  /** Prompt biometrics; unlocks on success. Returns success. */
  unlock: () => Promise<boolean>;
}

const AppLockContext = createContext<AppLockContextValue>({
  settings: getAppLockSync(),
  locked: false,
  unlock: async () => false,
});

export const useAppLock = () => useContext(AppLockContext);

export const AppLockProvider = ({ children }: { children: React.ReactNode }) => {
  const [settings, setSettings] = useState<AppLockSettings>(getAppLockSync());
  const [hydrated, setHydrated] = useState(false);
  // Start locked if enabled — resolved once hydration finishes below.
  const [locked, setLocked] = useState(false);
  const backgroundedAtRef = useRef<number | null>(null);
  const unlockingRef = useRef(false);

  useEffect(() => {
    void hydrateAppLock().then((s) => {
      setSettings(s);
      setLocked(s.enabled); // lock on cold start when enabled
      setHydrated(true);
    });
    return onAppLockChanged(() => setSettings({ ...getAppLockSync() }));
  }, []);

  // Track background time; re-lock when returning past the auto-lock delay.
  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      const current = getAppLockSync();
      if (!current.enabled) return;
      if (state === 'background' || state === 'inactive') {
        if (backgroundedAtRef.current === null) backgroundedAtRef.current = Date.now();
      } else if (state === 'active') {
        const since = backgroundedAtRef.current;
        backgroundedAtRef.current = null;
        if (since !== null && Date.now() - since >= current.autoLockMs) {
          setLocked(true);
        }
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  // When the feature is turned off in Settings, clear any active lock.
  useEffect(() => {
    if (hydrated && !settings.enabled) setLocked(false);
  }, [settings.enabled, hydrated]);

  const unlock = async (): Promise<boolean> => {
    if (unlockingRef.current) return false;
    unlockingRef.current = true;
    try {
      // If biometrics somehow aren't available, don't trap the user.
      const available = await isBiometricAvailable();
      if (!available) {
        setLocked(false);
        return true;
      }
      const ok = await authenticate('Unlock SplitCircle', true);
      if (ok) setLocked(false);
      return ok;
    } finally {
      unlockingRef.current = false;
    }
  };

  const value = useMemo<AppLockContextValue>(
    () => ({ settings, locked: hydrated && settings.enabled && locked, unlock }),
    [settings, hydrated, locked],
  );

  return <AppLockContext.Provider value={value}>{children}</AppLockContext.Provider>;
};
