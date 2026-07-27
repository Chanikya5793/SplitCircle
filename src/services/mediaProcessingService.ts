import { getInfoAsync } from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image, Platform } from 'react-native';
import { nativeLog } from '../../modules/splitcircle-media';
import {
  Video as VideoCompressor,
  getVideoMetaData,
  getImageMetaData,
} from 'react-native-compressor';

/**
 * Sentinel thrown when a picked asset's underlying file isn't actually
 * readable — iCloud download failed silently, the cache was purged, or the
 * picker handed back a stale `ph://` reference. Callers can map this to a
 * friendlier message in the failed-items sheet instead of the raw native
 * exception. */
export class MediaSourceUnavailableError extends Error {
  constructor(message = 'Media file is not available.') {
    super(message);
    this.name = 'MediaSourceUnavailableError';
  }
}

/**
 * Verify a picked asset is actually readable before we burn time on
 * compression. Only meaningful for `file://` URIs — for `ph://` /
 * `assets-library://` we trust the picker's `shouldDownloadFromNetwork`
 * option and let the downstream `copyAsync` raise if iCloud bailed.
 *
 * Throws `MediaSourceUnavailableError` so the chat send pipeline can show a
 * clear, user-facing reason instead of a stack trace from the native
 * compressor. */
export const ensureMediaSourceAvailable = async (uri: string): Promise<void> => {
  if (!uri) {
    throw new MediaSourceUnavailableError('Missing media path.');
  }
  // Web: blob:/data: URIs aren't backed by a file system — getInfoAsync is
  // unavailable. The upload path reads them via fetch() and surfaces errors
  // there instead.
  if (Platform.OS === 'web') {
    return;
  }
  // Photos-framework URIs are virtual — getInfoAsync doesn't apply. The
  // picker has already (best-effort) materialized them via
  // shouldDownloadFromNetwork. If iCloud still can't deliver, the next
  // file operation (copy/compress) raises naturally.
  if (uri.startsWith('ph://') || uri.startsWith('assets-library://')) {
    return;
  }
  try {
    const info = await getInfoAsync(uri);
    if (!info.exists) {
      throw new MediaSourceUnavailableError(
        'Source file is no longer available on this device. Pick it again.',
      );
    }
    if ('size' in info && info.size === 0) {
      throw new MediaSourceUnavailableError(
        'Source file is empty — the iCloud download may have failed. Try again on a stronger connection.',
      );
    }
  } catch (err) {
    if (err instanceof MediaSourceUnavailableError) throw err;
    throw new MediaSourceUnavailableError(
      'Could not read the source file. Pick it again or check your network.',
    );
  }
};

/** Best-effort byte size of a URI. Web reads blob:/data: URIs via fetch();
 *  native uses the file system. Never throws — returns 0 when unknown. */
const getUriByteSize = async (uri: string): Promise<number> => {
  if (Platform.OS === 'web') {
    try {
      const blob = await (await fetch(uri)).blob();
      return blob.size;
    } catch {
      return 0;
    }
  }
  try {
    const info = await getInfoAsync(uri);
    return info.exists && 'size' in info ? info.size : 0;
  } catch {
    return 0;
  }
};

/** No progress for this long during a transcode is worth recording. */
const STALL_WARN_MS = 30_000;

export type QualityLevel = 'HD' | 'SD' | 'ORIGINAL';
// Image targets: HD = 1920px max edge, SD = 1280px, ORIGINAL = no resize.
// Video targets: HD = 1280px max edge (720p), SD = 854px (~480p), ORIGINAL = no transcode.
// HD/SD mirror WhatsApp's "HD photos / videos" toggle behavior — `auto`
// compression in the native module picks an appropriate bitrate per platform.
//
// ORIGINAL answers the case the two-way toggle had no answer for: a receipt,
// a whiteboard, a screenshot of small text — anything where our resize is the
// thing that destroys the content's whole purpose. It is still subject to
// `UPLOAD_SIZE_LIMIT_BYTES`, so it is "don't degrade this", not "no limits".

/** Max edge in pixels for a quality level, or null when the source is kept as-is. */
const IMAGE_MAX_EDGE: Record<QualityLevel, number | null> = {
  HD: 1920,
  SD: 1280,
  ORIGINAL: null,
};

const VIDEO_MAX_EDGE: Record<QualityLevel, number | null> = {
  HD: 1280,
  SD: 854,
  ORIGINAL: null,
};

/** Formats every platform we target can decode without transcoding. Anything
 *  else (HEIC/HEIF from an iPhone camera, TIFF) must be converted even at
 *  ORIGINAL quality, or Android and web recipients get a file they cannot
 *  render at all — "original" must still mean "viewable". */
const UNIVERSALLY_DECODABLE = /\.(jpe?g|png|gif|webp)$/i;

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
    sourceFileSize = await getUriByteSize(uri);
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
  await ensureMediaSourceAvailable(uri);

  const maxDimension = IMAGE_MAX_EDGE[quality];
  const compressQuality = quality === 'HD' ? 0.8 : quality === 'SD' ? 0.6 : 0.95;

  const { meta: source } = await readImageSourceMetadata(uri);
  const { sourceWidth, sourceHeight } = source;

  // ORIGINAL on an already-portable format: hand back the untouched file.
  // Re-encoding a JPEG at 0.95 would be a second lossy generation that makes
  // the file BIGGER while making the image worse — the exact opposite of what
  // the user asked for by picking Original.
  if (maxDimension === null && UNIVERSALLY_DECODABLE.test(uri.split('?')[0])) {
    return {
      uri,
      width: sourceWidth,
      height: sourceHeight,
      size: source.sourceFileSize,
      ...source,
    };
  }

  const actions: ImageManipulator.Action[] = [];
  const longest = Math.max(sourceWidth, sourceHeight);
  if (maxDimension !== null && longest > 0 && longest > maxDimension) {
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
    const size = await getUriByteSize(result.uri);
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
  /** Receives an abort function once the native transcode has started. The
   *  caller wires this to the bubble's Cancel control; calling it makes
   *  `compress` reject, which we surface as `MediaSendCancelledError`. */
  onCancellable?: (cancel: () => void) => void,
): Promise<ProcessedVideo> => {
  await ensureMediaSourceAvailable(uri);

  // Web: react-native-compressor is native-only — send the original file.
  // Dimensions are read best-effort from an off-screen <video> element.
  if (Platform.OS === 'web') {
    const size = await getUriByteSize(uri);
    const dims = await new Promise<{ w: number; h: number }>((resolve) => {
      try {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () =>
          resolve({ w: video.videoWidth ?? 0, h: video.videoHeight ?? 0 });
        video.onerror = () => resolve({ w: 0, h: 0 });
        video.src = uri;
      } catch {
        resolve({ w: 0, h: 0 });
      }
    });
    onProgress?.(1);
    return {
      uri,
      width: dims.w,
      height: dims.h,
      size,
      sourceWidth: dims.w,
      sourceHeight: dims.h,
      sourceFileSize: size,
    };
  }

  const maxEdge = VIDEO_MAX_EDGE[quality];

  // Read the source dimensions / size up front so we can populate the result
  // even if compression bails. `getVideoMetaData` requires a real path, so
  // best-effort and don't block on errors.
  let srcWidth = 0;
  let srcHeight = 0;
  let srcSize = 0;
  // Duration drives the "is this already efficient?" check below — without it
  // there is no way to know what a transcode would even produce.
  let srcDurationSec = 0;
  try {
    const meta = await getVideoMetaData(uri);
    srcWidth = meta.width ?? 0;
    srcHeight = meta.height ?? 0;
    srcSize = meta.size ?? 0;
    srcDurationSec = meta.duration ?? 0;
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
  // ORIGINAL: the user explicitly asked us not to re-encode. Hand the source
  // through — the upload cap is still enforced downstream.
  if (maxEdge === null) {
    onProgress?.(1);
    return { uri, width: srcWidth, height: srcHeight, size: srcSize, ...sourceMeta };
  }

  // Don't re-encode a file that is already close to what we would produce.
  //
  // The old rule — skip only under a flat 25MB — meant a video that was
  // ALREADY at target resolution and already near our target bitrate got a
  // full transcode anyway, for a few percent off the file size and minutes of
  // the user's time. It hit trimmed clips hardest: the trimmer has just
  // written the file with `h264_videotoolbox`, and we then re-encoded that
  // output a second time. Two full hardware passes over the same video, the
  // second one buying almost nothing.
  //
  // The rule now compares against what compression would actually achieve. If
  // the source is within ~40% of the projected output AND already at or below
  // the resolution cap AND fits the upload limit, transcoding is not worth
  // what it costs. Anything genuinely oversized still compresses as before.
  const longestEdge = Math.max(srcWidth, srcHeight);
  const durationSec = srcDurationSec > 0 ? srcDurationSec : 0;
  // ORIGINAL already returned above (maxEdge === null), but TypeScript cannot
  // narrow the union from that check, so name the remaining cases explicitly.
  const targetBitrate = quality === 'SD' ? VIDEO_BITRATE_BPS.SD : VIDEO_BITRATE_BPS.HD;
  const projectedBytes = durationSec > 0 ? (targetBitrate * durationSec) / 8 : 0;
  const alreadyEfficient =
    projectedBytes > 0 && srcSize > 0 && srcSize <= projectedBytes * 1.4;
  const withinUploadCap = srcSize > 0 && srcSize <= UPLOAD_SIZE_LIMIT_BYTES;

  if (longestEdge > 0 && longestEdge <= maxEdge && withinUploadCap && alreadyEfficient) {
    nativeLog(
      `compress SKIPPED: ${Math.round(srcSize / 1048576)}MB at ${longestEdge}px is already near target ${Math.round(projectedBytes / 1048576)}MB`,
    );
    return { uri, width: srcWidth, height: srcHeight, size: srcSize, ...sourceMeta };
  }

  // Keep a background assertion alive for the transcode. Without one, the app
  // being backgrounded (a notification pulled down, the screen locking, a
  // glance at another app) suspends the process and the encode simply stops —
  // which presents as progress freezing at whatever percentage it had reached
  // and never resuming. That is the "it stalls, seemingly at random" report:
  // the trigger is incidental backgrounding, not the video.
  let backgroundTaskActive = false;
  try {
    await VideoCompressor.activateBackgroundTask();
    backgroundTaskActive = true;
  } catch (error) {
    // Not fatal — compression still works while the app stays foregrounded.
    console.warn('Could not start background task for compression', error);
  }

  // Watchdog for a genuinely wedged encoder. It cannot fix a stall, but a
  // silent freeze with no diagnosis is what made this expensive to chase.
  let lastProgressAt = Date.now();
  let lastFraction = 0;
  const stallWatch = setInterval(() => {
    const idleMs = Date.now() - lastProgressAt;
    if (idleMs > STALL_WARN_MS) {
      nativeLog(
        `compress STALL: no progress for ${Math.round(idleMs / 1000)}s at ${Math.round(lastFraction * 100)}% (${uri.split('/').pop()})`,
      );
    }
  }, STALL_WARN_MS);

  try {
    const compressedUri = await VideoCompressor.compress(
      uri,
      {
        compressionMethod: 'auto',
        maxSize: maxEdge,
        // Skip compression entirely for already-tiny clips so we don't
        // bloat 100KB videos to 500KB by re-encoding them.
        minimumFileSizeForCompress: 1, // MB
        // Report every ~2% instead of the default 0, which emits on EVERY
        // frame. A 3-minute clip is thousands of bridge crossings, each
        // driving a React state update, all competing with the encode itself
        // for the JS thread — the UI then updates so erratically that a
        // running transcode is indistinguishable from a dead one.
        progressDivider: 2,
        // The native module hands back the id it will accept a cancel for.
        // It arrives before the transcode begins, so wiring it here is what
        // makes a long compress abortable at all.
        getCancellationId: (cancellationId: string) => {
          onCancellable?.(() => {
            try {
              VideoCompressor.cancelCompression(cancellationId);
            } catch (error) {
              console.warn('cancelCompression threw', error);
            }
          });
        },
      },
      (progress) => {
        lastProgressAt = Date.now();
        lastFraction = progress;
        onProgress?.(progress);
      },
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
    nativeLog(`compress failed at ${Math.round(lastFraction * 100)}%: ${String(err)}`);
    return { uri, width: srcWidth, height: srcHeight, size: srcSize, ...sourceMeta };
  } finally {
    clearInterval(stallWatch);
    if (backgroundTaskActive) {
      // Must always be released — an un-deactivated assertion keeps the app
      // alive in the background until iOS kills it outright.
      try {
        await VideoCompressor.deactivateBackgroundTask();
      } catch (error) {
        console.warn('Could not end background task for compression', error);
      }
    }
  }
};

// ─── Preflight size estimation ───────────────────────────────────────────────
//
// These approximate the post-process file size *before* we burn time on the
// actual compression. They feed the MediaPreview's per-item "fits / SD-only /
// won't fit" badges so the user can fix oversize items (switch quality or
// trim) up front instead of waiting through compression+upload to see a
// "File too large" error.
//
// Bitrate targets are conservative — the goal is to *not* falsely promise
// that an item fits. If the real compressor undershoots, the user just gets a
// smaller file than estimated; if we underestimate, they get a wasted upload.

/** Target video bitrate (bits/sec) for our two quality levels.
 *  Numbers reflect what `react-native-compressor`'s `auto` mode tends to
 *  produce on iOS/Android for the given resolution caps, plus ~128 kbps audio. */
const VIDEO_BITRATE_BPS: Record<Exclude<QualityLevel, 'ORIGINAL'>, number> = {
  HD: 2_500_000, // 720p H.264 ≈ 2.4 Mbps + 128 kbps audio
  SD: 1_100_000, // 480p H.264 ≈ 1.0 Mbps + 128 kbps audio
};

/** Approximate the post-compression size in bytes for an image. We resize the
 *  longest edge to `maxEdge` and JPEG-encode at a quality factor; bytes per
 *  pixel for a typical JPEG-quality-0.6/0.8 photo is roughly 0.25–0.4. */
const IMAGE_BYTES_PER_PIXEL: Record<Exclude<QualityLevel, 'ORIGINAL'>, number> = {
  HD: 0.40,
  SD: 0.25,
};

interface EstimateInput {
  type: 'image' | 'video' | 'camera' | string;
  /** Source dims in display space (post-EXIF orientation). */
  width?: number;
  height?: number;
  /** Source file size in bytes. */
  fileSize?: number;
  /** For videos: duration in milliseconds (matches expo-image-picker's `duration`). */
  duration?: number;
}

/**
 * Project the size we'd actually upload for `item` at `quality`. Returns
 * `null` when we don't have enough metadata to guess (e.g. unknown duration
 * for a video) — callers should treat null as "can't tell, let it through."
 */
export const estimateProcessedSize = (
  item: EstimateInput,
  quality: QualityLevel,
): number | null => {
  const isVideo = item.type === 'video';
  const isImage = item.type === 'image' || item.type === 'camera';

  // ORIGINAL performs no re-encode, so what we upload is exactly the source.
  // Without a known source size there is nothing to project — `null` means
  // "can't tell", and the upload cap becomes the only enforcement.
  if (quality === 'ORIGINAL') {
    return item.fileSize ?? null;
  }

  if (isVideo) {
    if (!item.duration || item.duration <= 0) return null;
    const durationSec = item.duration / 1000;
    const projected = Math.round(VIDEO_BITRATE_BPS[quality] * durationSec / 8);
    // Compression can only ever make things smaller in our pipeline (we
    // fall back to the source when the encoder produces a larger file).
    if (item.fileSize && projected > item.fileSize) return item.fileSize;
    return projected;
  }

  if (isImage) {
    if (!item.width || !item.height) {
      return item.fileSize ?? null;
    }
    const maxEdge = quality === 'HD' ? 1920 : 1280;
    const longest = Math.max(item.width, item.height);
    const ratio = longest > maxEdge ? maxEdge / longest : 1;
    const targetW = item.width * ratio;
    const targetH = item.height * ratio;
    const projected = Math.round(targetW * targetH * IMAGE_BYTES_PER_PIXEL[quality]);
    if (item.fileSize && projected > item.fileSize) return item.fileSize;
    return projected;
  }

  // Documents / audio: no processing, source size is what gets uploaded.
  return item.fileSize ?? null;
};

/** Bytes cap that mirrors `MAX_FILE_SIZE` in mediaService. Kept here so the
 *  estimator and the upload-time guard agree. Update both together. */
export const UPLOAD_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;

export type FitStatus = 'fits' | 'sd_only' | 'oversize' | 'unknown';

/**
 * Classify an item's preflight status across both qualities. `unknown` means
 * we couldn't estimate (missing duration on a video, etc.) and the upload
 * cap will be the only enforcement.
 */
export const classifyFit = (item: EstimateInput): FitStatus => {
  const hd = estimateProcessedSize(item, 'HD');
  const sd = estimateProcessedSize(item, 'SD');
  if (hd === null && sd === null) return 'unknown';
  const hdFits = hd !== null && hd <= UPLOAD_SIZE_LIMIT_BYTES;
  const sdFits = sd !== null && sd <= UPLOAD_SIZE_LIMIT_BYTES;
  if (hdFits) return 'fits';
  if (sdFits) return 'sd_only';
  return 'oversize';
};
