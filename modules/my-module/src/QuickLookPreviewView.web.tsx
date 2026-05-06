import * as React from 'react';

import { QuickLookPreviewViewProps } from './QuickLookPreview.types';

export default function QuickLookPreviewView(props: QuickLookPreviewViewProps) {
  return (
    <div>
      <iframe
        style={{ flex: 1 }}
        src={props.url}
        onLoad={() => props.onLoad({ nativeEvent: { url: props.url } })}
      />
    </div>
  );
}
