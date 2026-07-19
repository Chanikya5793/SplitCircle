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
  attemptUnlock,
  type GuardAction,
  type GuardTargets,
  type PrivacyGuardSettings,
} from '@/services/privacyGuardService';
import { successHaptic, warningHaptic } from '@/utils/haptics';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Settings } from 'react-native';
import { GuardCodePad } from '@/components/ui/GuardCodePad';
import { authenticate, isBiometricAvailable } from '@/services/biometrics';
import { setScreenCaptureBlocked, subscribeScreenshot } from '@/services/screenCaptureGuard';

type GuardTarget = keyof GuardTargets;

interface PrivacyGuardContextValue {
  settings: PrivacyGuardSettings;
  /**
   * True when `target` (or "everything") is currently hidden. Pass the
   * entity id (groupId for expenses, chatId for chats) to honor the
   * user's All / Only-selected / All-except scope configuration.
   * Stays TRUE in the duress decoy world — field-level masking keeps
   * applying there (with forced convincing styles).
   */
  isShielded: (target: Exclude<GuardTarget, 'everything'>, entityId?: string) => boolean;
  /**
   * Whole-screen lock panels / opaque overlays (GuardedScreen, ChatRoom
   * overlay). FALSE in duress — a visible lock panel would betray the fake
   * unlock, so duress renders content whose fields are masked instead.
   */
  isLockedDown: (target: Exclude<GuardTarget, 'everything'>, entityId?: string) => boolean;
  /**
   * The entity's row must be removed entirely from lists, search, and badges
   * — no masked placeholder row advertising that something is hidden.
   * True for subset scopes (Only these / All except) while shielded, and for
   * EVERY shielded chat in duress (a visible fake chat with an empty room
   * behind it would be inconsistent).
   */
  isVanished: (target: Exclude<GuardTarget, 'everything'>, entityId?: string) => boolean;
  /** Shields are up in any form, including duress — for global effects like wallpaper hiding. */
  active: boolean;
  /** The duress decoy world is live: app looks unlocked, data is fake/absent. */
  duress: boolean;
  /** Whole-app lockdown active (never in duress). */
  fullLock: boolean;
  action: GuardAction;
  trip: () => void;
  /**
   * Attempt an unlock with brute-force lockout. ok=true also covers a DURESS
   * entry (the decoy world engages silently) — callers must not distinguish.
   */
  unlock: (code: string) => Promise<{ ok: boolean; lockedForMs: number }>;
}

const PrivacyGuardContext = createContext<PrivacyGuardContextValue>({
  settings: getGuardSync(),
  isShielded: () => false,
  isLockedDown: () => false,
  isVanished: () => false,
  active: false,
  duress: false,
  fullLock: false,
  action: 'scramble',
  trip: () => {},
  unlock: async () => ({ ok: false, lockedForMs: 0 }),
});

export const usePrivacyGuard = () => useContext(PrivacyGuardContext);

export const PrivacyGuardProvider = ({ children }: { children: React.ReactNode }) => {
  const [settings, setSettings] = useState<PrivacyGuardSettings>(getGuardSync());
  const lastTripRef = useRef(0);
  const promptingRef = useRef(false);
  const faceDownSamplesRef = useRef(0);
  // Shake-to-reveal keypad (rendered by the provider so the imperative shake
  // listener can raise proper UI instead of a system alert).
  const [revealPadVisible, setRevealPadVisible] = useState(false);

  useEffect(() => {
    void hydrateGuard().then(setSettings);
    return onGuardChanged(() => setSettings({ ...getGuardSync() }));
  }, []);

  // Mirror the "armed" state to NSUserDefaults so the native SceneDelegate can
  // blur the app-switcher snapshot before iOS captures it (see AppDelegate.swift).
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const armed = settings.enabled && Boolean(settings.codeHash);
    Settings.set({ PrivacyGuardEnabled: armed ? 1 : 0 });
  }, [settings.enabled, settings.codeHash]);

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
        // Flip-to-hide: the phone resting face-down (screen to the table)
        // reads z ≈ +1g with negligible x/y on expo-sensors' iOS convention.
        // ~5 consecutive quiet samples (~0.7s) trip the shields silently.
        const current0 = getGuardSync();
        if (current0.flipToHide && !current0.active) {
          const faceDown = z > 0.82 && Math.abs(x) < 0.25 && Math.abs(y) < 0.25;
          faceDownSamplesRef.current = faceDown ? faceDownSamplesRef.current + 1 : 0;
          if (faceDownSamplesRef.current >= 5) {
            faceDownSamplesRef.current = 0;
            lastTripRef.current = Date.now();
            warningHaptic();
            void updateGuard({ active: true, duressActive: false });
            return;
          }
        } else {
          faceDownSamplesRef.current = 0;
        }

        const magnitude = Math.sqrt(x * x + y * y + z * z);
        if (magnitude < threshold) return;
        const now = Date.now();
        if (now - lastTripRef.current < 1800) return; // debounce
        lastTripRef.current = now;

        // Read fresh state (the listener isn't re-created on every trip).
        const current = getGuardSync();
        if (!current.active || current.duressActive) {
          // Idle → trip. Also lets a shake re-raise FULL shields from the
          // duress decoy world (it never reveals anything real).
          warningHaptic();
          void updateGuard({ active: true, duressActive: false });
          return;
        }
        // Already tripped → shake to reveal. Biometrics first if enabled,
        // then fall back to the secret code so there's always a way out.
        if (promptingRef.current) return;
        promptingRef.current = true;
        warningHaptic();
        void (async () => {
          if (current.biometricUnlock && (await isBiometricAvailable())) {
            const ok = await authenticate('Reveal hidden content');
            if (ok) {
              promptingRef.current = false;
              successHaptic();
              void updateGuard({ active: false, duressActive: false });
              return;
            }
          }
          setRevealPadVisible(true);
        })();
      });
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [settings.enabled, settings.codeHash, settings.sensitivity]);

  // Auto re-hide (1Password-style auto-lock): after a REVEAL — an observed
  // active→false transition while armed — the shields raise themselves again
  // once the timeout elapses. Arming alone never starts the timer, and any
  // settings change that re-runs this effect restarts the countdown.
  const wasActiveRef = useRef(settings.active);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = settings.active;
    if (!settings.enabled || !settings.codeHash || settings.revealTimeoutMs <= 0) return;
    if (settings.active || !wasActive) return; // only a fresh reveal arms the timer
    const t = setTimeout(() => {
      warningHaptic();
      void updateGuard({ active: true, duressActive: false });
    }, settings.revealTimeoutMs);
    return () => clearTimeout(t);
  }, [settings.active, settings.enabled, settings.codeHash, settings.revealTimeoutMs]);

  // Optional lock-on-exit: trip the guard whenever the app leaves the
  // foreground (Face-ID-style behavior, but with the secret code).
  useEffect(() => {
    if (!settings.enabled || !settings.rearmOnBackground || !settings.codeHash) return;
    const sub = AppState.addEventListener('change', (state) => {
      // Backgrounding also exits any duress decoy world — like every app
      // lock, it re-locks on return.
      if (state === 'background') void updateGuard({ active: true, duressActive: false });
    });
    return () => sub.remove();
  }, [settings.enabled, settings.rearmOnBackground, settings.codeHash]);

  // Screenshot → trip. iOS reports the screenshot only after the frame is
  // already captured, so this hides everything going FORWARD (the taken shot
  // still shows what was on screen — unavoidable at the OS level).
  useEffect(() => {
    if (!settings.enabled || !settings.codeHash || !settings.hideOnScreenshot) return;
    return subscribeScreenshot(() => {
      if (!getGuardSync().active) {
        warningHaptic();
        void updateGuard({ active: true });
      }
    });
  }, [settings.enabled, settings.codeHash, settings.hideOnScreenshot]);

  // Blur the app in screen recordings while the shields are up.
  useEffect(() => {
    const active = settings.active && Boolean(settings.codeHash);
    void setScreenCaptureBlocked(active && settings.blockScreenRecording);
  }, [settings.active, settings.codeHash, settings.blockScreenRecording]);

  const value = useMemo<PrivacyGuardContextValue>(() => {
    // `enabled` arms the SHAKE listener only; `active` raises the shields no
    // matter how they were tripped (shake or the manual Activate button).
    // A code must exist so there is always a way back out.
    const active = settings.active && Boolean(settings.codeHash);
    const duress = active && settings.duressActive;

    const isShielded = (target: Exclude<GuardTarget, 'everything'>, entityId?: string) => {
      if (!active) return false;
      if (settings.targets.everything) return true;
      if (!settings.targets[target]) return false;
      if (target === 'expenses' || target === 'charts') return inScope(settings.groupScope, entityId);
      if (target === 'chats') return inScope(settings.chatScope, entityId);
      return true;
    };

    const isVanished = (target: Exclude<GuardTarget, 'everything'>, entityId?: string) => {
      if (!entityId || !isShielded(target, entityId)) return false;
      if (target === 'chats') {
        // Duress: every shielded chat vanishes — a visible fake chat whose
        // room is empty would give the game away on the first tap.
        if (duress) return true;
        return settings.chatScope.mode !== 'all';
      }
      if (target === 'expenses' || target === 'charts') {
        return settings.groupScope.mode !== 'all';
      }
      return false; // calls/friends disguise inline, never vanish
    };

    return {
      settings,
      action: settings.action,
      active,
      duress,
      fullLock: active && !duress && settings.targets.everything,
      isShielded,
      isLockedDown: (target, entityId) => !duress && isShielded(target, entityId),
      isVanished,
      trip: () => void updateGuard({ active: true, duressActive: false }),
      unlock: async (code: string) => {
        const { ok, duress: isDuress, lockedForMs } = await attemptUnlock(code);
        if (ok) {
          await updateGuard({ active: false, duressActive: false });
          return { ok: true, lockedForMs: 0 };
        }
        if (isDuress) {
          // Fake unlock: shields stay up but the app enters the decoy world
          // — lock panels drop, sensitive rows vanish, fakes render.
          await updateGuard({ duressActive: true });
          return { ok: true, lockedForMs: 0 };
        }
        return { ok: false, lockedForMs };
      },
    };
  }, [settings]);

  return (
    <PrivacyGuardContext.Provider value={value}>
      {children}
      <GuardCodePad
        visible={revealPadVisible}
        title="Enter code"
        subtitle="Shake detected — enter your code to reveal."
        mode="unlock"
        onClose={() => {
          promptingRef.current = false;
          setRevealPadVisible(false);
        }}
        onSubmit={async (code) => {
          const { ok, duress: isDuress, lockedForMs } = await attemptUnlock(code);
          if (ok) {
            promptingRef.current = false;
            void updateGuard({ active: false, duressActive: false });
            return { status: 'ok' };
          }
          if (isDuress) {
            // Fake unlock: identical success path from the outside, but the
            // app enters the DECOY world instead of revealing anything.
            promptingRef.current = false;
            void updateGuard({ duressActive: true });
            return { status: 'ok' };
          }
          if (lockedForMs > 0) return { status: 'locked', lockedForMs };
          return { status: 'wrong' };
        }}
      />
    </PrivacyGuardContext.Provider>
  );
};
