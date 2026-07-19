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
  type OnDevicePccAskResult,
  type OnDevicePccProbeResult,
  type OnDeviceReceiptItem,
  type OnDeviceReceiptResult,
  type OnDeviceRouterDecisionRaw,
  type SearchTabEvent,
  type WidgetExpense,
  type WidgetGroupBalance,
  type WidgetSnapshot,
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
 * ALL Foundation Models calls are serialized app-wide through this queue.
 * Two concurrent LanguageModelSession / PCC model constructions race the expo
 * module event plumbing and corrupt the Hermes heap — SIGSEGV inside the VM,
 * seen on-sim during doc 22 (PCC) and on the physical iPhone 17 Pro
 * 2026-07-18 (two askOnDevice calls racing when Group Stats opens). One
 * in-flight model call at a time, enforced at this single choke point; sync
 * availability/context getters stay unqueued.
 */
let fmQueue: Promise<unknown> = Promise.resolve();
function serializeFm<T>(run: () => Promise<T>): Promise<T> {
  const next = fmQueue.then(run, run);
  fmQueue = next.catch(() => undefined);
  return next;
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
  const native = NativeModule;
  if (!native?.askOnDevice) {
    throw new Error('On-device AI is not available on this platform.');
  }
  return serializeFm(() => native.askOnDevice(question, context));
}

/**
 * Free-form on-device generation with caller-supplied instructions — the door
 * for NARRATIVE work (stats insight card, insights chat, titles, summaries).
 * Unlike `askOnDevice` there is no Q&A persona, no empty "Expenses:" scaffold,
 * and no citation struct fighting the caller's instructions. `deterministic`
 * uses greedy sampling so identical prompts produce identical text. On
 * binaries older than `generateText` (hot-swapped JS) this degrades to the
 * `askOnDevice` shape rather than breaking. Throws when unavailable.
 */
export async function generateOnDeviceText(
  prompt: string,
  instructions = '',
  opts: { deterministic?: boolean } = {},
): Promise<string> {
  const native = NativeModule;
  if (native?.generateText) {
    const generate = native.generateText.bind(native);
    const result = await serializeFm(() => generate(prompt, instructions, opts.deterministic === true));
    return result?.answer ?? '';
  }
  if (native?.askOnDevice) {
    const result = await serializeFm(() =>
      native.askOnDevice(instructions ? `${instructions}\n\n${prompt}` : prompt, ''),
    );
    return result?.answer ?? '';
  }
  throw new Error('On-device AI is not available on this platform.');
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
  const native = NativeModule;
  if (!native?.parseReceiptStructured) {
    throw new Error('On-device receipt parsing is not available on this platform.');
  }
  return serializeFm(() => native.parseReceiptStructured(rawText, fewShot));
}

/**
 * Suggest a single expense category on-device for the given text. The caller
 * must validate the returned string against its canonical category list.
 * Throws when the on-device model is unavailable.
 */
export async function suggestExpenseCategory(text: string): Promise<string> {
  const native = NativeModule;
  if (!native?.suggestExpenseCategory) {
    throw new Error('On-device categorization is not available on this platform.');
  }
  return serializeFm(() => native.suggestExpenseCategory(text));
}

/**
 * "Understand" pass of the RAG pipeline: turn a free-form question into a
 * structured plan. Throws when the on-device model is unavailable.
 */
export async function planExpenseQuery(question: string, memberNames: string) {
  const native = NativeModule;
  if (!native?.planExpenseQuery) {
    throw new Error('On-device query planning is not available on this platform.');
  }
  return serializeFm(() => native.planExpenseQuery(question, memberNames));
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
  const native = NativeModule;
  if (!native?.parseExpenseFromText) {
    throw new Error('On-device expense parsing is not available on this platform.');
  }
  return serializeFm(() => native.parseExpenseFromText(text, memberNames, currentUserName));
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
  const native = NativeModule;
  if (!native?.askOnDeviceStateful) {
    throw new Error('On-device AI is not available on this platform.');
  }
  return serializeFm(() => native.askOnDeviceStateful(sessionId, question, context, instructions));
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
  const native = NativeModule;
  if (!native?.routeMessage) {
    throw new Error('On-device routing is not available on this platform.');
  }
  return serializeFm(() => native.routeMessage(sessionId, text, memberNames, isoDate));
}

/** S5 — Private Cloud Compute probe (iOS 27). `available` is false until the PCC
 * entitlement is granted; returns a neutral result off-iOS instead of throwing. */
export async function pccProbe(question: string): Promise<OnDevicePccProbeResult> {
  const native = NativeModule;
  if (!native?.pccProbe) {
    return { available: false, reason: 'unsupportedOS', answer: '', contextSize: 0 };
  }
  return serializeFm(() => native.pccProbe(question));
}

/** PCC ask with real instructions + quota surfaced (doc 23). Falls back to the
 * spike `pccProbe` on binaries built before `pccAsk` existed, so hot-swapped JS
 * degrades gracefully. Neutral result off-iOS instead of throwing. */
export async function pccAsk(question: string, instructions = ''): Promise<OnDevicePccAskResult> {
  const native = NativeModule;
  if (native?.pccAsk) {
    return serializeFm(() => native.pccAsk(question, instructions));
  }
  if (native?.pccProbe) {
    const probe = await serializeFm(() =>
      native.pccProbe(instructions ? `${instructions}\n\n${question}` : question),
    );
    return { available: probe.available, reason: probe.reason, answer: probe.answer, quota: '' };
  }
  return { available: false, reason: 'unsupportedOS', answer: '', quota: '' };
}

/**
 * Write the widget balance snapshot to the App Group container (native writes
 * `widget.json`, then reloads WidgetKit timelines). No-op off iOS or when the
 * App Group entitlement isn't granted yet. Never throws into the caller.
 */
export function writeWidgetSnapshot(snapshot: WidgetSnapshot): void {
  if (!NativeModule?.writeWidgetSnapshot) return;
  try {
    NativeModule.writeWidgetSnapshot(JSON.stringify(snapshot));
  } catch {
    // Best-effort — widgets are non-critical chrome.
  }
}

/** Force a WidgetKit timeline refresh. No-op off iOS. */
export function reloadWidgets(): void {
  if (!NativeModule?.reloadWidgets) return;
  try {
    NativeModule.reloadWidgets();
  } catch {
    // best-effort
  }
}

// ── Native search-tab bridge (UISearchTab on iOS 26, see the RNS patch) ─────

/**
 * True when THIS binary hosts the real UISearchTab: the tab bar itself morphs
 * into the system search field. When false (Android, iOS < 26, or an app build
 * older than the react-native-screens patch), SearchScreen renders its own
 * JS field instead.
 */
export function isNativeSearchTabAvailable(): boolean {
  try {
    return NativeModule?.hasNativeSearchTab?.() === true;
  } catch {
    return false;
  }
}

/**
 * Mirror the native tab-bar search field into JS. Events: `textChange` on every
 * keystroke, `activate`/`deactivate` for the search session (deactivate == the
 * user cancelled — Photos semantics: that is the moment a search is cleared),
 * `submit` on the return key. Returns an unsubscribe function.
 */
export function subscribeNativeSearchTab(listener: (event: SearchTabEvent) => void): () => void {
  if (!NativeModule?.addListener) return () => {};
  const subscription = NativeModule.addListener('onSearchTabEvent', listener);
  return () => subscription.remove();
}

/** Fill the native tab-bar search field (recents / suggestion taps). No-op elsewhere. */
export function setNativeSearchTabText(text: string): void {
  try {
    NativeModule?.setSearchTabText?.(text);
  } catch {
    // best-effort
  }
}

export { redactPIIFallback };
export type {
  SearchTabEvent,
  OnDeviceAiAvailability,
  OnDeviceAskResult,
  OnDeviceParsedExpenseRaw,
  OnDevicePccAskResult,
  OnDevicePccProbeResult,
  OnDeviceReceiptItem,
  OnDeviceReceiptResult,
  OnDeviceRouterDecisionRaw,
  WidgetExpense,
  WidgetGroupBalance,
  WidgetSnapshot,
};
