import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * iCloud-aware Photos access.
 *
 * Probed with `requireOptionalNativeModule` rather than `requireNativeModule`
 * per this project's Hermes rule: a hard require on a module whose native half
 * is missing (an older build, a JS-only reload against a stale binary) is a
 * SIGSEGV, not a catchable error. Every export here degrades to "unsupported"
 * so callers can fall back to `expo-image-picker`.
 */

export interface PickedAsset {
  /** PHAsset local identifier. Stable, and cheap to resolve later. */
  assetId: string;
  type: 'image' | 'video';
  width: number;
  height: number;
  /** Milliseconds; 0 for stills. */
  duration: number;
  fileName: string;
}

export interface MaterializedAsset {
  uri: string;
  width: number;
  height: number;
  duration: number;
  fileSize: number;
  fileName: string;
}

interface NativeMediaModule {
  pickAssets(selectionLimit: number, mediaTypes: string): Promise<PickedAsset[]>;
  requestThumbnail(
    assetId: string,
    maxPixel: number,
  ): Promise<{ uri: string; width: number; height: number }>;
  materializeAsset(assetId: string, requestId: string): Promise<MaterializedAsset>;
  cancelMaterialize(requestId: string): void;
  addListener(
    event: 'onMaterializeProgress',
    listener: (payload: { requestId: string; fraction: number }) => void,
  ): { remove: () => void };
}

const nativeModule =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<NativeMediaModule>('SplitCircleMedia')
    : null;

/** Whether the native path is usable. Callers fall back when false. */
export const isNativeMediaAvailable = (): boolean => nativeModule !== null;

/**
 * Present the system picker and get back identifiers only.
 *
 * Returns without reading a single byte of file data, which is the entire
 * point: the stock picker downloads every selected asset from iCloud before
 * it resolves, and that is what freezes the app on a library using Optimize
 * iPhone Storage.
 */
export const pickAssets = async (
  selectionLimit: number,
  mediaTypes: 'images' | 'videos' | 'all' = 'all',
): Promise<PickedAsset[]> => {
  if (!nativeModule) throw new Error('Native media picker is unavailable.');
  return nativeModule.pickAssets(selectionLimit, mediaTypes);
};

/** A small local render for preview UI. Does not trigger a full download. */
export const requestThumbnail = async (
  assetId: string,
  maxPixel = 1280,
): Promise<{ uri: string; width: number; height: number }> => {
  if (!nativeModule) throw new Error('Native media picker is unavailable.');
  return nativeModule.requestThumbnail(assetId, maxPixel);
};

/**
 * Fetch the original file. This is the slow one — it may pull hundreds of MB
 * off iCloud — so it reports progress and can be cancelled.
 */
export const materializeAsset = async (
  assetId: string,
  requestId: string,
): Promise<MaterializedAsset> => {
  if (!nativeModule) throw new Error('Native media picker is unavailable.');
  return nativeModule.materializeAsset(assetId, requestId);
};

export const cancelMaterialize = (requestId: string): void => {
  nativeModule?.cancelMaterialize(requestId);
};

export const addMaterializeProgressListener = (
  listener: (payload: { requestId: string; fraction: number }) => void,
): { remove: () => void } => {
  if (!nativeModule) return { remove: () => {} };
  return nativeModule.addListener('onMaterializeProgress', listener);
};

/**
 * Thrown when the user cancels a materialization. Named to match the send
 * pipeline's other cancel sentinels so one check covers them all.
 */
export const isMaterializeCancellation = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message === 'Cancelled.' ||
    // Expo surfaces a rejected promise's code in the message on some paths.
    error.message.includes('E_CANCELLED'));
