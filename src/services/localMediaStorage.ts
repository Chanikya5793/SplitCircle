/**
 * Local Media Storage Service
 * 
 * Handles storing media files (images, videos, documents, audio) in the device's local file system.
 * Media is stored temporarily in Firebase Realtime Database until the recipient downloads it,
 * then it's deleted from the database and kept only in local storage.
 */

import {
    cacheDirectory,
    copyAsync,
    deleteAsync,
    documentDirectory,
    EncodingType,
    getInfoAsync,
    makeDirectoryAsync,
    readAsStringAsync,
    writeAsStringAsync,
} from 'expo-file-system/legacy';
import { get, getDatabase, ref, remove, set } from 'firebase/database';

const rtdb = getDatabase();

// Directory for storing chat media
const MEDIA_DIRECTORY = `${documentDirectory}chat_media/`;

// Maximum file size for base64 encoding (5MB) - larger files need chunking
const MAX_BASE64_SIZE = 5 * 1024 * 1024;

/**
 * Initialize the media storage directory
 */
export const initMediaStorage = async (): Promise<void> => {
  try {
    const dirInfo = await getInfoAsync(MEDIA_DIRECTORY);
    if (!dirInfo.exists) {
      await makeDirectoryAsync(MEDIA_DIRECTORY, { intermediates: true });
      console.log('✅ Media storage directory created:', MEDIA_DIRECTORY);
    }
  } catch (error) {
    console.error('❌ Failed to initialize media storage:', error);
    throw error;
  }
};

/**
 * Get the local path for a media file
 */
export const getLocalMediaPath = (chatId: string, messageId: string, fileName: string): string => {
  return `${MEDIA_DIRECTORY}${chatId}/${messageId}_${fileName}`;
};

/**
 * Check if a media file exists locally
 */
export const mediaExistsLocally = async (chatId: string, messageId: string, fileName: string): Promise<boolean> => {
  try {
    const localPath = getLocalMediaPath(chatId, messageId, fileName);
    const fileInfo = await getInfoAsync(localPath);
    return fileInfo.exists;
  } catch (error) {
    console.error('❌ Error checking if media exists locally:', error);
    return false;
  }
};

/**
 * Save media file to local storage from a URI (for sender)
 * Returns the local file path
 */
export const saveMediaLocally = async (
  chatId: string,
  messageId: string,
  sourceUri: string,
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
    
    // Copy file from source to local storage
    await copyAsync({
      from: sourceUri,
      to: localPath,
    });
    
    console.log('✅ Media saved locally:', localPath);
    return localPath;
  } catch (error) {
    console.error('❌ Error saving media locally:', error);
    throw error;
  }
};

/**
 * Save media file to local storage from base64 data (for receiver)
 * Returns the local file path
 */
export const saveMediaFromBase64 = async (
  chatId: string,
  messageId: string,
  base64Data: string,
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
    
    // Write base64 data to file
    await writeAsStringAsync(localPath, base64Data, {
      encoding: EncodingType.Base64,
    });
    
    console.log('✅ Media saved from base64:', localPath);
    return localPath;
  } catch (error) {
    console.error('❌ Error saving media from base64:', error);
    throw error;
  }
};

/**
 * Read a local file as base64 (for sending via RTDB)
 */
export const readFileAsBase64 = async (uri: string): Promise<string> => {
  try {
    // Handle different URI schemes
    let fileUri = uri;
    
    // For content:// or ph:// URIs, we need to use a different approach
    if (uri.startsWith('content://') || uri.startsWith('ph://')) {
      // First copy to a temp location with file:// scheme
      const tempPath = `${cacheDirectory}temp_${Date.now()}`;
      await copyAsync({ from: uri, to: tempPath });
      fileUri = tempPath;
    }
    
    const base64 = await readAsStringAsync(fileUri, {
      encoding: EncodingType.Base64,
    });
    
    // Clean up temp file if we created one
    if (fileUri !== uri) {
      await deleteAsync(fileUri, { idempotent: true });
    }
    
    return base64;
  } catch (error) {
    console.error('❌ Error reading file as base64:', error);
    throw error;
  }
};

/**
 * Get file size in bytes
 */
export const getFileSize = async (uri: string): Promise<number> => {
  try {
    const fileInfo = await getInfoAsync(uri);
    if (fileInfo.exists && 'size' in fileInfo) {
      return fileInfo.size;
    }
    return 0;
  } catch (error) {
    console.error('❌ Error getting file size:', error);
    return 0;
  }
};

/**
 * Store media data temporarily in Firebase Realtime Database
 * This is for the recipient to download
 */
export const storeMediaInRTDB = async (
  recipientId: string,
  messageId: string,
  base64Data: string,
  fileName: string,
  mimeType: string,
  fileSize: number
): Promise<void> => {
  try {
    const mediaRef = ref(rtdb, `mediaQueue/${recipientId}/${messageId}`);
    
    await set(mediaRef, {
      base64Data,
      fileName,
      mimeType,
      fileSize,
      timestamp: Date.now(),
    });
    
    console.log('✅ Media stored in RTDB for recipient:', recipientId);
  } catch (error) {
    console.error('❌ Error storing media in RTDB:', error);
    throw error;
  }
};

/**
 * Fetch media data from Firebase Realtime Database
 */
export const fetchMediaFromRTDB = async (
  userId: string,
  messageId: string
): Promise<{ base64Data: string; fileName: string; mimeType: string; fileSize: number } | null> => {
  try {
    const mediaRef = ref(rtdb, `mediaQueue/${userId}/${messageId}`);
    const snapshot = await get(mediaRef);
    
    if (snapshot.exists()) {
      const data = snapshot.val();
      return {
        base64Data: data.base64Data,
        fileName: data.fileName,
        mimeType: data.mimeType,
        fileSize: data.fileSize,
      };
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error fetching media from RTDB:', error);
    return null;
  }
};

/**
 * Delete media from Firebase Realtime Database after download
 */
export const deleteMediaFromRTDB = async (
  userId: string,
  messageId: string
): Promise<void> => {
  try {
    const mediaRef = ref(rtdb, `mediaQueue/${userId}/${messageId}`);
    await remove(mediaRef);
    console.log('✅ Media deleted from RTDB:', messageId);
  } catch (error) {
    console.error('❌ Error deleting media from RTDB:', error);
  }
};

/**
 * Download and save media for a received message
 * Returns the local file path, or null if no media to download
 */
export const downloadAndSaveMedia = async (
  userId: string,
  chatId: string,
  messageId: string
): Promise<string | null> => {
  try {
    // Fetch media from RTDB
    const mediaData = await fetchMediaFromRTDB(userId, messageId);
    
    if (!mediaData) {
      console.log('📭 No media to download for message:', messageId);
      return null;
    }
    
    // Save to local storage
    const localPath = await saveMediaFromBase64(
      chatId,
      messageId,
      mediaData.base64Data,
      mediaData.fileName
    );
    
    // Delete from RTDB after successful download
    await deleteMediaFromRTDB(userId, messageId);
    
    console.log('✅ Media downloaded and saved:', localPath);
    return localPath;
  } catch (error) {
    console.error('❌ Error downloading and saving media:', error);
    return null;
  }
};

/**
 * Get the local URI for a media file (for display in UI)
 * Returns the file:// URI if file exists locally, null otherwise
 */
export const getLocalMediaUri = async (
  chatId: string,
  messageId: string,
  fileName: string
): Promise<string | null> => {
  try {
    const localPath = getLocalMediaPath(chatId, messageId, fileName);
    const fileInfo = await getInfoAsync(localPath);
    
    if (fileInfo.exists) {
      return localPath;
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error getting local media URI:', error);
    return null;
  }
};

/**
 * Delete a local media file
 */
export const deleteLocalMedia = async (
  chatId: string,
  messageId: string,
  fileName: string
): Promise<void> => {
  try {
    const localPath = getLocalMediaPath(chatId, messageId, fileName);
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
 * Get total size of locally stored media
 */
export const getLocalMediaSize = async (): Promise<number> => {
  try {
    const dirInfo = await getInfoAsync(MEDIA_DIRECTORY);
    if (!dirInfo.exists) return 0;
    
    // This is a simplified version - for production, you'd want to recursively sum file sizes
    return 0; // expo-file-system doesn't provide directory size directly
  } catch (error) {
    console.error('❌ Error getting local media size:', error);
    return 0;
  }
};
