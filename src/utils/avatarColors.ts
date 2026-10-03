export const AVATAR_PALETTES = {
  light: [
    '#4338CA',
    '#0E7490',
    '#047857',
    '#92400E',
    '#B91C1C',
    '#6D28D9',
    '#1D4ED8',
    '#0F766E',
    '#BE185D',
    '#475569',
  ],
  dark: [
    '#A5B4FC',
    '#67E8F9',
    '#6EE7B7',
    '#FCD34D',
    '#FCA5A5',
    '#D8B4FE',
    '#93C5FD',
    '#5EEAD4',
    '#F9A8D4',
    '#CBD5E1',
  ],
} as const;

const parseHex = (color: string): [number, number, number] | null => {
  const value = color.trim().replace(/^#/, '');
  const expanded = value.length === 3
    ? value.split('').map((part) => `${part}${part}`).join('')
    : value.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return null;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
};

const relativeLuminance = ([red, green, blue]: [number, number, number]): number => {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * channel(red)) + (0.7152 * channel(green)) + (0.0722 * channel(blue));
};

const contrastRatio = (a: [number, number, number], b: [number, number, number]): number => {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
};

export const readableForeground = (background: string): '#111827' | '#FFFFFF' => {
  const rgb = parseHex(background);
  if (!rgb) return '#FFFFFF';
  const dark: [number, number, number] = [17, 24, 39];
  const light: [number, number, number] = [255, 255, 255];
  return contrastRatio(rgb, dark) >= contrastRatio(rgb, light) ? '#111827' : '#FFFFFF';
};

const stableIndex = (key: string, length: number): number => {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = key.charCodeAt(index) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % length;
};

export const avatarColorsForKey = (key: string, isDark: boolean) => {
  const palette = isDark ? AVATAR_PALETTES.dark : AVATAR_PALETTES.light;
  const background = palette[stableIndex(key, palette.length)];
  return {
    background,
    foreground: readableForeground(background),
  } as const;
};
