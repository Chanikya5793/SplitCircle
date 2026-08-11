// Guards the MD3 container roles across all six accents.
//
// WHY THIS EXISTS. `buildTheme` starts from `...MD3LightTheme.colors` /
// `...MD3DarkTheme.colors`, so EVERY Material role is already present before
// this app sets anything. A role the app forgets to override does not error,
// does not fall back to a neutral, and does not look obviously broken in code
// review — it silently keeps Material's stock baseline palette, which is
// purple. `secondaryContainer` sat like that for the app's entire life: expense
// category chips, Add Expense participant chips, media-gallery doc icons and
// group-info action icons all rendered Material lavender no matter which of the
// six accents was selected. It was found by looking at the running app, not by
// reading code, and nothing in tsc, lint or the test suite could have caught it.
//
// So this test asserts two separate things:
//   1. the app actually SETS these roles (catches the silent-inheritance bug);
//   2. the on/container pairs clear WCAG AA (catches an unreadable chip).
//
// Both directions matter — see solidBackgroundContrast.test.ts, where the same
// "a token was only ever considered in one role" mistake was made twice.

import { ACCENTS, ACCENT_IDS, NEUTRALS } from '@/theme/palette';
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

// Material's stock baseline values. If any of these show up in a built theme,
// the app has stopped overriding that role and Material purple is back.
const MD3_STOCK = [
  '#E8DEF8', // secondaryContainer (light)
  '#4A4458', // secondaryContainer (dark)
  '#1D192B', // onSecondaryContainer (light)
  '#E8DEF8', // onSecondaryContainer (dark)
  '#E7E0EC', // surfaceVariant (light)
  '#49454F', // surfaceVariant (dark)
  '#CAC4D0', // outlineVariant (light)
].map((h) => h.toUpperCase());

describe('accent container roles', () => {
  it('covers every accent', () => {
    expect(ACCENT_IDS.length).toBe(6);
  });

  it.each(
    ACCENT_IDS.flatMap((id) => SCHEMES.map((s) => [`${id}/${s}`, id, s] as const)),
  )('%s defines the secondary-container roles itself', (_label, id, scheme) => {
    const a = ACCENTS[id][scheme];
    for (const role of ['secondaryContainer', 'onSecondaryContainer', 'onSecondary'] as const) {
      expect(a[role], `${id}.${scheme}.${role}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      // The specific failure this whole file exists for.
      expect(MD3_STOCK, `${id}.${scheme}.${role} is Material's stock value`).not.toContain(
        a[role].toUpperCase(),
      );
    }
  });

  it.each(
    ACCENT_IDS.flatMap((id) => SCHEMES.map((s) => [`${id}/${s}`, id, s] as const)),
  )('%s: onSecondaryContainer is readable on secondaryContainer', (_label, id, scheme) => {
    const a = ACCENTS[id][scheme];
    expect(contrast(a.onSecondaryContainer, a.secondaryContainer)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(
    ACCENT_IDS.flatMap((id) => SCHEMES.map((s) => [`${id}/${s}`, id, s] as const)),
  )('%s: onSecondary is readable on secondary', (_label, id, scheme) => {
    const a = ACCENTS[id][scheme];
    expect(contrast(a.onSecondary, a.secondary)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(
    ACCENT_IDS.flatMap((id) => SCHEMES.map((s) => [`${id}/${s}`, id, s] as const)),
  )('%s: onPrimaryContainer is readable on primaryContainer', (_label, id, scheme) => {
    // Not part of the bug, but the same shape of pair — cheap to cover while
    // the machinery is here, and it would be embarrassing to miss twice.
    const a = ACCENTS[id][scheme];
    expect(contrast(a.onPrimaryContainer, a.primaryContainer)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it('the neutral MD3 roles are set by the app, not inherited', () => {
    for (const scheme of SCHEMES) {
      const n = NEUTRALS[scheme] as unknown as Record<string, string>;
      for (const role of ['surfaceVariant', 'outlineVariant', 'surfaceDisabled']) {
        expect(n[role], `${scheme}.${role}`).toBeTruthy();
        expect(MD3_STOCK, `${scheme}.${role} is Material's stock value`).not.toContain(
          String(n[role]).toUpperCase(),
        );
      }
    }
  });

  it('body text is readable on surfaceVariant', () => {
    for (const scheme of SCHEMES) {
      const n = NEUTRALS[scheme];
      expect(contrast(n.text, n.surfaceVariant), `${scheme}`).toBeGreaterThanOrEqual(AA_BODY);
    }
  });
});
