/**
 * 4×5 colour matrices for the media editor's adjustments and filters.
 *
 * Skia's `ColorMatrix` takes 20 numbers laid out row-major, applied as
 *
 *   [ out_r ]   [ m0  m1  m2  m3  m4  ]   [ r ]
 *   [ out_g ] = [ m5  m6  m7  m8  m9  ] · [ g ]
 *   [ out_b ]   [ m10 m11 m12 m13 m14 ]   [ b ]
 *   [ out_a ]   [ m15 m16 m17 m18 m19 ]   [ a ]
 *                                          [ 1 ]
 *
 * with channels in 0–1. The fifth column is the additive term, which is why a
 * pure brightness offset lives there rather than on the diagonal.
 *
 * Everything here is pure arithmetic on plain arrays — no Skia import — so the
 * unit suite can exercise it without a native module. (`vitest.unit.config.ts`
 * runs files like this one; keep it free of RN/native imports.)
 */

export type ColorMatrix = number[];

export const IDENTITY_MATRIX: ColorMatrix = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

/**
 * Compose two colour matrices so that `first` is applied, then `second`.
 *
 * Treats each as a 5×5 with an implicit `[0 0 0 0 1]` bottom row, multiplies
 * `second · first`, and drops that row again. Order matters: composing in the
 * wrong direction makes the additive terms (brightness) apply before the
 * multiplicative ones (contrast/saturation) instead of after, which visibly
 * blows out highlights.
 */
export const composeMatrices = (
  first: ColorMatrix,
  second: ColorMatrix,
): ColorMatrix => {
  const out: ColorMatrix = new Array(20).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += second[row * 5 + k] * first[k * 5 + col];
      }
      // The implicit 5th row of `first` is [0,0,0,0,1], so it contributes
      // `second`'s own additive term only in the last column.
      if (col === 4) sum += second[row * 5 + 4];
      out[row * 5 + col] = sum;
    }
  }
  return out;
};

export const composeAll = (matrices: ColorMatrix[]): ColorMatrix =>
  matrices.reduce<ColorMatrix>((acc, m) => composeMatrices(acc, m), IDENTITY_MATRIX);

/**
 * Brightness as a pure additive offset.
 * @param amount -1 (black) … 0 (unchanged) … 1 (white)
 */
export const brightnessMatrix = (amount: number): ColorMatrix => [
  1, 0, 0, 0, amount,
  0, 1, 0, 0, amount,
  0, 0, 1, 0, amount,
  0, 0, 0, 1, 0,
];

/**
 * Contrast, scaled around mid-grey rather than around zero — scaling around
 * zero darkens the whole image instead of expanding its range.
 * @param amount -1 (flat) … 0 (unchanged) … 1 (doubled)
 */
export const contrastMatrix = (amount: number): ColorMatrix => {
  const scale = amount + 1;
  const offset = (1 - scale) * 0.5;
  return [
    scale, 0, 0, 0, offset,
    0, scale, 0, 0, offset,
    0, 0, scale, 0, offset,
    0, 0, 0, 1, 0,
  ];
};

/** Rec. 601 luma weights — what Skia's own saturation helper uses. */
const LUM_R = 0.213;
const LUM_G = 0.715;
const LUM_B = 0.072;

/**
 * Saturation by interpolating each channel toward the pixel's luminance.
 * @param amount -1 (greyscale) … 0 (unchanged) … 1 (doubled)
 */
export const saturationMatrix = (amount: number): ColorMatrix => {
  const s = amount + 1;
  const sr = (1 - s) * LUM_R;
  const sg = (1 - s) * LUM_G;
  const sb = (1 - s) * LUM_B;
  return [
    sr + s, sg, sb, 0, 0,
    sr, sg + s, sb, 0, 0,
    sr, sg, sb + s, 0, 0,
    0, 0, 0, 1, 0,
  ];
};

/**
 * Warmth: push red up and blue down (or the reverse for a cool cast).
 * Green is left alone so skin tones shift believably rather than going muddy.
 * @param amount -1 (cool/blue) … 0 (unchanged) … 1 (warm/orange)
 */
export const warmthMatrix = (amount: number): ColorMatrix => {
  const shift = amount * 0.2;
  return [
    1 + shift, 0, 0, 0, 0,
    0, 1, 0, 0, 0,
    0, 0, 1 - shift, 0, 0,
    0, 0, 0, 1, 0,
  ];
};

export interface Adjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
}

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
};

export const adjustmentsMatrix = (adjustments: Adjustments): ColorMatrix =>
  composeAll([
    // Multiplicative terms first, additive brightness last, so brightness
    // offsets the already-contrasted image rather than being amplified by it.
    saturationMatrix(adjustments.saturation),
    contrastMatrix(adjustments.contrast),
    warmthMatrix(adjustments.warmth),
    brightnessMatrix(adjustments.brightness),
  ]);

export const areAdjustmentsNeutral = (a: Adjustments): boolean =>
  a.brightness === 0 && a.contrast === 0 && a.saturation === 0 && a.warmth === 0;

export interface FilterPreset {
  id: string;
  label: string;
  matrix: ColorMatrix;
}

/**
 * Named looks, each expressed as the adjustment stack it stands for so the
 * presets and the manual sliders cannot drift apart in feel.
 *
 * `none` is first and is the identity — selecting it must be a true no-op, not
 * an approximate one, or a user who tries a filter and changes their mind
 * still ships a re-encoded, slightly-shifted image.
 */
export const FILTER_PRESETS: FilterPreset[] = [
  { id: 'none', label: 'Original', matrix: IDENTITY_MATRIX },
  {
    id: 'vivid',
    label: 'Vivid',
    matrix: adjustmentsMatrix({ brightness: 0.02, contrast: 0.18, saturation: 0.35, warmth: 0.05 }),
  },
  {
    id: 'warm',
    label: 'Warm',
    matrix: adjustmentsMatrix({ brightness: 0.04, contrast: 0.06, saturation: 0.12, warmth: 0.45 }),
  },
  {
    id: 'cool',
    label: 'Cool',
    matrix: adjustmentsMatrix({ brightness: 0.02, contrast: 0.08, saturation: 0.05, warmth: -0.4 }),
  },
  {
    id: 'mono',
    label: 'Mono',
    matrix: adjustmentsMatrix({ brightness: 0.02, contrast: 0.15, saturation: -1, warmth: 0 }),
  },
  {
    id: 'silver',
    label: 'Silver',
    matrix: composeAll([
      saturationMatrix(-1),
      contrastMatrix(-0.1),
      brightnessMatrix(0.06),
    ]),
  },
  {
    id: 'fade',
    label: 'Fade',
    matrix: adjustmentsMatrix({ brightness: 0.08, contrast: -0.22, saturation: -0.2, warmth: 0.08 }),
  },
  {
    id: 'noir',
    label: 'Noir',
    matrix: adjustmentsMatrix({ brightness: -0.04, contrast: 0.45, saturation: -1, warmth: 0 }),
  },
];
