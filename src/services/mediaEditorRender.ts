import type { CropRect, EditorState } from '@/utils/mediaEditorGeometry';
import {
  effectiveColorMatrix,
  isIdentityMatrix,
  rotatedBounds,
  totalRotationDegrees,
} from '@/utils/mediaEditorGeometry';
import {
  ImageFormat,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  type SkImage,
} from '@shopify/react-native-skia';
import { cacheDirectory, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy';

/**
 * Offscreen renderer for the photo editor.
 *
 * Deliberately NOT a snapshot of the on-screen `<Canvas>`: that canvas is
 * sized to the phone's screen, so exporting from it would silently downscale a
 * 4032×3024 photo to ~1200px wide and hand the compression stage an image that
 * has already lost most of its detail. Everything here re-renders at full
 * source resolution into an offscreen surface.
 *
 * All geometry is expressed in SOURCE PIXEL space, and the crop rect is
 * defined in the space the user actually sees (i.e. after rotation), because
 * that is the only frame in which "the rectangle I dragged" is meaningful.
 */

export const loadSkiaImage = async (uri: string): Promise<SkImage> => {
  const data = await Skia.Data.fromURI(uri);
  const image = Skia.Image.MakeImageFromEncoded(data);
  if (!image) {
    throw new Error('Could not decode this image for editing.');
  }
  return image;
};

/**
 * Render `state` over `image` at full resolution and write the result to a
 * JPEG in the cache directory. Returns the new file's URI plus its dimensions.
 *
 * JPEG at 0.95 rather than PNG: the editor's output feeds straight into the
 * existing compression stage, which will re-encode to JPEG anyway. Emitting a
 * lossless PNG here would mean writing (and hashing, and copying) a file
 * several times larger for a quality gain the next stage immediately discards.
 */
export const renderEditedImage = async (
  image: SkImage,
  state: EditorState,
): Promise<{ uri: string; width: number; height: number }> => {
  const sourceWidth = image.width();
  const sourceHeight = image.height();
  const degrees = totalRotationDegrees(state);
  const bounds = rotatedBounds(sourceWidth, sourceHeight, degrees);

  const crop: CropRect = state.crop ?? {
    x: 0,
    y: 0,
    width: bounds.width,
    height: bounds.height,
  };

  const outWidth = Math.max(1, Math.round(crop.width));
  const outHeight = Math.max(1, Math.round(crop.height));

  const surface = Skia.Surface.MakeOffscreen(outWidth, outHeight);
  if (!surface) {
    throw new Error('Could not allocate an image surface for the edit.');
  }
  const canvas = surface.getCanvas();

  // JPEG has no alpha, so anything outside the source (the triangular gaps a
  // straighten leaves at the corners) would encode as black. White reads as
  // deliberate matting instead of damage.
  canvas.clear(Skia.Color('white'));

  const paint = Skia.Paint();
  const matrix = effectiveColorMatrix(state);
  if (!isIdentityMatrix(matrix)) {
    paint.setColorFilter(Skia.ColorFilter.MakeMatrix(matrix));
  }

  canvas.save();
  // Read bottom-up: the image is centred on the origin, flipped, rotated,
  // moved so its rotated bounding box starts at (0,0), and finally shifted so
  // the crop's top-left lands at the surface origin.
  canvas.translate(-crop.x, -crop.y);
  canvas.translate(bounds.width / 2, bounds.height / 2);
  canvas.rotate(degrees, 0, 0);
  if (state.flipHorizontal) {
    canvas.scale(-1, 1);
  }
  canvas.translate(-sourceWidth / 2, -sourceHeight / 2);
  canvas.drawImage(image, 0, 0, paint);
  canvas.restore();

  // Strokes are stored against the output rect, so they are drawn AFTER the
  // crop transform is unwound — markup must not be rotated or colour-shifted
  // along with the photo it annotates.
  if (state.strokes.length > 0) {
    const longestEdge = Math.max(outWidth, outHeight);
    for (const stroke of state.strokes) {
      const path = Skia.Path.MakeFromSVGString(stroke.d);
      if (!path) continue;
      // Paths are normalised 0–1; scale into output pixels.
      const scale = Skia.Matrix();
      scale.scale(outWidth, outHeight);
      path.transform(scale);

      const strokePaint = Skia.Paint();
      strokePaint.setColor(Skia.Color(stroke.color));
      strokePaint.setStyle(PaintStyle.Stroke);
      strokePaint.setStrokeWidth(Math.max(1, stroke.widthFraction * longestEdge));
      strokePaint.setStrokeCap(StrokeCap.Round);
      strokePaint.setStrokeJoin(StrokeJoin.Round);
      strokePaint.setAntiAlias(true);
      canvas.drawPath(path, strokePaint);
    }
  }

  const snapshot = surface.makeImageSnapshot();
  const base64 = snapshot.encodeToBase64(ImageFormat.JPEG, 95);
  if (!base64) {
    throw new Error('Could not encode the edited image.');
  }

  const uri = `${cacheDirectory}edited-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.jpg`;
  await writeAsStringAsync(uri, base64, { encoding: EncodingType.Base64 });

  return { uri, width: outWidth, height: outHeight };
};
