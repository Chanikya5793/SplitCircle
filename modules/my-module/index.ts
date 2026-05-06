import { requireNativeModule } from 'expo-modules-core';

const QuickLookPreview = requireNativeModule('QuickLookPreview');

export async function previewFile(uri: string): Promise<boolean> {
  return await QuickLookPreview.previewFile(uri);
}
