import { storage } from '../firebase/firebaseConfig';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';

const sanitizeStoragePath = (path: string): string => {
  return path
    .split('/')
    .map((segment) => segment.trim().replace(/[^a-zA-Z0-9._-]/g, '_'))
    .filter((segment) => segment.length > 0)
    .join('/');
};

const isAllowedUploadUri = (uri: string): boolean => {
  const lower = uri.toLowerCase();
  return lower.startsWith('file:')
    || lower.startsWith('content:')
    || lower.startsWith('ph:')
    || lower.startsWith('assets-library:');
};

const guessContentType = (uri: string): string | undefined => {
  const normalized = uri.toLowerCase();
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.heic') || normalized.endsWith('.heif')) return 'image/heic';
  if (normalized.endsWith('.pdf')) return 'application/pdf';
  if (normalized.endsWith('.mp4')) return 'video/mp4';
  if (normalized.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (normalized.endsWith('.txt')) return 'text/plain';
  return undefined;
};

/**
 * Convert URI to Blob using XMLHttpRequest (React Native compatible)
 */
const getBlobFromUri = async (uri: string): Promise<Blob> => {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.onload = function () {
      resolve(xhr.response);
    };
    xhr.onerror = function (e) {
      reject(new TypeError('Network request failed'));
    };
    xhr.responseType = 'blob';
    xhr.open('GET', uri, true);
    xhr.send(null);
  });
};

export const uploadFile = async (uri: string, path: string): Promise<string> => {
  try {
    if (!isAllowedUploadUri(uri)) {
      throw new Error('Unsupported upload URI.');
    }

    const sanitizedPath = sanitizeStoragePath(path);
    if (!sanitizedPath) {
      throw new Error('Invalid storage path.');
    }

    console.log('Uploading file to storage path:', sanitizedPath);
    const storageRef = ref(storage, sanitizedPath);
    const metadata: any = {};
    const contentType = guessContentType(uri);
    if (contentType) {
      metadata.contentType = contentType;
    }

    // Convert URI to Blob using XMLHttpRequest (React Native compatible)
    const blob = await getBlobFromUri(uri);
    await uploadBytes(storageRef, blob, metadata);

    const downloadUrl = await getDownloadURL(storageRef);
    return downloadUrl;
  } catch (error) {
    console.error('Error uploading file:', error);
    throw error;
  }
};

export const deleteFile = async (path: string): Promise<void> => {
  try {
    const { deleteObject } = await import('firebase/storage');
    const sanitizedPath = sanitizeStoragePath(path);
    if (!sanitizedPath) {
      throw new Error('Invalid storage path.');
    }
    const storageRef = ref(storage, sanitizedPath);
    await deleteObject(storageRef);
  } catch (error) {
    console.error('Error deleting file:', error);
    throw error;
  }
};
