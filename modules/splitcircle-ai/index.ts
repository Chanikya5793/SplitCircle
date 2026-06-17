/**
 * splitcircle-ai — On-device AI helpers.
 *
 * iOS: NSDataDetector-backed PII redaction + Siri/Spotlight donation (Swift).
 * Elsewhere: pure JS redaction fallback; donation is a no-op.
 */

import NativeModule, {
  type OnDeviceAiAvailability,
  type OnDeviceAskResult,
  type OnDeviceParsedExpenseRaw,
  type OnDevicePccProbeResult,
  type OnDeviceReceiptItem,
  type OnDeviceReceiptResult,
  type OnDeviceRouterDecisionRaw,
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
 * Token context window of the active on-device model (iOS 26.4+, @backDeployed).
 * Larger on more capable hardware (e.g. iPhone Air / 17 Pro, which auto-select
 * Apple's larger "Core Advanced" on-device model), letting us ground answers in
 * more expenses. Returns 0 when the model/API isn't available; callers should
 * apply their own default budget in that case.
 */
export function getOnDeviceContextSize(): number {
  if (!NativeModule?.getOnDeviceContextSize) return 0;
  try {
    return NativeModule.getOnDeviceContextSize();
  } catch {
    return 0;
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

/**
 * Parse OCR receipt text into structured data fully on-device (Apple Foundation
 * Models). `fewShot` is an optional plain-text block of learned merchant
 * corrections. Throws when the on-device model is unavailable — callers should
 * check `getOnDeviceAiAvailability()` first and fall back to the native parser.
 */
export async function parseReceiptStructured(
  rawText: string,
  fewShot = '',
): Promise<OnDeviceReceiptResult> {
  if (!NativeModule?.parseReceiptStructured) {
    throw new Error('On-device receipt parsing is not available on this platform.');
  }
  return NativeModule.parseReceiptStructured(rawText, fewShot);
}

/**
 * Suggest a single expense category on-device for the given text. The caller
 * must validate the returned string against its canonical category list.
 * Throws when the on-device model is unavailable.
 */
export async function suggestExpenseCategory(text: string): Promise<string> {
  if (!NativeModule?.suggestExpenseCategory) {
    throw new Error('On-device categorization is not available on this platform.');
  }
  return NativeModule.suggestExpenseCategory(text);
}

/**
 * "Understand" pass of the RAG pipeline: turn a free-form question into a
 * structured plan. Throws when the on-device model is unavailable.
 */
export async function planExpenseQuery(question: string, memberNames: string) {
  if (!NativeModule?.planExpenseQuery) {
    throw new Error('On-device query planning is not available on this platform.');
  }
  return NativeModule.planExpenseQuery(question, memberNames);
}

/**
 * Parse a natural-language sentence into an expense draft on-device. The caller
 * maps the returned names back to user ids. Throws when the model is unavailable.
 */
export async function parseExpenseFromText(
  text: string,
  memberNames: string,
  currentUserName: string,
): Promise<OnDeviceParsedExpenseRaw> {
  if (!NativeModule?.parseExpenseFromText) {
    throw new Error('On-device expense parsing is not available on this platform.');
  }
  return NativeModule.parseExpenseFromText(text, memberNames, currentUserName);
}

// ── Pipeline v2 spike wrappers (doc 17 §A0) ─────────────────────────────────

/** S2 — ask grounded in a PERSISTENT per-session transcript for real multi-turn
 * continuity. `sessionId` keys the session (e.g. group id). Throws when unavailable. */
export async function askOnDeviceStateful(
  sessionId: string,
  question: string,
  context: string,
  instructions = '',
): Promise<OnDeviceAskResult> {
  if (!NativeModule?.askOnDeviceStateful) {
    throw new Error('On-device AI is not available on this platform.');
  }
  return NativeModule.askOnDeviceStateful(sessionId, question, context, instructions);
}

/** S2 — clear a session's transcript (pass '' to clear all sessions). No-op off-iOS. */
export function resetOnDeviceSession(sessionId = ''): void {
  if (!NativeModule?.resetOnDeviceSession) return;
  try {
    NativeModule.resetOnDeviceSession(sessionId);
  } catch {
    // best-effort
  }
}

/** S3 — abstaining router over a persistent per-group session. Throws when unavailable. */
export async function routeMessage(
  sessionId: string,
  text: string,
  memberNames: string,
  isoDate: string,
): Promise<OnDeviceRouterDecisionRaw> {
  if (!NativeModule?.routeMessage) {
    throw new Error('On-device routing is not available on this platform.');
  }
  return NativeModule.routeMessage(sessionId, text, memberNames, isoDate);
}

/** S5 — Private Cloud Compute probe (iOS 27). `available` is false until the PCC
 * entitlement is granted; returns a neutral result off-iOS instead of throwing. */
export async function pccProbe(question: string): Promise<OnDevicePccProbeResult> {
  if (!NativeModule?.pccProbe) {
    return { available: false, reason: 'unsupportedOS', answer: '', contextSize: 0 };
  }
  return NativeModule.pccProbe(question);
}

export { redactPIIFallback };
export type {
  OnDeviceAiAvailability,
  OnDeviceAskResult,
  OnDeviceParsedExpenseRaw,
  OnDevicePccProbeResult,
  OnDeviceReceiptItem,
  OnDeviceReceiptResult,
  OnDeviceRouterDecisionRaw,
};
