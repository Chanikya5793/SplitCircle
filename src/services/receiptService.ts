import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from '@/firebase';

export const uploadReceipt = async (uri: string, groupId: string): Promise<string> => {
  const safeGroupId = groupId.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  if (!safeGroupId) {
    throw new Error('Invalid group ID for receipt upload.');
  }

  const lower = uri.toLowerCase();
  if (
    !lower.startsWith('file:')
    && !lower.startsWith('content:')
    && !lower.startsWith('ph:')
    && !lower.startsWith('assets-library:')
  ) {
    throw new Error('Unsupported receipt URI.');
  }

  const response = await fetch(uri);
  const blob = await response.blob();
  const storageRef = ref(storage, `receipts/${safeGroupId}/${Date.now()}`);
  await uploadBytes(storageRef, blob);
  return getDownloadURL(storageRef);
};
