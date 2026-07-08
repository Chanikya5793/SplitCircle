/**
 * screenCaptureGuard.ts — crash-safe wrapper around expo-screen-capture.
 *
 * Two jobs for the privacy guard:
 *   • detect when the user takes a SCREENSHOT (so we can trip the guard), and
 *   • ask iOS to BLUR the app in screen recordings while armed.
 *
 * iOS can't truly block a screenshot after the fact — the OS captures the
 * frame before JS ever hears about it — so screenshot handling is reactive
 * (hide going forward), while recording prevention is proactive (the frames
 * come out blank). The native module is probed with requireOptionalNative
 * Module first: a binary built before the dependency existed would otherwise
 * SIGSEGV in release Hermes at module-init (same gotcha as expo-sensors).
 */

type ScreenCaptureModule = typeof import('expo-screen-capture');

let cachedModule: ScreenCaptureModule | null | undefined;

const loadModule = (): ScreenCaptureModule | null => {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireOptionalNativeModule } = require('expo-modules-core');
    if (!requireOptionalNativeModule('ExpoScreenCapture')) {
      cachedModule = null;
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedModule = require('expo-screen-capture') ?? null;
  } catch {
    cachedModule = null;
  }
  return cachedModule ?? null;
};

export const isScreenCaptureAvailable = (): boolean => loadModule() !== null;

/**
 * Subscribe to screenshot events. Returns an unsubscribe function (a no-op if
 * the module isn't present, so callers never need to null-check).
 */
export const subscribeScreenshot = (onScreenshot: () => void): (() => void) => {
  const mod = loadModule();
  if (!mod) return () => {};
  try {
    const sub = mod.addScreenshotListener(() => onScreenshot());
    return () => {
      try {
        sub.remove();
      } catch {
        // already gone
      }
    };
  } catch {
    return () => {};
  }
};

/** Turn recording/app-switcher blur on or off. Safe to call repeatedly. */
export const setScreenCaptureBlocked = async (blocked: boolean): Promise<void> => {
  const mod = loadModule();
  if (!mod) return;
  try {
    if (blocked) await mod.preventScreenCaptureAsync('privacy-guard');
    else await mod.allowScreenCaptureAsync('privacy-guard');
  } catch {
    // best-effort
  }
};
