import { describe, expect, it } from 'vitest';
import { AVATAR_PALETTES, avatarColorsForKey, readableForeground } from '../avatarColors';

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];
const luminance = ([r, g, b]: [number, number, number]) => {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * channel(r)) + (0.7152 * channel(g)) + (0.0722 * channel(b));
};
const contrast = (a: string, b: string) => {
  const values = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

describe('avatar colors', () => {
  it('pairs every avatar background with readable initials', () => {
    for (const color of [...AVATAR_PALETTES.light, ...AVATAR_PALETTES.dark]) {
      expect(contrast(color, readableForeground(color))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps avatar identity stable within each color scheme', () => {
    expect(avatarColorsForKey('person-42', false)).toEqual(avatarColorsForKey('person-42', false));
    expect(avatarColorsForKey('person-42', true)).toEqual(avatarColorsForKey('person-42', true));
  });
});
