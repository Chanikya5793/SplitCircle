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

  // ── Widget / App-Group surface (doc 19) ───────────────────────────────────
  /** Write the widget balance snapshot to the App Group container + reload widgets. */
  writeWidgetSnapshot(json: string): void;
  /** Force a WidgetKit timeline refresh. */
  reloadWidgets(): void;
  /** The App Group identifier the widget snapshot lives under. */
  getAppGroupId(): string;
}

/** A recent expense projected into the snapshot for Siri/Shortcuts entities. */
export interface WidgetExpense {
  id: string; // "<groupId>::<expenseId>"
  title: string;
  amount: number;
  category: string;
  /** epoch ms. */
  date: number;
  paidByName: string;
}

/**
 * One group's data projected into the shared snapshot. The widget uses only the
 * top block (id/name/memberCount/balance/currency); the rest powers the headless
 * Siri/Shortcuts read intents (net balance, who you owe, category spend, recent
 * expenses). All rich fields optional so the widget + older snapshots still parse.
 */
export interface WidgetGroupBalance {
  id: string;
  name: string;
  memberCount: number;
  /** +ve = you're owed, -ve = you owe, ~0 = settled. */
  balance: number;
  currency: string;
  totalSpend?: number;
  count?: number;
  /** Per-member net balance in this group (+ve owed to them, -ve they owe). */
  members?: { id: string; name: string; balance: number }[];
  categories?: { category: string; total: number }[];
  /** Relative to the current user (from the minimized settle-up plan). */
  youOwe?: { name: string; amount: number }[];
  owesYou?: { name: string; amount: number }[];
  recentExpenses?: WidgetExpense[];
}

/** The full snapshot the widget renders + Siri reads (written to widget.json). */
export interface WidgetSnapshot {
  userId: string;
  updatedAt: number;
  groups: WidgetGroupBalance[];
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
