import { registerWebModule, NativeModule } from 'expo';

import { ChangeEventPayload } from './QuickLookPreview.types';

type QuickLookPreviewModuleEvents = {
  onChange: (params: ChangeEventPayload) => void;
}

class QuickLookPreviewModule extends NativeModule<QuickLookPreviewModuleEvents> {
  PI = Math.PI;
  async setValueAsync(value: string): Promise<void> {
    this.emit('onChange', { value });
  }
  hello() {
    return 'Hello world! 👋';
  }
};

export default registerWebModule(QuickLookPreviewModule, 'QuickLookPreviewModule');
