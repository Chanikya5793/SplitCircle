import { describe, expect, it } from 'vitest';
import {
  adjustmentsMatrix,
  areAdjustmentsNeutral,
  brightnessMatrix,
  composeMatrices,
  contrastMatrix,
  FILTER_PRESETS,
  IDENTITY_MATRIX,
  NEUTRAL_ADJUSTMENTS,
  saturationMatrix,
  type ColorMatrix,
} from '../colorMatrix';

/** Apply a 4×5 matrix to an RGBA pixel the way Skia does. */
const applyMatrix = (
  m: ColorMatrix,
  [r, g, b, a]: [number, number, number, number],
): [number, number, number, number] => [
  m[0] * r + m[1] * g + m[2] * b + m[3] * a + m[4],
  m[5] * r + m[6] * g + m[7] * b + m[8] * a + m[9],
  m[10] * r + m[11] * g + m[12] * b + m[13] * a + m[14],
  m[15] * r + m[16] * g + m[17] * b + m[18] * a + m[19],
];

const closeTo = (actual: number[], expected: number[]) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
};

describe('colorMatrix', () => {
  it('leaves a pixel untouched under the identity matrix', () => {
    closeTo(applyMatrix(IDENTITY_MATRIX, [0.2, 0.4, 0.6, 1]), [0.2, 0.4, 0.6, 1]);
  });

  it('composes in application order: first, then second', () => {
    // Brightness +0.1 then contrast ×2-around-mid should equal doing them by
    // hand in that order. Composing the other way round would apply the
    // contrast to the un-brightened value and give a different result.
    const first = brightnessMatrix(0.1);
    const second = contrastMatrix(1);
    const composed = composeMatrices(first, second);

    const pixel: [number, number, number, number] = [0.3, 0.5, 0.7, 1];
    const stepwise = applyMatrix(second, applyMatrix(first, pixel));
    closeTo(applyMatrix(composed, pixel), stepwise);
  });

  it('is not commutative, so the order guard above is meaningful', () => {
    const a = brightnessMatrix(0.3);
    const b = contrastMatrix(0.8);
    const pixel: [number, number, number, number] = [0.4, 0.4, 0.4, 1];
    const ab = applyMatrix(composeMatrices(a, b), pixel);
    const ba = applyMatrix(composeMatrices(b, a), pixel);
    expect(ab[0]).not.toBeCloseTo(ba[0], 3);
  });

  it('composing with identity changes nothing, in either position', () => {
    const m = adjustmentsMatrix({ brightness: 0.1, contrast: 0.2, saturation: 0.3, warmth: 0.4 });
    closeTo(composeMatrices(m, IDENTITY_MATRIX), m);
    closeTo(composeMatrices(IDENTITY_MATRIX, m), m);
  });

  it('holds mid-grey fixed under contrast', () => {
    // The whole reason contrast scales around 0.5 rather than 0: mid-grey must
    // not drift, or raising contrast darkens the entire image.
    const out = applyMatrix(contrastMatrix(0.75), [0.5, 0.5, 0.5, 1]);
    closeTo([out[0], out[1], out[2]], [0.5, 0.5, 0.5]);
  });

  it('collapses colour to luminance at full desaturation', () => {
    const out = applyMatrix(saturationMatrix(-1), [1, 0, 0, 1]);
    // All three channels must agree — that is what "grey" means.
    expect(out[0]).toBeCloseTo(out[1], 5);
    expect(out[1]).toBeCloseTo(out[2], 5);
    expect(out[0]).toBeCloseTo(0.213, 3);
  });

  it('preserves alpha through every adjustment', () => {
    const m = adjustmentsMatrix({ brightness: -0.5, contrast: 0.9, saturation: -1, warmth: 1 });
    const [, , , alpha] = applyMatrix(m, [0.6, 0.2, 0.9, 0.5]);
    expect(alpha).toBeCloseTo(0.5, 5);
  });

  it('treats neutral adjustments as an exact identity', () => {
    // A user who opens Adjust, changes nothing, and hits Done must not get a
    // subtly shifted image back.
    closeTo(adjustmentsMatrix(NEUTRAL_ADJUSTMENTS), IDENTITY_MATRIX);
    expect(areAdjustmentsNeutral(NEUTRAL_ADJUSTMENTS)).toBe(true);
  });

  it('exposes "none" as a true identity preset', () => {
    const none = FILTER_PRESETS.find((p) => p.id === 'none');
    expect(none).toBeDefined();
    closeTo(none!.matrix, IDENTITY_MATRIX);
  });

  it('gives every preset a well-formed 4x5 matrix', () => {
    for (const preset of FILTER_PRESETS) {
      expect(preset.matrix, preset.id).toHaveLength(20);
      expect(preset.matrix.every(Number.isFinite), preset.id).toBe(true);
    }
  });
});
