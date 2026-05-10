import { getInfoAsync } from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';
import { Video as VideoCompressor, getVideoMetaData } from 'react-native-compressor';

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

/**
 * Process an image: resize and compress to JPEG
 */
export const processImage = async (
  uri: string,
  quality: QualityLevel
): Promise<ProcessedMedia> => {
  try {
    // Target max dimension (width or height)
    // HD: 1920 pixels
    // SD: 1280 pixels
    const maxDimension = quality === 'HD' ? 1920 : 1280;
    const compressQuality = quality === 'HD' ? 0.8 : 0.6;

    // Get original dimensions to calculate resize target
    const { width, height } = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      Image.getSize(
        uri,
        (w, h) => resolve({ width: w, height: h }),
        (error) => reject(error)
      );
    });

    const actions: ImageManipulator.Action[] = [];

    // Only resize if the image is larger than our target
    if (width > maxDimension || height > maxDimension) {
      let newWidth = width;
      let newHeight = height;

      if (width > height) {
        // Landscape
        if (width > maxDimension) {
          newWidth = maxDimension;
          newHeight = (height / width) * maxDimension;
        }
      } else {
        // Portrait or Square
        if (height > maxDimension) {
          newHeight = maxDimension;
          newWidth = (width / height) * maxDimension;
        }
      }
      
      actions.push({ resize: { width: newWidth, height: newHeight } });
    }

    let result;
    try {
      result = await ImageManipulator.manipulateAsync(
        uri,
        actions,
        {
          compress: compressQuality,
          format: ImageManipulator.SaveFormat.JPEG,
        }
      );
    } catch (manipulationError) {
      console.warn('Image manipulation failed, falling back to original:', manipulationError);
      // Fallback to original image if manipulation fails (e.g. context lost)
      const fileInfo = await getInfoAsync(uri);
      const size = fileInfo.exists && 'size' in fileInfo ? fileInfo.size : 0;
      return {
        uri,
        width,
        height,
        size,
      };
    }

    // Check file size
    const fileInfo = await getInfoAsync(result.uri);
    const size = fileInfo.exists && 'size' in fileInfo ? fileInfo.size : 0;

    return {
      uri: result.uri,
      width: result.width,
      height: result.height,
      size,
    };
  } catch (error) {
    console.error('Image processing error:', error);
    // If even the fallback fails (e.g. Image.getSize fails), rethrow
    throw error;
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
): Promise<ProcessedMedia> => {
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

  // If the video is already smaller than our cap, skip transcoding entirely.
  // The native module would still re-encode and likely make the file *larger*
  // for already-tiny clips (the screenshot's 360×480 case).
  const longestEdge = Math.max(srcWidth, srcHeight);
  if (longestEdge > 0 && longestEdge <= maxEdge) {
    return { uri, width: srcWidth, height: srcHeight, size: srcSize };
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
      return { uri, width: srcWidth, height: srcHeight, size: srcSize };
    }

    return { uri: compressedUri, width: outWidth, height: outHeight, size: outSize };
  } catch (err) {
    console.warn('Video compression failed, sending original:', err);
    return { uri, width: srcWidth, height: srcHeight, size: srcSize };
  }
};
