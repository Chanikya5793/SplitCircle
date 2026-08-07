// Flat, unanimated background fills.
//
// Deliberately its OWN module with zero imports: wallpaperCatalog.ts require()s
// JPEG thumbnails at module scope, which a node test runner cannot resolve.
// Keeping these standalone lets solidBackgroundContrast.test.ts import the real
// values instead of a copy that can drift out of sync with them.
//
// Added alongside the existing blob/photo wallpapers — neither of which changed
// — for flat surface mode, where borderless content sits directly on the canvas
// with no glass material between the text and the backdrop. They are a
// free-standing choice and work in glass mode too.

export interface SolidBackground {
  id: string;
  label: string;
  kind: 'solid';
  /** Flat fill per scheme. No thumbnail asset — the picker swatch is drawn
   *  from these two values directly. */
  light: string;
  dark: string;
}

/**
 * Every value here is checked against the app's `text` and `muted` tokens for
 * WCAG AA by `src/utils/__tests__/solidBackgroundContrast.test.ts`. Don't add
 * one without running it: with borderless surfaces there is no card fill left,
 * so the background IS the text background.
 */
export const SOLID_BACKGROUNDS: SolidBackground[] = [
  // The app's own appBackground, offered explicitly so "no blobs" is something
  // you can pick rather than an absence.
  { id: 'solid-canvas', label: 'Canvas', kind: 'solid', light: '#F9FBFF', dark: '#121212' },
  { id: 'solid-paper', label: 'Paper', kind: 'solid', light: '#FFFFFF', dark: '#000000' },
  { id: 'solid-slate', label: 'Slate', kind: 'solid', light: '#F1F5F9', dark: '#17181C' },
  { id: 'solid-sand', label: 'Sand', kind: 'solid', light: '#FAF7F2', dark: '#1A1815' },
  { id: 'solid-mist', label: 'Mist', kind: 'solid', light: '#F2F6F5', dark: '#141A19' },
  { id: 'solid-ink', label: 'Ink', kind: 'solid', light: '#EEF1F7', dark: '#101318' },
];
