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
