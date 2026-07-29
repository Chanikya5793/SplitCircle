/**
 * Shared attachment policy for cloud and nearby transports.
 *
 * Keeping this pure (no Firebase or React Native imports) lets the signed
 * nearby-manifest parser enforce the exact same limits as Firebase Storage.
 */
export const MEDIA_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

const ALLOWED_MEDIA_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/flac',
  'audio/x-flac',
  'audio/x-wav',
  'audio/3gpp',
  'audio/amr',
  'application/octet-stream',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'application/zip',
  'application/x-rar-compressed',
]);

export const isAllowedMediaMimeType = (value: unknown): value is string =>
  typeof value === 'string'
  && ALLOWED_MEDIA_MIME_TYPES.has(value.trim().toLowerCase());

export const normalizeAllowedMediaMimeType = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!ALLOWED_MEDIA_MIME_TYPES.has(normalized)) {
    throw new Error(`Unsupported media type: ${value}`);
  }
  return normalized;
};
