import { requireNativeView } from 'expo';
import * as React from 'react';

import { QuickLookPreviewViewProps } from './QuickLookPreview.types';

const NativeView: React.ComponentType<QuickLookPreviewViewProps> =
  requireNativeView('QuickLookPreview');

export default function QuickLookPreviewView(props: QuickLookPreviewViewProps) {
  return <NativeView {...props} />;
}
