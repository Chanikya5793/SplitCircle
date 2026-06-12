/**
 * splitcircle-ai — On-device AI helpers.
 *
 * iOS: NSDataDetector-backed PII redaction + Siri/Spotlight donation (Swift).
 * Elsewhere: pure JS redaction fallback; donation is a no-op.
 */

import NativeModule, {
  type OnDeviceAiAvailability,
  type OnDeviceAskResult,
} from './src/SplitCircleAIModule';
import { redactPIIFallback } from './src/redactFallback';

/**
 * Redact emails/phone numbers from free text BEFORE it leaves the device
 * (AI queries, notes sent to the AI layer). Native NSDataDetector on iOS,
 * regex fallback elsewhere. Never throws — falls back on any native error.
 */
export function redactPII(text: string): string {
  if (!text) return text;
  if (NativeModule) {
    try {
      return NativeModule.redactPII(text);
    } catch {
      // fall through to the JS fallback
    }
  }
  return redactPIIFallback(text);
}

/**
 * Donate the "Ask SplitCircle" activity to iOS (Spotlight / Siri Suggestions).
 * No-op off-iOS; fire-and-forget (never rejects into the caller's flow).
 */
export async function donateAskActivity(query?: string): Promise<void> {
  if (!NativeModule) return;
  try {
    await NativeModule.donateAskActivity(query ?? null);
  } catch {
    // Donation is best-effort; never break the ask flow over it.
  }
}

/**
 * Availability of the on-device Apple Foundation Models LLM (Apple
 * Intelligence). "unsupportedOS" covers non-iOS platforms, iOS < 26, and
 * builds without the native module.
 */
export function getOnDeviceAiAvailability(): OnDeviceAiAvailability {
  if (!NativeModule?.getOnDeviceAiAvailability) return 'unsupportedOS';
  try {
    return NativeModule.getOnDeviceAiAvailability();
  } catch {
    return 'unsupportedOS';
  }
}

/**
 * Ask the on-device model a question grounded in pre-built numbered expense
 * context. Throws when unavailable — callers should check
 * `getOnDeviceAiAvailability()` first and fall back / explain.
 */
export async function askOnDevice(question: string, context: string): Promise<OnDeviceAskResult> {
  if (!NativeModule?.askOnDevice) {
    throw new Error('On-device AI is not available on this platform.');
  }
  return NativeModule.askOnDevice(question, context);
}

export { redactPIIFallback };
export type { OnDeviceAiAvailability, OnDeviceAskResult };
