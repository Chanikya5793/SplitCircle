// Guards the solid background presets (wallpaper kind 'solid').
//
// Why this matters more than it looks: in FLAT (borderless) surface mode there
// is no card fill left anywhere on a content screen — surfaces render with no
// background at all — so whatever the user picks as their background is
// literally the background the body text sits on. A preset that fails contrast
// is not a slightly-off backdrop, it is unreadable content.
//
// In glass mode a translucent card still sits between text and backdrop, so
// this is stricter than glass mode strictly needs. That is deliberate: the same
// preset list is offered in both modes.
//
// Both modules imported here are pure data with zero imports, so this runs in
// the node unit suite. (SOLID_BACKGROUNDS deliberately does NOT live in
// wallpaperCatalog.ts, which require()s JPEGs that node cannot resolve.)

import { SOLID_BACKGROUNDS } from '@/constants/solidBackgrounds';
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

describe('solid background presets', () => {
  it('offers at least one preset', () => {
    expect(SOLID_BACKGROUNDS.length).toBeGreaterThan(0);
  });

  it('every preset is an opaque 6-digit hex in both schemes', () => {
    for (const bg of SOLID_BACKGROUNDS) {
      expect(bg.light, `${bg.id} light`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(bg.dark, `${bg.id} dark`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('preset ids are unique', () => {
    const ids = SOLID_BACKGROUNDS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(SOLID_BACKGROUNDS.map((b) => [b.id, b] as const))(
    '%s: body text clears WCAG AA in both schemes',
    (_id, bg) => {
      expect(contrast(NEUTRALS.light.text, bg.light)).toBeGreaterThanOrEqual(AA_BODY);
      expect(contrast(NEUTRALS.dark.text, bg.dark)).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(SOLID_BACKGROUNDS.map((b) => [b.id, b] as const))(
    '%s: muted text clears WCAG AA in both schemes',
    (_id, bg) => {
      // `muted` is the token that fails over animated blobs (2.92:1 light at
      // the worst blob). On a solid background it must pass outright — there is
      // no material left to lift it.
      expect(contrast(NEUTRALS.light.muted, bg.light)).toBeGreaterThanOrEqual(AA_BODY);
      expect(contrast(NEUTRALS.dark.muted, bg.dark)).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it('light presets are light and dark presets are dark', () => {
    // Guards a copy/paste swap of the two fields, which contrast alone would
    // not catch (a dark fill still passes against dark-scheme text).
    for (const bg of SOLID_BACKGROUNDS) {
      expect(luminance(hexToRgb(bg.light)), `${bg.id} light`).toBeGreaterThan(0.5);
      expect(luminance(hexToRgb(bg.dark)), `${bg.id} dark`).toBeLessThan(0.2);
    }
  });
});
