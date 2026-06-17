import { requireOptionalNativeModule } from 'expo';

/** Why the on-device model can't run; "available" means it can. */
export type OnDeviceAiAvailability =
  | 'available'
  | 'deviceNotEligible'
  | 'appleIntelligenceNotEnabled'
  | 'modelNotReady'
  | 'unsupportedOS';

export interface OnDeviceAskResult {
  answer: string;
  /** 1-based indexes into the numbered context lines the model cited. */
  sourceIndexes: number[];
}

export interface OnDeviceReceiptItem {
  name: string;
  price: number;
  quantity: number;
}

export interface OnDeviceReceiptInsightsRaw {
  merchantAddress: string;
  merchantPhone: string;
  paymentMethod: string;
  savings: number;
  returnPolicy: string;
}

export interface OnDeviceReceiptResult {
  items: OnDeviceReceiptItem[];
  merchantName: string;
  date: string;
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
  insights?: OnDeviceReceiptInsightsRaw;
}

/** Native surface implemented in ios/SplitCircleAIModule.swift (iOS only). */
export interface SplitCircleAINativeModule {
  redactPII(text: string): string;
  donateAskActivity(query?: string | null): Promise<void>;
  getOnDeviceAiAvailability(): OnDeviceAiAvailability;
  /** Token context window of the active on-device model; 0 when unavailable. */
  getOnDeviceContextSize(): number;
  askOnDevice(question: string, context: string): Promise<OnDeviceAskResult>;
  /** Parse OCR receipt text into structured data on-device. */
  parseReceiptStructured(rawText: string, fewShot: string): Promise<OnDeviceReceiptResult>;
  /** Suggest one expense category for the given text (validated by the caller). */
  suggestExpenseCategory(text: string): Promise<string>;
  /** Parse a natural-language sentence into an expense draft. */
  parseExpenseFromText(
    text: string,
    memberNames: string,
    currentUserName: string,
  ): Promise<OnDeviceParsedExpenseRaw>;
  /** "Understand" pass: free-form question → structured query plan. */
  planExpenseQuery(question: string, memberNames: string): Promise<OnDeviceQueryPlanRaw>;

  // ── Pipeline v2 spike (doc 17 §A0) ────────────────────────────────────────
  /** S2 — ask grounded in a persistent per-session transcript (continuity). */
  askOnDeviceStateful(
    sessionId: string,
    question: string,
    context: string,
    instructions: string,
  ): Promise<OnDeviceAskResult>;
  /** S2 — clear a session's transcript ('' clears all). */
  resetOnDeviceSession(sessionId: string): void;
  /** S3 — single abstaining router decision over a persistent group session. */
  routeMessage(
    sessionId: string,
    text: string,
    memberNames: string,
    isoDate: string,
  ): Promise<OnDeviceRouterDecisionRaw>;
  /** S5 — Private Cloud Compute probe (iOS 27). available=false until entitled. */
  pccProbe(question: string): Promise<OnDevicePccProbeResult>;
}

export interface OnDeviceRouterDecisionRaw {
  intent: string;
  confidence: number;
  abstain: boolean;
  chitchatReply: string;
  queryPlan: OnDeviceQueryPlanRaw;
}

export interface OnDevicePccProbeResult {
  available: boolean;
  reason: string;
  answer: string;
  contextSize: number;
}

export interface OnDeviceQueryPlanRaw {
  intent: string;
  scope: string;
  category: string;
  member: string;
  metric: string;
  timeframe: string;
}

export interface OnDeviceParsedExpenseRaw {
  title: string;
  amount: number;
  category: string;
  paidByName: string;
  participantNames: string[];
  splitEqually: boolean;
  date: string;
}

/** Null on platforms without the native module (Android, web, Node tests). */
export default requireOptionalNativeModule<SplitCircleAINativeModule>('SplitCircleAI');
