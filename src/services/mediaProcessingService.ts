import { getInfoAsync } from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';
import {
  Video as VideoCompressor,
  getVideoMetaData,
  getImageMetaData,
} from 'react-native-compressor';

export type QualityLevel = 'HD' | 'SD';
// Image targets: HD = 1920px max edge, SD = 1280px.
// Video targets: HD = 1280px max edge (720p), SD = 854px (~480p).
// These mirror WhatsApp's "HD photos / videos" toggle behavior — `auto`
// compression in the native module picks an appropriate bitrate per platform.

interface ProcessedMedia {
  uri: string;
  width: number;
  height: number;
  size: number;
}

/** Per-image native metadata captured from the source file before processing.
 *  Surfaced through `mediaMetadata` so the info panel can show accurate,
 *  platform-reported numbers (and EXIF data — camera, capture time, etc.)
 *  instead of post-resize values that wouldn't match the preview. */
export interface SourceImageMetadata {
  /** Orientation-corrected source width (display-space). */
  sourceWidth: number;
  /** Orientation-corrected source height (display-space). */
  sourceHeight: number;
  sourceFileSize: number;
  cameraMake?: string;
  cameraModel?: string;
  /** Unix ms when the photo was taken, parsed from EXIF DateTimeOriginal. */
  takenAt?: number;
}

export interface SourceVideoMetadata {
  sourceWidth: number;
  sourceHeight: number;
  sourceFileSize: number;
}

export interface ProcessedImage extends ProcessedMedia, SourceImageMetadata {}
export interface ProcessedVideo extends ProcessedMedia, SourceVideoMetadata {}

/** Apply EXIF orientation to raw pixel dimensions. Orientations 5–8 imply
 *  a 90/270° rotation, which swaps width and height in display space. */
const orient = (
  rawWidth: number,
  rawHeight: number,
  orientation: number,
): { width: number; height: number } =>
  orientation >= 5 && orientation <= 8
    ? { width: rawHeight, height: rawWidth }
    : { width: rawWidth, height: rawHeight };

const parseExifDateTime = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  // EXIF stores capture time as "YYYY:MM:DD HH:MM:SS" — convert to ISO so
  // the JS Date parser doesn't misinterpret the colons as time separators.
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  const ts = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
  return Number.isFinite(ts) ? ts : undefined;
};

/** Read EXIF/dimensions from a local image. Falls back to RN's `Image.getSize`
 *  if the native call fails — the fallback can't see EXIF, so orientation
 *  defaults to 1 (no rotation). */
export const readImageSourceMetadata = async (
  uri: string,
): Promise<{
  rawWidth: number;
  rawHeight: number;
  orientation: number;
  meta: SourceImageMetadata;
}> => {
  let rawWidth = 0;
  let rawHeight = 0;
  let orientation = 1;
  let sourceFileSize = 0;
  let cameraMake: string | undefined;
  let cameraModel: string | undefined;
  let takenAt: number | undefined;

  try {
    const native = await getImageMetaData(uri);
    rawWidth = native.ImageWidth ?? 0;
    rawHeight = native.ImageHeight ?? 0;
    orientation = native.Orientation ?? 1;
    sourceFileSize = native.size ?? 0;
    const exif: Record<string, unknown> = (native.exif ?? {}) as Record<string, unknown>;
    const tiff = (exif['{TIFF}'] as Record<string, unknown> | undefined) ?? {};
    const exifSub = (exif['{Exif}'] as Record<string, unknown> | undefined) ?? {};
    cameraMake = (typeof exif.Make === 'string' ? exif.Make : undefined)
      ?? (typeof tiff.Make === 'string' ? tiff.Make : undefined);
    cameraModel = (typeof exif.Model === 'string' ? exif.Model : undefined)
      ?? (typeof tiff.Model === 'string' ? tiff.Model : undefined);
    takenAt = parseExifDateTime(exif.DateTimeOriginal)
      ?? parseExifDateTime(exifSub.DateTimeOriginal);
  } catch {
    try {
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        Image.getSize(uri, (w, h) => resolve({ w, h }), reject);
      });
      rawWidth = dims.w;
      rawHeight = dims.h;
    } catch {
      // Leave at 0 — caller handles missing dimensions.
    }
    try {
      const info = await getInfoAsync(uri);
      sourceFileSize = info.exists && 'size' in info ? info.size : 0;
    } catch {
      /* swallow */
    }
  }

  const oriented = orient(rawWidth, rawHeight, orientation);
  return {
    rawWidth,
    rawHeight,
    orientation,
    meta: {
      sourceWidth: oriented.width,
      sourceHeight: oriented.height,
      sourceFileSize,
      cameraMake,
      cameraModel,
      takenAt,
    },
  };
};

/**
 * Process an image: resize and compress to JPEG.
 *
 * Resize math is **orientation-aware**: portrait photos with EXIF rotation
 * (Orientation 5–8) report raw pixel dimensions in landscape, but the
 * displayed image is portrait. Using the raw dims to pick a resize target
 * silently distorts these into a stretched landscape — what the user sees
 * as "the image got rotated/flipped after sending". We read EXIF via
 * `getImageMetaData`, swap axes when needed, and pass a single-axis resize
 * so expo-image-manipulator preserves aspect ratio.
 */
export const processImage = async (
  uri: string,
  quality: QualityLevel,
): Promise<ProcessedImage> => {
  const maxDimension = quality === 'HD' ? 1920 : 1280;
  const compressQuality = quality === 'HD' ? 0.8 : 0.6;

  const { meta: source } = await readImageSourceMetadata(uri);
  const { sourceWidth, sourceHeight } = source;

  const actions: ImageManipulator.Action[] = [];
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest > 0 && longest > maxDimension) {
    // Single-axis resize keeps aspect ratio. expo-image-manipulator's
    // built-in orientation fixer runs *before* this resize, so we operate
    // in display space — pick the axis that's currently longer.
    if (sourceWidth >= sourceHeight) {
      actions.push({ resize: { width: maxDimension } });
    } else {
      actions.push({ resize: { height: maxDimension } });
    }
  }

  try {
    const result = await ImageManipulator.manipulateAsync(uri, actions, {
      compress: compressQuality,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    const fileInfo = await getInfoAsync(result.uri);
    const size = fileInfo.exists && 'size' in fileInfo ? fileInfo.size : 0;
    return {
      uri: result.uri,
      width: result.width,
      height: result.height,
      size,
      ...source,
    };
  } catch (manipulationError) {
    console.warn('Image manipulation failed, falling back to original:', manipulationError);
    return {
      uri,
      width: sourceWidth,
      height: sourceHeight,
      size: source.sourceFileSize,
      ...source,
    };
  }
};

/**
 * Process a video: transcode to MP4 with a quality-appropriate cap on the
 * longest edge. Uses `react-native-compressor`'s `auto` mode so the native
 * module picks a sensible bitrate per platform; we just bound the resolution.
 *
 * Falls back to the original URI if compression fails or yields a larger
 * file than the source — never makes the user wait on a transcode that
 * would actively hurt them.
 */
export const processVideo = async (
  uri: string,
  quality: QualityLevel,
  onProgress?: (fraction: number) => void,
): Promise<ProcessedVideo> => {
  const maxEdge = quality === 'HD' ? 1280 : 854;

  // Read the source dimensions / size up front so we can populate the result
  // even if compression bails. `getVideoMetaData` requires a real path, so
  // best-effort and don't block on errors.
  let srcWidth = 0;
  let srcHeight = 0;
  let srcSize = 0;
  try {
    const meta = await getVideoMetaData(uri);
    srcWidth = meta.width ?? 0;
    srcHeight = meta.height ?? 0;
    srcSize = meta.size ?? 0;
  } catch {
    const fileInfo = await getInfoAsync(uri);
    srcSize = fileInfo.exists && 'size' in fileInfo ? fileInfo.size : 0;
  }

  const sourceMeta: SourceVideoMetadata = {
    sourceWidth: srcWidth,
    sourceHeight: srcHeight,
    sourceFileSize: srcSize,
  };

  // If the video is small in *both* dimensions and *bytes*, skip transcoding
  // entirely. The native module would otherwise re-encode short tiny clips
  // and likely make the file larger (the 360×480 case).
  //
  // We deliberately don't short-circuit purely on resolution: a 3-minute 720p
  // clip has `longestEdge <= maxEdge` but can be >100MB, and skipping here
  // would surface as the upload-cap error in `mediaService` after the user
  // already waited through the pipeline.
  const longestEdge = Math.max(srcWidth, srcHeight);
  const SKIP_COMPRESS_BYTES = 25 * 1024 * 1024;
  if (longestEdge > 0 && longestEdge <= maxEdge && srcSize > 0 && srcSize <= SKIP_COMPRESS_BYTES) {
    return { uri, width: srcWidth, height: srcHeight, size: srcSize, ...sourceMeta };
  }

  try {
    const compressedUri = await VideoCompressor.compress(
      uri,
      {
        compressionMethod: 'auto',
        maxSize: maxEdge,
        // Skip compression entirely for already-tiny clips so we don't
        // bloat 100KB videos to 500KB by re-encoding them.
        minimumFileSizeForCompress: 1, // MB
      },
      onProgress,
    );

    let outWidth = srcWidth;
    let outHeight = srcHeight;
    let outSize = srcSize;
    try {
      const meta = await getVideoMetaData(compressedUri);
      outWidth = meta.width ?? srcWidth;
      outHeight = meta.height ?? srcHeight;
      outSize = meta.size ?? srcSize;
    } catch {
      const info = await getInfoAsync(compressedUri);
      outSize = info.exists && 'size' in info ? info.size : srcSize;
    }

    // If the "compressed" file ended up larger than the source (can happen
    // for short clips that were already efficient), keep the original.
    if (srcSize > 0 && outSize > srcSize) {
      return { uri, width: srcWidth, height: srcHeight, size: srcSize, ...sourceMeta };
    }

    return {
      uri: compressedUri,
      width: outWidth,
      height: outHeight,
      size: outSize,
      ...sourceMeta,
    };
  } catch (err) {
    console.warn('Video compression failed, sending original:', err);
    return { uri, width: srcWidth, height: srcHeight, size: srcSize, ...sourceMeta };
  }
};
