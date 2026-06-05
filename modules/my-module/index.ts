import { requireOptionalNativeModule } from 'expo-modules-core';

const QuickLookPreview = requireOptionalNativeModule('QuickLookPreview');

export async function previewFile(uri: string, title?: string): Promise<boolean> {
  if (!QuickLookPreview || typeof QuickLookPreview.previewFile !== 'function') {
    throw new Error('QuickLookPreview is only available on iOS — rebuild with npx expo run:ios');
  }
  return await QuickLookPreview.previewFile(uri, title ?? null);
}
