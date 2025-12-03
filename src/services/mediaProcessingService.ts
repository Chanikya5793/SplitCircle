import { getInfoAsync } from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';

export type QualityLevel = 'HD' | 'SD'; // HD = 1080p, SD = 720p

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

    const result = await ImageManipulator.manipulateAsync(
      uri,
      actions,
      {
        compress: compressQuality,
        format: ImageManipulator.SaveFormat.JPEG,
      }
    );

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
    throw error;
  }
};

/**
 * Process a video: resize and compress to MP4
 * Currently a pass-through as we lack native transcoding libraries in this environment.
 */
export const processVideo = async (
  uri: string,
  quality: QualityLevel
): Promise<ProcessedMedia> => {
  // We can check file info
  const fileInfo = await getInfoAsync(uri);
  const size = fileInfo.exists && 'size' in fileInfo ? fileInfo.size : 0;
  
  return {
    uri: uri,
    width: 0, // Unknown without extra tools
    height: 0,
    size,
  };
};
