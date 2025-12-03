/**
 * Media Processing Service - Simplified
 * 
 * This service handles media preparation for upload.
 * It passes through the original URIs without modification to avoid
 * iOS PHPhotosErrorDomain errors that occur when trying to manipulate
 * assets directly from the Photos Library.
 */

export type MediaQuality = 'SD' | 'HD' | 'original';

export interface ProcessingProgress {
  stage: 'preparing' | 'uploading' | 'complete' | 'error';
  progress: number;
  message: string;
}

export interface MediaInfo {
  uri: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  width?: number;
  height?: number;
  duration?: number;
}

/**
 * Prepare media for upload - simply returns the info needed for upload
 * No actual processing is done to avoid iOS errors
 */
export function prepareMediaForUpload(
  uri: string,
  type: 'image' | 'video' | 'audio' | 'document',
  fileName?: string,
  mimeType?: string,
): MediaInfo {
  const timestamp = Date.now();
  
  // Generate appropriate filename and mime type based on media type
  let finalFileName: string;
  let finalMimeType: string;
  
  switch (type) {
    case 'image':
      finalFileName = fileName || `image_${timestamp}.jpg`;
      finalMimeType = mimeType || 'image/jpeg';
      break;
    case 'video':
      finalFileName = fileName || `video_${timestamp}.mp4`;
      finalMimeType = mimeType || 'video/mp4';
      break;
    case 'audio':
      finalFileName = fileName || `audio_${timestamp}.mp3`;
      finalMimeType = mimeType || 'audio/mpeg';
      break;
    case 'document':
    default:
      finalFileName = fileName || `file_${timestamp}`;
      finalMimeType = mimeType || 'application/octet-stream';
      break;
  }
  
  return {
    uri,
    fileName: finalFileName,
    mimeType: finalMimeType,
  };
}

/**
 * Get mime type from file extension
 */
export function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    // Videos
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    m4v: 'video/x-m4v',
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain',
    zip: 'application/zip',
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
  };
  return mimeTypes[ext || ''] || 'application/octet-stream';
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
