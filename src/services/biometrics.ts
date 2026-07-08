/**
 * biometrics.ts — thin, crash-safe wrapper around expo-local-authentication.
 *
 * The native module is loaded lazily and probed first (requireOptionalNative
 * Module): a binary built before expo-local-authentication was added would
 * otherwise SIGSEGV in release Hermes at module-init time, exactly like the
 * expo-sensors gotcha. Every function degrades gracefully to "unavailable".
 */

let cachedModule: typeof import('expo-local-authentication') | null | undefined;

const loadModule = (): typeof import('expo-local-authentication') | null => {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireOptionalNativeModule } = require('expo-modules-core');
    if (!requireOptionalNativeModule('ExpoLocalAuthentication')) {
      cachedModule = null;
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedModule = require('expo-local-authentication') ?? null;
  } catch {
    cachedModule = null;
  }
  return cachedModule ?? null;
};

export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'none';

/** Hardware present AND a biometric is enrolled. */
export const isBiometricAvailable = async (): Promise<boolean> => {
  const mod = loadModule();
  if (!mod) return false;
  try {
    const [hasHardware, enrolled] = await Promise.all([mod.hasHardwareAsync(), mod.isEnrolledAsync()]);
    return hasHardware && enrolled;
  } catch {
    return false;
  }
};

/** Best-effort label for the enrolled biometric ("Face ID" / "Touch ID"). */
export const biometricLabel = async (): Promise<string> => {
  const mod = loadModule();
  if (!mod) return 'Biometrics';
  try {
    const types = await mod.supportedAuthenticationTypesAsync();
    if (types.includes(mod.AuthenticationType.FACIAL_RECOGNITION)) return 'Face ID';
    if (types.includes(mod.AuthenticationType.FINGERPRINT)) return 'Touch ID';
    return 'Biometrics';
  } catch {
    return 'Biometrics';
  }
};

/**
 * Prompt for biometric auth. Returns true on success. `allowDeviceFallback`
 * lets the OS offer the device passcode (used by the whole-app lock so the
 * user is never permanently locked out if biometrics fail).
 */
export const authenticate = async (
  promptMessage: string,
  allowDeviceFallback = false,
): Promise<boolean> => {
  const mod = loadModule();
  if (!mod) return false;
  try {
    const result = await mod.authenticateAsync({
      promptMessage,
      disableDeviceFallback: !allowDeviceFallback,
      cancelLabel: 'Cancel',
    });
    return result.success;
  } catch {
    return false;
  }
};
