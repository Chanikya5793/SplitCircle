export const MUGGU_VIEWBOX = 120;
export const MUGGU_CENTER = 60;

export const MUGGU_PETAL_PATH =
  'M60 60 C 32 46, 36 22, 60 12 C 84 22, 88 46, 60 60 Z';

/** Visible crown-to-centre portion of one woven petal. */
export const MUGGU_LONG_PATH =
  'M41.1989 30.3497 C43.2975 22.9415, 49.8657 16.2226, 60.0000 12.0000 C84.0000 22.0000, 88.0000 46.0000, 60.0000 60.0000';

/** Visible centre-to-crossing portion after the hidden underpass. */
export const MUGGU_SHORT_PATH =
  'M60.0000 60.0000 C54.5593 57.2796, 50.3268 54.1817, 47.2145 50.8823';

export const MUGGU_LONG_LENGTH = 92.541;
export const MUGGU_SHORT_LENGTH = 15.783;
export const MUGGU_FULL_DASH = '15.78 22.43 130.76';
export const MUGGU_SIMPLIFIED_DASH = '14.27 25.46 130.76';

export const MUGGU_DOTS = [
  { cx: 88.99, cy: 31.01 },
  { cx: 88.99, cy: 88.99 },
  { cx: 31.01, cy: 88.99 },
  { cx: 31.01, cy: 31.01 },
] as const;

export const MUGGU_PETAL_STAGES = [
  { longStart: 0, longEnd: 0.10037, shortStart: 0.10037, shortEnd: 0.11749 },
  { longStart: 0.14182, longEnd: 0.24219, shortStart: 0.24219, shortEnd: 0.25931 },
  { longStart: 0.28364, longEnd: 0.38401, shortStart: 0.38401, shortEnd: 0.40113 },
  { longStart: 0.42545, longEnd: 0.52583, shortStart: 0.52583, shortEnd: 0.54294 },
] as const;

export const MUGGU_CENTER_STAGE = {
  start: 0.57091,
  peak: 0.59345,
  end: 0.60727,
} as const;

export const MUGGU_DOT_STAGES = [
  { start: 0.61455, peak: 0.64073, end: 0.65818 },
  { start: 0.64364, peak: 0.66982, end: 0.68727 },
  { start: 0.67273, peak: 0.69891, end: 0.71636 },
  { start: 0.70182, peak: 0.728, end: 0.74545 },
] as const;
