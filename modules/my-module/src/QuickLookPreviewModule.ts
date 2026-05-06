import { NativeModule, requireNativeModule } from 'expo';

import { QuickLookPreviewModuleEvents } from './QuickLookPreview.types';

declare class QuickLookPreviewModule extends NativeModule<QuickLookPreviewModuleEvents> {
  PI: number;
  hello(): string;
  setValueAsync(value: string): Promise<void>;
}

// This call loads the native module object from the JSI.
export default requireNativeModule<QuickLookPreviewModule>('QuickLookPreview');
