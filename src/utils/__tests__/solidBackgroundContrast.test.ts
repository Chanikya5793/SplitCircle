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

  // Money is the app's most important text and was the gap in this file's first
  // version, which checked only `text` and `muted`. Every money token failed AA
  // in light mode and nothing caught it — moneyPositive was 3.64:1 on the
  // DEFAULT background, i.e. wrong long before flat mode or solid presets
  // existed.
  //
  // 4.5:1 is the right bar even though the 28px hero figure would qualify for
  // the 3:1 large-text allowance: the same tokens colour 15px row amounts
  // ("you are owed ₹1,850.00"), which are normal text.
  const MONEY = ['moneyPositive', 'moneyNegative', 'moneyNeutral'] as const;

  it.each(
    SOLID_BACKGROUNDS.flatMap((bg) => MONEY.map((t) => [`${bg.id}/${t}`, bg, t] as const)),
  )('%s clears WCAG AA in both schemes', (_label, bg, token) => {
    expect(contrast(NEUTRALS.light[token], bg.light)).toBeGreaterThanOrEqual(AA_BODY);
    expect(contrast(NEUTRALS.dark[token], bg.dark)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it('money tokens also clear AA on the plain app background', () => {
    // Not just the presets — the default canvas is where most users will be,
    // and it is exactly where moneyPositive was failing unnoticed.
    for (const token of MONEY) {
      expect(
        contrast(NEUTRALS.light[token], NEUTRALS.light.appBackground),
        `light ${token}`,
      ).toBeGreaterThanOrEqual(AA_BODY);
      expect(
        contrast(NEUTRALS.dark[token], NEUTRALS.dark.appBackground),
        `dark ${token}`,
      ).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  // Semantic status colours, checked in BOTH directions — this class of bug was
  // found three times in one session (muted, then money, then these), always
  // because a token was only ever eyeballed in one role.
  //   as TEXT : `danger` alone colours text in 24 places (error messages,
  //             destructive labels) and was 3.82:1.
  //   as FILL : `success` is a background in 8 places with white `onSuccess`
  //             over it, which was 3.77:1.
  const STATUS = ['success', 'warning', 'danger'] as const;
  const ON: Record<(typeof STATUS)[number], 'onSuccess' | 'onWarning' | 'onDanger'> = {
    success: 'onSuccess',
    warning: 'onWarning',
    danger: 'onDanger',
  };

  it.each(
    SOLID_BACKGROUNDS.flatMap((bg) => STATUS.map((t) => [`${bg.id}/${t}`, bg, t] as const)),
  )('%s as text clears WCAG AA in both schemes', (_label, bg, token) => {
    expect(contrast(NEUTRALS.light[token], bg.light)).toBeGreaterThanOrEqual(AA_BODY);
    expect(contrast(NEUTRALS.dark[token], bg.dark)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(STATUS.map((t) => [t, t] as const))(
    '%s used as a fill is readable under its on-colour',
    (_label, token) => {
      for (const scheme of ['light', 'dark'] as const) {
        expect(
          contrast(NEUTRALS[scheme][ON[token]], NEUTRALS[scheme][token]),
          `${scheme} ${ON[token]} on ${token}`,
        ).toBeGreaterThanOrEqual(AA_BODY);
      }
    },
  );

  it('status colours also clear AA as text on the plain app background', () => {
    for (const token of STATUS) {
      for (const scheme of ['light', 'dark'] as const) {
        expect(
          contrast(NEUTRALS[scheme][token], NEUTRALS[scheme].appBackground),
          `${scheme} ${token}`,
        ).toBeGreaterThanOrEqual(AA_BODY);
      }
    }
  });

  it('light presets are light and dark presets are dark', () => {
    // Guards a copy/paste swap of the two fields, which contrast alone would
    // not catch (a dark fill still passes against dark-scheme text).
    for (const bg of SOLID_BACKGROUNDS) {
      expect(luminance(hexToRgb(bg.light)), `${bg.id} light`).toBeGreaterThan(0.5);
      expect(luminance(hexToRgb(bg.dark)), `${bg.id} dark`).toBeLessThan(0.2);
    }
  });
});
