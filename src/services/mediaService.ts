/**
 * Media Service
 * 
 * Handles all media operations for chat:
 * - Uploading media to Firebase Storage
 * - Downloading media to local storage
 * - Managing local media cache
 */

import {
  copyAsync,
  deleteAsync,
  documentDirectory,
  downloadAsync,
  FileSystemUploadType,
  getInfoAsync,
  makeDirectoryAsync,
  uploadAsync,
} from 'expo-file-system/legacy';
import { getDownloadURL, getStorage, ref as storageRef } from 'firebase/storage';

const storage = getStorage();

// Directory for storing downloaded chat media
export const MEDIA_DIRECTORY = `${documentDirectory}chat_media/`;

// Maximum file size for upload (50MB)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

export interface MediaUploadResult {
  downloadUrl: string;
  storagePath: string;
  localPath: string;
}

export interface MediaDownloadResult {
  localPath: string;
  fileExists: boolean;
}

/**
 * Initialize the media storage directory
 */
export const initMediaDirectory = async (): Promise<void> => {
  try {
    const dirInfo = await getInfoAsync(MEDIA_DIRECTORY);
    if (!dirInfo.exists) {
      await makeDirectoryAsync(MEDIA_DIRECTORY, { intermediates: true });
      console.log('✅ Media directory created:', MEDIA_DIRECTORY);
    }
  } catch (error) {
    console.error('❌ Failed to initialize media directory:', error);
  }
};

/**
 * Get the local path for a media file
 */
export const getLocalMediaPath = (chatId: string, messageId: string, fileName: string): string => {
  // Sanitize filename to remove special characters
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${MEDIA_DIRECTORY}${chatId}/${messageId}_${sanitizedFileName}`;
};

/**
 * Check if a media file exists locally
 */
export const mediaExistsLocally = async (localPath: string): Promise<boolean> => {
  try {
    const fileInfo = await getInfoAsync(localPath);
    return fileInfo.exists;
  } catch (error) {
    return false;
  }
};

/**
 * Copy a file to local media storage (for sender's own media)
 */
export const copyToLocalStorage = async (
  sourceUri: string,
  chatId: string,
  messageId: string,
  fileName: string
): Promise<string> => {
  try {
    // Ensure chat directory exists
    const chatDir = `${MEDIA_DIRECTORY}${chatId}/`;
    const chatDirInfo = await getInfoAsync(chatDir);
    if (!chatDirInfo.exists) {
      await makeDirectoryAsync(chatDir, { intermediates: true });
    }
    
    const localPath = getLocalMediaPath(chatId, messageId, fileName);
    
    // If source is already the destination, just return
    if (sourceUri === localPath) {
      console.log('✅ Media already in local storage:', localPath);
      return localPath;
    }

    // Copy file from source to local storage
    await copyAsync({
      from: sourceUri,
      to: localPath,
    });
    
    console.log('✅ Media copied to local storage:', localPath);
    return localPath;
  } catch (error) {
    console.error('❌ Error copying to local storage:', error);
    throw error;
  }
};

/**
 * Upload media to Firebase Storage using expo-file-system
 * Returns the download URL and storage path
 */
export const uploadMedia = async (
  uri: string,
  chatId: string,
  messageId: string,
  fileName: string,
  mimeType: string,
  onProgress?: (progress: number) => void
): Promise<MediaUploadResult> => {
  try {
    console.log('📤 Starting media upload:', { uri, chatId, messageId, fileName, mimeType });
    
    // First, copy to local storage for sender (if not already there)
    const localPath = await copyToLocalStorage(uri, chatId, messageId, fileName);
    
    // Use the local copy for upload (handles ph:// and content:// URIs)
    const fileUri = localPath;
    
    // Check file size
    const fileInfo = await getInfoAsync(fileUri);
    if (fileInfo.exists && 'size' in fileInfo && fileInfo.size > MAX_FILE_SIZE) {
      throw new Error(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`);
    }
    
    // Create storage reference and get upload URL
    const storagePath = `chat_media/${chatId}/${messageId}/${fileName}`;
    const fileRef = storageRef(storage, storagePath);
    
    // Get the upload URL for direct upload
    // We'll use Firebase Storage REST API through expo-file-system
    const uploadUrl = `https://firebasestorage.googleapis.com/v0/b/${storage.app.options.storageBucket}/o?uploadType=media&name=${encodeURIComponent(storagePath)}`;
    
    // Get auth token for the upload
    const { getAuth } = await import('firebase/auth');
    const auth = getAuth();
    const token = await auth.currentUser?.getIdToken();
    
    if (!token) {
      throw new Error('Not authenticated. Please sign in to upload media.');
    }
    
    console.log('📤 Uploading to Firebase Storage...');
    onProgress?.(10);
    
    // Upload using expo-file-system
    const uploadResult = await uploadAsync(uploadUrl, fileUri, {
      httpMethod: 'POST',
      uploadType: FileSystemUploadType.BINARY_CONTENT,
      headers: {
        'Authorization': `Firebase ${token}`,
        'Content-Type': mimeType,
      },
    });
    
    onProgress?.(90);
    
    if (uploadResult.status !== 200) {
      console.error('Upload response:', uploadResult.body);
      throw new Error(`Upload failed with status ${uploadResult.status}`);
    }
    
    // Get the download URL
    const downloadUrl = await getDownloadURL(fileRef);
    
    console.log('✅ Upload complete:', downloadUrl);
    onProgress?.(100);
    
    return {
      downloadUrl,
      storagePath,
      localPath,
    };
  } catch (error) {
    console.error('❌ Media upload error:', error);
    throw error;
  }
};

/**
 * Download media from URL to local storage
 */
export const downloadMedia = async (
  downloadUrl: string,
  chatId: string,
  messageId: string,
  fileName: string
): Promise<MediaDownloadResult> => {
  try {
    const localPath = getLocalMediaPath(chatId, messageId, fileName);
    
    // Check if already downloaded
    const exists = await mediaExistsLocally(localPath);
    if (exists) {
      console.log('📦 Media already exists locally:', localPath);
      return { localPath, fileExists: true };
    }
    
    // Ensure chat directory exists
    const chatDir = `${MEDIA_DIRECTORY}${chatId}/`;
    const chatDirInfo = await getInfoAsync(chatDir);
    if (!chatDirInfo.exists) {
      await makeDirectoryAsync(chatDir, { intermediates: true });
    }
    
    console.log('📥 Downloading media to:', localPath);
    
    // Download the file
    const downloadResult = await downloadAsync(downloadUrl, localPath);
    
    if (downloadResult.status !== 200) {
      throw new Error(`Download failed with status ${downloadResult.status}`);
    }
    
    console.log('✅ Media downloaded:', localPath);
    return { localPath, fileExists: true };
  } catch (error) {
    console.error('❌ Media download error:', error);
    throw error;
  }
};

/**
 * Get local path for a media message, downloading if necessary
 */
export const getOrDownloadMedia = async (
  downloadUrl: string | undefined,
  localPath: string | undefined,
  chatId: string,
  messageId: string,
  fileName: string
): Promise<string | null> => {
  try {
    // First check if we have a local path and it exists
    if (localPath) {
      const exists = await mediaExistsLocally(localPath);
      if (exists) {
        return localPath;
      }
    }
    
    // No local file, need to download
    if (!downloadUrl) {
      console.warn('No download URL available for media');
      return null;
    }
    
    const result = await downloadMedia(downloadUrl, chatId, messageId, fileName);
    return result.localPath;
  } catch (error) {
    console.error('❌ Error getting/downloading media:', error);
    return null;
  }
};

/**
 * Delete a local media file
 */
export const deleteLocalMedia = async (localPath: string): Promise<void> => {
  try {
    await deleteAsync(localPath, { idempotent: true });
    console.log('✅ Local media deleted:', localPath);
  } catch (error) {
    console.error('❌ Error deleting local media:', error);
  }
};

/**
 * Clear all media for a specific chat
 */
export const clearChatMedia = async (chatId: string): Promise<void> => {
  try {
    const chatDir = `${MEDIA_DIRECTORY}${chatId}/`;
    await deleteAsync(chatDir, { idempotent: true });
    console.log('✅ Chat media cleared:', chatId);
  } catch (error) {
    console.error('❌ Error clearing chat media:', error);
  }
};

/**
 * Get file extension from mime type
 */
export const getExtensionFromMimeType = (mimeType: string): string => {
  const mimeToExt: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'text/plain': '.txt',
    'application/zip': '.zip',
    'application/x-rar-compressed': '.rar',
  };
  
  return mimeToExt[mimeType] || '';
};

/**
 * Generate a filename for media
 */
export const generateMediaFileName = (
  type: 'image' | 'video' | 'audio' | 'document' | 'file',
  mimeType: string,
  originalFileName?: string
): string => {
  if (originalFileName) {
    return originalFileName;
  }
  
  const timestamp = Date.now();
  const ext = getExtensionFromMimeType(mimeType);
  
  switch (type) {
    case 'image':
      return `IMG_${timestamp}${ext || '.jpg'}`;
    case 'video':
      return `VID_${timestamp}${ext || '.mp4'}`;
    case 'audio':
      return `AUD_${timestamp}${ext || '.mp3'}`;
    default:
      return `DOC_${timestamp}${ext || ''}`;
  }
};
