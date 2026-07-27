import { describe, expect, it } from 'vitest';
import { IDENTITY_MATRIX, saturationMatrix } from '../colorMatrix';
import {
  clampCrop,
  createInitialEditorState,
  fitAspectRect,
  isEditorStateNeutral,
  rotatedBounds,
  totalRotationDegrees,
  type EditorState,
} from '../mediaEditorGeometry';

describe('rotatedBounds', () => {
  it('is a no-op at 0°', () => {
    const b = rotatedBounds(4000, 3000, 0);
    expect(b.width).toBeCloseTo(4000, 6);
    expect(b.height).toBeCloseTo(3000, 6);
  });

  it('swaps the axes at 90° and 270°', () => {
    for (const angle of [90, 270, -90]) {
      const b = rotatedBounds(4000, 3000, angle);
      expect(b.width, `${angle}°`).toBeCloseTo(3000, 6);
      expect(b.height, `${angle}°`).toBeCloseTo(4000, 6);
    }
  });

  it('returns to the original box at 180°', () => {
    const b = rotatedBounds(4000, 3000, 180);
    expect(b.width).toBeCloseTo(4000, 6);
    expect(b.height).toBeCloseTo(3000, 6);
  });

  it('grows the box for any off-axis angle', () => {
    // A straighten always needs MORE canvas than the source; if this ever
    // returned something smaller, the export would crop the photo's own
    // corners off without anyone asking for a crop.
    const b = rotatedBounds(1000, 1000, 45);
    expect(b.width).toBeGreaterThan(1000);
    expect(b.width).toBeCloseTo(Math.SQRT2 * 1000, 6);
    expect(b.height).toBeCloseTo(Math.SQRT2 * 1000, 6);
  });

  it('is symmetric in the sign of the angle', () => {
    const positive = rotatedBounds(1600, 900, 12);
    const negative = rotatedBounds(1600, 900, -12);
    expect(positive.width).toBeCloseTo(negative.width, 6);
    expect(positive.height).toBeCloseTo(negative.height, 6);
  });
});

describe('totalRotationDegrees', () => {
  it('combines quarter turns with the straighten offset', () => {
    const state = { ...createInitialEditorState(), rotationQuarters: 3, straightenDeg: -7 };
    expect(totalRotationDegrees(state)).toBe(263);
  });
});

describe('fitAspectRect', () => {
  it('fills the width when the target is wider than the bounds', () => {
    const r = fitAspectRect({ width: 1000, height: 1000 }, 16 / 9);
    expect(r.width).toBeCloseTo(1000, 6);
    expect(r.height).toBeCloseTo(562.5, 6);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.y).toBeCloseTo((1000 - 562.5) / 2, 6);
  });

  it('fills the height when the target is taller than the bounds', () => {
    const r = fitAspectRect({ width: 1000, height: 1000 }, 9 / 16);
    expect(r.height).toBeCloseTo(1000, 6);
    expect(r.width).toBeCloseTo(562.5, 6);
  });

  it('always stays inside the bounds and stays centred', () => {
    for (const aspect of [1, 4 / 3, 3 / 4, 16 / 9, 9 / 16, 2.35]) {
      const bounds = { width: 1920, height: 1080 };
      const r = fitAspectRect(bounds, aspect);
      expect(r.width, `${aspect}`).toBeLessThanOrEqual(bounds.width + 1e-9);
      expect(r.height, `${aspect}`).toBeLessThanOrEqual(bounds.height + 1e-9);
      expect(r.width / r.height, `${aspect}`).toBeCloseTo(aspect, 6);
      expect(r.x * 2 + r.width, `${aspect}`).toBeCloseTo(bounds.width, 6);
      expect(r.y * 2 + r.height, `${aspect}`).toBeCloseTo(bounds.height, 6);
    }
  });
});

describe('clampCrop', () => {
  const bounds = { width: 1000, height: 800 };

  it('leaves an already-valid rect alone', () => {
    const crop = { x: 100, y: 50, width: 400, height: 300 };
    expect(clampCrop(crop, bounds)).toEqual(crop);
  });

  it('pulls a rect that overhangs the far edge back inside', () => {
    const r = clampCrop({ x: 900, y: 700, width: 400, height: 300 }, bounds);
    expect(r.x + r.width).toBeLessThanOrEqual(bounds.width);
    expect(r.y + r.height).toBeLessThanOrEqual(bounds.height);
  });

  it('never leaves a negative origin for an oversized rect', () => {
    // The size-then-position order matters here: clamping position first
    // would strand a negative x, which exports as a blank band down one edge.
    const r = clampCrop({ x: -500, y: -500, width: 5000, height: 5000 }, bounds);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.width).toBe(bounds.width);
    expect(r.height).toBe(bounds.height);
  });

  it('keeps every clamped rect fully within bounds', () => {
    const cases = [
      { x: -10, y: -10, width: 100, height: 100 },
      { x: 999, y: 799, width: 10, height: 10 },
      { x: 0, y: 0, width: 1000, height: 800 },
      { x: 500, y: 400, width: 900, height: 700 },
    ];
    for (const c of cases) {
      const r = clampCrop(c, bounds);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(bounds.width + 1e-9);
      expect(r.y + r.height).toBeLessThanOrEqual(bounds.height + 1e-9);
    }
  });
});

describe('isEditorStateNeutral', () => {
  it('treats a freshly opened editor as neutral', () => {
    expect(isEditorStateNeutral(createInitialEditorState())).toBe(true);
  });

  it.each<[string, Partial<EditorState>]>([
    ['a crop', { crop: { x: 0, y: 0, width: 10, height: 10 } }],
    ['a quarter turn', { rotationQuarters: 1 }],
    ['a straighten', { straightenDeg: 2 }],
    ['a flip', { flipHorizontal: true }],
    ['a stroke', { strokes: [{ d: 'M0 0 L1 1', color: '#fff', widthFraction: 0.01 }] }],
    ['an adjustment', { adjustments: { brightness: 0.1, contrast: 0, saturation: 0, warmth: 0 } }],
    ['a preset', { presetMatrix: saturationMatrix(-1) }],
  ])('is not neutral once there is %s', (_label, patch) => {
    expect(isEditorStateNeutral({ ...createInitialEditorState(), ...patch })).toBe(false);
  });

  it('stays neutral for an explicitly identity preset', () => {
    const state = { ...createInitialEditorState(), presetMatrix: [...IDENTITY_MATRIX] };
    expect(isEditorStateNeutral(state)).toBe(true);
  });
});
