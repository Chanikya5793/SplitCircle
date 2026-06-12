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

/** Native surface implemented in ios/SplitCircleAIModule.swift (iOS only). */
export interface SplitCircleAINativeModule {
  redactPII(text: string): string;
  donateAskActivity(query?: string | null): Promise<void>;
  getOnDeviceAiAvailability(): OnDeviceAiAvailability;
  askOnDevice(question: string, context: string): Promise<OnDeviceAskResult>;
}

/** Null on platforms without the native module (Android, web, Node tests). */
export default requireOptionalNativeModule<SplitCircleAINativeModule>('SplitCircleAI');
