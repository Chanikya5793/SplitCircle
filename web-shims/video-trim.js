// Web shim for react-native-video-trim, whose TurboModule spec calls
// TurboModuleRegistry.getEnforcing at import time and crashes the web bundle.
// Video trimming is a native-only feature; these no-ops keep web alive.

export const showEditor = () => {
  throw new Error('Video trimming is not available on web');
};
export const closeEditor = () => undefined;
export const deleteFile = async () => false;
export const isValidFile = async () => false;
export const listFiles = async () => [];
export const cleanFiles = async () => 0;

export default {
  showEditor,
  closeEditor,
  deleteFile,
  isValidFile,
  listFiles,
  cleanFiles,
};
