import { db } from '@/firebase';
import { callsCollection } from '@/firebase/queries';
import type { CallParticipant, CallSession, CallStatus, CallType } from '@/models';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  where,
  type Unsubscribe
} from 'firebase/firestore';

// ICE servers configuration for STUN/TURN
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

export interface CallServiceConfig {
  chatId: string;
  groupId?: string;
  userId: string;
  displayName: string;
  photoURL?: string;
}

/**
 * Create a new call session in Firestore
 */
export async function createCallSession(
  config: CallServiceConfig,
  type: CallType,
  offer: RTCSessionDescriptionInit
): Promise<string> {
  const participant: CallParticipant = {
    userId: config.userId,
    displayName: config.displayName,
    muted: false,
    cameraEnabled: type === 'video',
    ...(config.photoURL ? { photoURL: config.photoURL } : {}),
  };

  const callSession: Omit<CallSession, 'callId'> = {
    chatId: config.chatId,
    initiatorId: config.userId,
    participants: [participant],
    type,
    status: 'ringing',
    startedAt: Date.now(),
    offer,
    ...(config.groupId ? { groupId: config.groupId } : {}),
  };

  const docRef = await addDoc(callsCollection, callSession);
  return docRef.id;
}

/**
 * Get a call session by ID
 */
export async function getCallSession(callId: string): Promise<CallSession | null> {
  const docRef = doc(db, 'calls', callId);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    return null;
  }
  return { ...docSnap.data(), callId: docSnap.id } as CallSession;
}

/**
 * Update call session status
 */
export async function updateCallStatus(callId: string, status: CallStatus): Promise<void> {
  const docRef = doc(db, 'calls', callId);
  const updateData: Partial<CallSession> = { status };
  
  if (status === 'ended') {
    updateData.endedAt = Date.now();
    
    // Calculate duration if call was connected
    const callDoc = await getDoc(docRef);
    if (callDoc.exists()) {
      const callData = callDoc.data() as CallSession;
      if (callData.connectedAt) {
        updateData.duration = Math.floor((Date.now() - callData.connectedAt) / 1000);
      }
    }
  } else if (status === 'connected') {
    updateData.connectedAt = Date.now();
  }
  
  await updateDoc(docRef, updateData);
}

/**
 * Set the answer for a call session
 */
export async function setCallAnswer(callId: string, answer: RTCSessionDescriptionInit): Promise<void> {
  const docRef = doc(db, 'calls', callId);
  await updateDoc(docRef, {
    answer,
    status: 'connected',
    connectedAt: Date.now(),
  } satisfies Partial<CallSession>);
}

/**
 * Add ICE candidate to call session
 */
export async function addIceCandidate(
  callId: string,
  candidate: RTCIceCandidateInit,
  isOffer: boolean
): Promise<void> {
  const candidatesPath = isOffer ? 'offerCandidates' : 'answerCandidates';
  const candidatesRef = collection(db, 'calls', callId, candidatesPath);
  await addDoc(candidatesRef, candidate);
}

/**
 * Subscribe to call session changes
 */
export function subscribeToCallSession(
  callId: string,
  callback: (session: CallSession | null) => void
): Unsubscribe {
  const docRef = doc(db, 'calls', callId);
  return onSnapshot(docRef, (docSnap) => {
    if (!docSnap.exists()) {
      callback(null);
      return;
    }
    callback({ ...docSnap.data(), callId: docSnap.id } as CallSession);
  });
}

/**
 * Subscribe to ICE candidates
 */
export function subscribeToIceCandidates(
  callId: string,
  isOffer: boolean,
  callback: (candidate: RTCIceCandidateInit) => void
): Unsubscribe {
  const candidatesPath = isOffer ? 'answerCandidates' : 'offerCandidates';
  const candidatesRef = collection(db, 'calls', callId, candidatesPath);
  return onSnapshot(candidatesRef, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        callback(change.doc.data() as RTCIceCandidateInit);
      }
    });
  });
}

/**
 * Find active call for a chat
 */
export function subscribeToActiveCall(
  chatId: string,
  callback: (session: CallSession | null) => void
): Unsubscribe {
  const q = query(
    callsCollection,
    where('chatId', '==', chatId),
    where('status', 'in', ['ringing', 'connected'])
  );
  return onSnapshot(q, (snapshot) => {
    if (snapshot.empty) {
      callback(null);
      return;
    }
    const doc = snapshot.docs[0];
    callback({ ...doc.data(), callId: doc.id } as CallSession);
  });
}

/**
 * Join an existing call
 */
export async function joinCall(
  callId: string,
  participant: CallParticipant
): Promise<void> {
  const docRef = doc(db, 'calls', callId);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    throw new Error('Call not found');
  }
  const session = docSnap.data() as CallSession;
  const existingParticipant = session.participants.find(p => p.userId === participant.userId);
  if (existingParticipant) {
    return; // Already joined
  }
  const sanitizedParticipant: CallParticipant = {
    userId: participant.userId,
    displayName: participant.displayName,
    muted: participant.muted,
    cameraEnabled: participant.cameraEnabled,
    ...(participant.photoURL ? { photoURL: participant.photoURL } : {}),
  };

  await updateDoc(docRef, {
    participants: [...session.participants, sanitizedParticipant],
  });
}

/**
 * Leave a call
 */
export async function leaveCall(callId: string, userId: string): Promise<void> {
  const docRef = doc(db, 'calls', callId);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    return;
  }
  const session = docSnap.data() as CallSession;
  
  // If the call is already ended, don't update again
  if (session.status === 'ended') {
    return;
  }
  
  // For 1:1 calls, when either party leaves, end the call for both
  await updateDoc(docRef, {
    status: 'ended',
    endedAt: Date.now(),
  } satisfies Partial<CallSession>);
}

/**
 * Clean up call data (ICE candidates subcollections)
 */
export async function cleanupCall(callId: string): Promise<void> {
  try {
    await updateCallStatus(callId, 'ended');
  } catch (error) {
    console.warn('Error cleaning up call:', error);
  }
}

/**
 * Get call history for a user
 * Returns calls where the user was a participant, ordered by most recent first
 * 
 * Note: Client-side filtering is necessary because Firestore doesn't support
 * array-contains queries on objects (participants array). For better performance
 * at scale, consider adding a participantIds string array field to CallSession.
 */
export async function getUserCallHistory(
  userId: string,
  limitCount: number = 50
): Promise<CallSession[]> {
  const q = query(
    callsCollection,
    orderBy('startedAt', 'desc'),
    limit(limitCount * 2) // Get more to account for filtering
  );
  
  const snapshot = await getDocs(q);
  const calls = snapshot.docs
    .map(doc => ({ ...doc.data(), callId: doc.id } as CallSession))
    .filter(call => call.participants.some(p => p.userId === userId))
    .slice(0, limitCount);
  
  return calls;
}

/**
 * Get call history for a specific chat
 */
export async function getChatCallHistory(
  chatId: string,
  limitCount: number = 30
): Promise<CallSession[]> {
  const q = query(
    callsCollection,
    where('chatId', '==', chatId),
    orderBy('startedAt', 'desc'),
    limit(limitCount)
  );
  
  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => ({ ...doc.data(), callId: doc.id } as CallSession));
}

/**
 * Subscribe to call history updates for a user
 * 
 * Note: Client-side filtering is necessary because Firestore doesn't support
 * array-contains queries on objects. For production, consider adding a participantIds
 * string array field for more efficient server-side filtering.
 */
export function subscribeToUserCallHistory(
  userId: string,
  callback: (calls: CallSession[]) => void,
  limitCount: number = 50
): Unsubscribe {
  const q = query(
    callsCollection,
    orderBy('startedAt', 'desc'),
    limit(limitCount * 3) // Get more than needed to account for filtering
  );
  
  return onSnapshot(q, (snapshot) => {
    const calls = snapshot.docs
      .map(doc => ({ ...doc.data(), callId: doc.id } as CallSession))
      .filter(call => call.participants.some(p => p.userId === userId))
      .slice(0, limitCount);
    
    callback(calls);
  });
}
