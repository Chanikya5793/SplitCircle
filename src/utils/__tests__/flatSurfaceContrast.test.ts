// Guards the flat surface treatment (theme surfaceStyle === 'flat').
//
// Why this test exists: in glass mode the blur/liquid material sits between the
// ambient LiquidBackground blobs and the text, and it is doing real legibility
// work — measured against the worst-case blob, light-mode `muted` text lands at
// 2.92:1, well under WCAG AA. A flat surface has no material to do that job, so
// a flat fill MUST be opaque and MUST clear AA on its own. A translucent flat
// fill would inherit the blob contrast failure instead of fixing it.
//
// palette.ts is pure data with zero imports, so this runs in the node unit suite.

import { NEUTRALS } from '@/theme/palette';
import { describe, expect, it } from 'vitest';

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
};

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: [number, number, number]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

const contrast = (a: string, b: string) => {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const AA_BODY = 4.5;
const SCHEMES = ['light', 'dark'] as const;

describe('flat surface tokens', () => {
  it.each(SCHEMES)('%s: flat fills are fully opaque, never translucent', (scheme) => {
    const n = NEUTRALS[scheme];
    // The glass tints are rgba by design; the flat fills must not be. An
    // rgba flat surface would let the animated blobs bleed through with no
    // blur to average them out.
    expect(n.flatSurface).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(n.flatSurfaceAlt).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it.each(SCHEMES)('%s: body and muted text clear WCAG AA on the flat fill', (scheme) => {
    const n = NEUTRALS[scheme];
    expect(contrast(n.text, n.flatSurface)).toBeGreaterThanOrEqual(AA_BODY);
    // `muted` is the token that fails over blobs — it is the real test here.
    expect(contrast(n.muted, n.flatSurface)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(SCHEMES)('%s: text stays legible on the secondary flat fill', (scheme) => {
    const n = NEUTRALS[scheme];
    expect(contrast(n.text, n.flatSurfaceAlt)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(SCHEMES)('%s: the flat fill is distinguishable from the canvas', (scheme) => {
    const n = NEUTRALS[scheme];
    // A grouped flat surface has no blur and (deliberately) no elevation, so
    // the only thing separating it from the canvas is its own fill. If these
    // two collapse to the same value, grouping becomes invisible.
    expect(n.flatSurface.toLowerCase()).not.toBe(n.appBackground.toLowerCase());
  });
});
