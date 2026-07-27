import type { Adjustments, ColorMatrix } from '@/utils/colorMatrix';
import { adjustmentsMatrix, composeMatrices, IDENTITY_MATRIX } from '@/utils/colorMatrix';

/**
 * The photo editor's data model and its geometry, with no Skia import.
 *
 * Split out from `mediaEditorRender.ts` deliberately: that module pulls in the
 * native Skia binding at import time, which makes anything in it unreachable
 * from the pure-module unit suite. The transform math is both the most
 * error-prone part of the editor and the part where a preview/export mismatch
 * would be invisible in review, so it belongs somewhere a test can reach it.
 *
 * (Pure module — no RN/native imports. See the `vitest.unit.config.ts` note in
 * CLAUDE.md before adding an import here.)
 */

/** A crop rectangle in rotated-image space, in pixels. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One markup stroke, normalised against the OUTPUT (post-crop) rect so it
 *  maps to any export resolution without carrying a scale factor around. */
export interface DrawStroke {
  /** SVG path data, coordinates in 0–1. */
  d: string;
  color: string;
  /** Stroke width as a fraction of the output's longest edge, so a line keeps
   *  its apparent thickness whether exported at 1280px or 4032px. */
  widthFraction: number;
}

export interface EditorState {
  /** null means "no crop" — the full (rotated) image. */
  crop: CropRect | null;
  /** Whole 90° turns, 0–3. Kept separate from `straightenDeg` so the UI can
   *  offer an exact "rotate 90°" that introduces no resampling error. */
  rotationQuarters: number;
  /** Fine rotation in degrees, -45…45. */
  straightenDeg: number;
  flipHorizontal: boolean;
  adjustments: Adjustments;
  /** Matrix from the selected named preset, or identity for "Original". */
  presetMatrix: ColorMatrix;
  strokes: DrawStroke[];
}

export const createInitialEditorState = (): EditorState => ({
  crop: null,
  rotationQuarters: 0,
  straightenDeg: 0,
  flipHorizontal: false,
  adjustments: { brightness: 0, contrast: 0, saturation: 0, warmth: 0 },
  presetMatrix: IDENTITY_MATRIX,
  strokes: [],
});

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Total rotation the user has applied, in degrees.
 * The preview must apply exactly the angle the export will — the single most
 * likely place for a "it looked different before I sent it" mismatch.
 */
export const totalRotationDegrees = (state: EditorState): number =>
  state.rotationQuarters * 90 + state.straightenDeg;

/**
 * Axis-aligned bounding box of the source image once rotated.
 *
 * This is the coordinate space the crop rect lives in AND the space the
 * preview lays out, so both sides must derive it from this one function.
 */
export const rotatedBounds = (
  sourceWidth: number,
  sourceHeight: number,
  degrees: number,
): { width: number; height: number } => {
  const radians = toRadians(degrees);
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return {
    width: sourceWidth * cos + sourceHeight * sin,
    height: sourceWidth * sin + sourceHeight * cos,
  };
};

/** The colour matrix for a state: named preset first, then manual sliders. */
export const effectiveColorMatrix = (state: EditorState): ColorMatrix =>
  composeMatrices(state.presetMatrix, adjustmentsMatrix(state.adjustments));

export const isIdentityMatrix = (matrix: ColorMatrix): boolean =>
  matrix.every((v, i) => Math.abs(v - IDENTITY_MATRIX[i]) < 1e-9);

/**
 * True when the state would produce a byte-identical image, so the caller can
 * skip the export entirely.
 *
 * Worth having: opening the editor, looking around, and closing it must not
 * cost the user a re-encode generation on their photo.
 */
export const isEditorStateNeutral = (state: EditorState): boolean =>
  state.crop === null &&
  state.rotationQuarters === 0 &&
  state.straightenDeg === 0 &&
  !state.flipHorizontal &&
  state.strokes.length === 0 &&
  isIdentityMatrix(effectiveColorMatrix(state));

/**
 * Largest rectangle of the given aspect ratio that fits inside `bounds`,
 * centred. Used when the user picks an aspect preset (Square, 4:3, 16:9) so
 * the crop snaps to something valid rather than being clamped afterwards.
 */
export const fitAspectRect = (
  bounds: { width: number; height: number },
  aspect: number,
): CropRect => {
  let width = bounds.width;
  let height = width / aspect;
  if (height > bounds.height) {
    height = bounds.height;
    width = height * aspect;
  }
  return {
    x: (bounds.width - width) / 2,
    y: (bounds.height - height) / 2,
    width,
    height,
  };
};

/**
 * Keep a crop rect inside its bounds.
 *
 * Clamps size first, then position — the other order lets a rect that is
 * wider than its bounds be "positioned" to a negative x and then keep that
 * negative x after the width is reduced, which renders as a band of blank
 * canvas down one edge of the exported photo.
 */
export const clampCrop = (
  crop: CropRect,
  bounds: { width: number; height: number },
): CropRect => {
  const width = Math.min(crop.width, bounds.width);
  const height = Math.min(crop.height, bounds.height);
  return {
    width,
    height,
    x: Math.min(Math.max(0, crop.x), bounds.width - width),
    y: Math.min(Math.max(0, crop.y), bounds.height - height),
  };
};
