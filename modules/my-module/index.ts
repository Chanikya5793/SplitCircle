import { requireOptionalNativeModule } from 'expo-modules-core';

const QuickLookPreview = requireOptionalNativeModule('QuickLookPreview');

export async function previewFile(uri: string, title?: string): Promise<boolean> {
  if (!QuickLookPreview) {
    throw new Error('QuickLookPreview native module not available — rebuild the app with npx expo run:ios');
  }
  return await QuickLookPreview.previewFile(uri, title ?? null);
}
