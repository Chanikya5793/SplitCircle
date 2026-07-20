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

/** One event from the native (UISearchTab) tab-bar search field. */
export interface SearchTabEvent {
  type: 'textChange' | 'activate' | 'deactivate' | 'submit';
  text: string;
}

/** One delta from a native FM stream (doc 24 P2). `done` closes the stream. */
export interface FmChunkEvent {
  requestId: string;
  delta: string;
  done: boolean;
}

/** Native surface implemented in ios/SplitCircleAIModule.swift (iOS only). */
export interface SplitCircleAINativeModule {
  redactPII(text: string): string;
  /** True when this binary carries the UISearchTab bridge (iOS 26+ builds). */
  hasNativeSearchTab?(): boolean;
  /** Fill the native tab-bar search field (recents / suggestion taps). */
  setSearchTabText?(text: string): void;
  /** expo-modules event surface ('onSearchTabEvent', 'onFmChunk'). */
  addListener?<T = SearchTabEvent>(eventName: string, listener: (event: T) => void): { remove(): void };
  donateAskActivity(query?: string | null): Promise<void>;
  getOnDeviceAiAvailability(): OnDeviceAiAvailability;
  /** Token context window of the active on-device model; 0 when unavailable. */
  getOnDeviceContextSize(): number;
  askOnDevice(question: string, context: string): Promise<OnDeviceAskResult>;
  /**
   * Free-form generation with caller-supplied instructions — the narrative
   * tier's door (no Q&A persona, no citation struct). `deterministic` uses
   * greedy sampling. Absent on binaries older than this function.
   */
  generateText?(
    prompt: string,
    instructions: string,
    deterministic: boolean,
  ): Promise<{ answer: string }>;
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
  // P6 (doc 24): planExpenseQuery + the doc-17 spike surface (routeMessage,
  // askOnDeviceStateful, resetOnDeviceSession) are deleted — superseded by the
  // agentic pipeline below.
  // ── Agentic pipeline (doc 24) ─────────────────────────────────────────────
  /**
   * Whole-turn router decision (stateless — instructions + prompt fully
   * assembled in JS by aiLoop.ts). Absent on binaries older than doc-24 P1;
   * the pipeline capability-gates on it and falls back to the legacy path.
   */
  routeTurn?(instructions: string, prompt: string): Promise<OnDeviceAgentDecisionRaw>;
  /** One data-loop hop: done, or more tool requests. Ships with routeTurn. */
  agentLoopStep?(instructions: string, prompt: string): Promise<OnDeviceAgentLoopStepRaw>;
  /**
   * P2 — streamed free-form generation: emits 'onFmChunk' deltas, resolves
   * with the full final text when the stream ends. Absent on pre-P2 binaries.
   */
  generateTextStreamed?(
    requestId: string,
    prompt: string,
    instructions: string,
  ): Promise<{ answer: string; cancelled: boolean }>;
  /** P2 — cancel an in-flight stream by requestId (best-effort). */
  cancelFmStream?(requestId: string): void;
  /** Doc 25 — warm the on-device model ahead of the first turn. Absent pre-Q1. */
  prewarmOnDevice?(): Promise<boolean>;

  /** S5 — Private Cloud Compute probe (iOS 27). available=false until entitled. */
  pccProbe(question: string): Promise<OnDevicePccProbeResult>;
  /** PCC ask with real instructions + quota (doc 23). Absent on pre-entitlement binaries. */
  pccAsk(question: string, instructions: string): Promise<OnDevicePccAskResult>;
  /** P3 — PCC ask with a reasoning level + structured quota. Absent pre-P3. */
  pccAskDeep?(
    question: string,
    instructions: string,
    reasoningLevel: string,
  ): Promise<OnDevicePccAskResult>;

  // ── Widget / App-Group surface (doc 19) ───────────────────────────────────
  /** Write the widget balance snapshot to the App Group container + reload widgets. */
  writeWidgetSnapshot(json: string): void;
  /** Force a WidgetKit timeline refresh. */
  reloadWidgets(): void;
  /**
   * Re-scan the dynamic parameter options behind our Siri shortcuts (the group
   * picker). Call after the group set changes so Siri never offers stale groups.
   * Absent on older builds — guard before calling.
   */
  updateSiriShortcutParameters?(): void;
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

/** Doc 24 — one tool request from the agentic router ('' / 0 = unset). */
export interface OnDeviceAgentToolRequestRaw {
  tool: string;
  month: string;
  monthB: string;
  category: string;
  member: string;
  merchant: string;
  query: string;
  n: number;
  months: number;
}

/** Doc 24 — the router's whole-turn decision (coerced JS-side by aiLoop.ts). */
export interface OnDeviceAgentDecisionRaw {
  intent: string;
  confidence: number;
  complexity: string;
  assumption: string;
  clarifyQuestion: string;
  clarifyOptions: string[];
  abstainReply: string;
  requests: OnDeviceAgentToolRequestRaw[];
}

/** Doc 24 — one data-loop hop decision. */
export interface OnDeviceAgentLoopStepRaw {
  done: boolean;
  requests: OnDeviceAgentToolRequestRaw[];
}

export interface OnDevicePccProbeResult {
  available: boolean;
  reason: string;
  answer: string;
  contextSize: number;
}

export interface OnDevicePccAskResult {
  available: boolean;
  reason: string;
  answer: string;
  /** Best-effort description of PCC quota usage (opaque shape). */
  quota: string;
  /** P3 structured quota (pccAskDeep binaries only). */
  limitReached?: boolean;
  /** ISO date the quota resets, '' / absent when unknown. */
  resetDate?: string;
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
