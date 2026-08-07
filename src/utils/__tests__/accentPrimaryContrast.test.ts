// Guards `primary` for all six accents — the loose thread left by
// solidBackgroundContrast.test.ts's money/status pass (2026-08-07). That pass
// checked the fixed NEUTRALS tokens only; `primary` lives per-accent in
// ACCENTS and was never checked against the solid-background presets.
//
// Found failing 4 of 6 accents in light mode (ocean, emerald, sunset, rose),
// two of them (emerald, sunset) never passing on ANY solid background —
// primary colours important text (links, selected states, active icons), so
// this is the same class of bug as the money/status gap, just in a table this
// file's sibling didn't scan.

import { ACCENTS, NEUTRALS, type AccentId } from '@/theme/palette';
import { SOLID_BACKGROUNDS } from '@/constants/solidBackgrounds';
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
const ACCENT_IDS = Object.keys(ACCENTS) as AccentId[];

describe('accent primary contrast', () => {
  it.each(
    ACCENT_IDS.flatMap((id) =>
      SOLID_BACKGROUNDS.map((bg) => [`${id}/${bg.id}`, id, bg] as const),
    ),
  )('%s: primary as text clears WCAG AA in both schemes', (_label, id, bg) => {
    const accent = ACCENTS[id];
    expect(contrast(accent.light.primary, bg.light), `light ${id}`).toBeGreaterThanOrEqual(
      AA_BODY,
    );
    expect(contrast(accent.dark.primary, bg.dark), `dark ${id}`).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(ACCENT_IDS.map((id) => [id, id] as const))(
    '%s: primary clears WCAG AA on the plain app background',
    (_label, id) => {
      const accent = ACCENTS[id];
      expect(
        contrast(accent.light.primary, NEUTRALS.light.appBackground),
        `light ${id}`,
      ).toBeGreaterThanOrEqual(AA_BODY);
      expect(
        contrast(accent.dark.primary, NEUTRALS.dark.appBackground),
        `dark ${id}`,
      ).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it.each(ACCENT_IDS.map((id) => [id, id] as const))(
    '%s: onPrimary is readable under the primary fill in both schemes',
    (_label, id) => {
      const accent = ACCENTS[id];
      expect(
        contrast(accent.light.onPrimary, accent.light.primary),
        `light ${id}`,
      ).toBeGreaterThanOrEqual(AA_BODY);
      expect(
        contrast(accent.dark.onPrimary, accent.dark.primary),
        `dark ${id}`,
      ).toBeGreaterThanOrEqual(AA_BODY);
    },
  );

  it('regression: the pre-fix light-mode primaries fail this suite', () => {
    // Negative control — proves the test actually catches the bug it exists
    // for, not just that the current values happen to pass.
    const preFix: Record<AccentId, string> = {
      ocean: '#1F6FEB',
      violet: '#7C3AED',
      emerald: '#059669',
      sunset: '#EA580C',
      rose: '#E11D48',
      mono: '#334155',
    };
    const worstBg = SOLID_BACKGROUNDS.find((bg) => bg.id === 'solid-ink')!;
    const failing = (Object.entries(preFix) as [AccentId, string][]).filter(
      ([, hex]) => contrast(hex, worstBg.light) < AA_BODY,
    );
    expect(failing.map(([id]) => id)).toEqual(['ocean', 'emerald', 'sunset', 'rose']);
  });
});
