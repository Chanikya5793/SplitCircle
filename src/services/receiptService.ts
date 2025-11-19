import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from '@/firebase';

export const uploadReceipt = async (uri: string, groupId: string): Promise<string> => {
  const response = await fetch(uri);
  const blob = await response.blob();
  const storageRef = ref(storage, `receipts/${groupId}/${Date.now()}`);
  await uploadBytes(storageRef, blob);
  return getDownloadURL(storageRef);
};
