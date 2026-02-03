/**
 * Call Service - Uses Firebase Realtime Database for ephemeral signaling
 * 
 * Architecture (aligned with app DNA):
 * - Realtime DB: Temporary call signaling (deleted after call ends)
 * - AsyncStorage: Local call history (permanent on device)
 * - LiveKit: Actual audio/video handling
 */

import { get, getDatabase, onValue, ref, remove, set, type Unsubscribe } from 'firebase/database';
import type { CallParticipant, CallSession, CallType } from '@/models';

// Get Realtime Database instance
const rtdb = getDatabase();

// ICE servers configuration for STUN/TURN (kept for reference if needed)
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
 * Convert RTDB object with numeric keys to array
 * RTDB stores arrays as objects with "0", "1", etc. keys
 */
function normalizeParticipants(data: unknown): CallParticipant[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object') {
    return Object.values(data) as CallParticipant[];
  }
  return [];
}

/**
 * Create call signaling in Realtime Database
 * This is ephemeral - will be deleted when call ends
 */
export async function createCallSession(
  config: CallServiceConfig,
  type: CallType,
): Promise<string> {
  // Generate a unique call ID
  const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  console.log(`📞 callService.createCallSession: Creating ${type} call ${callId}`);

  const participant: CallParticipant = {
    userId: config.userId,
    displayName: config.displayName,
    muted: false,
    cameraEnabled: type === 'video',
    ...(config.photoURL ? { photoURL: config.photoURL } : {}),
  };

  // Store participants as object with index keys for RTDB compatibility
  const callData = {
    callId,
    chatId: config.chatId,
    initiatorId: config.userId,
    participants: { 0: participant },  // Use object with numeric keys for RTDB
    type,
    status: 'ringing',
    startedAt: Date.now(),
    ...(config.groupId ? { groupId: config.groupId } : {}),
  };

  const callRef = ref(rtdb, `calls/${callId}`);
  await set(callRef, callData);

  console.log(`📞 callService.createCallSession: Created call ${callId} in Realtime DB`);
  return callId;
}

/**
 * Get a call session by ID (one-time fetch)
 */
export async function getCallSession(callId: string): Promise<CallSession | null> {
  console.log(`📞 callService.getCallSession: Fetching ${callId}`);

  try {
    const callRef = ref(rtdb, `calls/${callId}`);
    const snapshot = await get(callRef);

    if (!snapshot.exists()) {
      console.log(`📞 callService.getCallSession: Call ${callId} not found`);
      return null;
    }

    const data = snapshot.val();
    console.log(`📞 callService.getCallSession: Found call ${callId}, status=${data.status}`);

    // Normalize participants array
    const session: CallSession = {
      ...data,
      participants: normalizeParticipants(data.participants),
    };
    return session;
  } catch (error) {
    console.error(`📞 callService.getCallSession: Error fetching ${callId}:`, error);
    return null;
  }
}

/**
 * Update call session status
 */
export async function updateCallStatus(callId: string, status: CallSession['status']): Promise<void> {
  console.log(`📞 callService.updateCallStatus: ${callId} -> ${status}`);

  const callRef = ref(rtdb, `calls/${callId}/status`);
  await set(callRef, status);
}

/**
 * Subscribe to call session changes
 */
export function subscribeToCallSession(
  callId: string,
  callback: (session: CallSession | null) => void
): Unsubscribe {
  console.log(`📞 callService.subscribeToCallSession: Subscribing to ${callId}`);

  const callRef = ref(rtdb, `calls/${callId}`);

  return onValue(callRef, (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }
    const data = snapshot.val();
    // Normalize participants array
    const session: CallSession = {
      ...data,
      participants: normalizeParticipants(data.participants),
    };
    callback(session);
  });
}

/**
 * Find active call for a chat
 * Returns the newest active call (by startedAt) to avoid picking up stale calls
 */
export function subscribeToActiveCall(
  chatId: string,
  callback: (session: CallSession | null) => void
): Unsubscribe {
  console.log(`📞 callService.subscribeToActiveCall: Listening for calls on chat ${chatId}`);

  // Maximum age for a call to be considered active (5 minutes)
  const MAX_CALL_AGE_MS = 5 * 60 * 1000;

  // Listen to all calls
  const callsRef = ref(rtdb, 'calls');

  console.log(`📞 [${chatId.slice(0, 8)}] Setting up onValue listener...`);

  const unsubscribe = onValue(callsRef, (snapshot) => {
    console.log(`📞 [${chatId.slice(0, 8)}] onValue FIRED! exists=${snapshot.exists()}`);

    if (!snapshot.exists()) {
      console.log(`📞 [${chatId.slice(0, 8)}] No calls in database`);
      callback(null);
      return;
    }

    const calls = snapshot.val();
    const now = Date.now();
    const callIds = Object.keys(calls);

    console.log(`📞 [${chatId.slice(0, 8)}] Checking ${callIds.length} call(s)`);

    // Filter calls for this chat that are active and not stale
    const validCalls: CallSession[] = [];

    for (const callId of callIds) {
      const rawCall = calls[callId];

      // Normalize the call data
      const call: CallSession = {
        ...rawCall,
        participants: normalizeParticipants(rawCall.participants),
      };

      const matchesChatId = call.chatId === chatId;
      const isActiveStatus = call.status === 'ringing' || call.status === 'connected';
      const age = now - call.startedAt;
      const isNotStale = age < MAX_CALL_AGE_MS;

      // Log every call being checked
      console.log(`📞   - ${callId.slice(0, 20)}: chat=${call.chatId?.slice(0, 8)} match=${matchesChatId}, status=${call.status}, age=${Math.round(age / 1000)}s, stale=${!isNotStale}`);

      if (matchesChatId && isActiveStatus && isNotStale) {
        validCalls.push(call);
      }
    }

    if (validCalls.length === 0) {
      console.log(`📞 [${chatId.slice(0, 8)}] No active calls found`);
      callback(null);
      return;
    }

    // Sort by startedAt descending (newest first)
    validCalls.sort((a, b) => b.startedAt - a.startedAt);

    // Return the newest call
    const newestCall = validCalls[0];
    console.log(`📞 [${chatId.slice(0, 8)}] ✅ FOUND ACTIVE CALL: ${newestCall.callId}, initiator=${newestCall.initiatorId}`);
    callback(newestCall);
  }, (error) => {
    console.error(`📞 [${chatId.slice(0, 8)}] ❌ onValue ERROR:`, error);
  });

  console.log(`📞 [${chatId.slice(0, 8)}] Listener setup complete`);
  return unsubscribe;
}

/**
 * Join an existing call
 */
export async function joinCall(
  callId: string,
  participant: CallParticipant
): Promise<void> {
  console.log(`📞 callService.joinCall: ${participant.userId} joining ${callId}`);

  const session = await getCallSession(callId);
  if (!session) {
    throw new Error('Call not found');
  }

  const existingParticipant = session.participants.find(p => p.userId === participant.userId);
  if (existingParticipant) {
    console.log(`📞 callService.joinCall: Already joined`);
    return;
  }

  const sanitizedParticipant: CallParticipant = {
    userId: participant.userId,
    displayName: participant.displayName,
    muted: participant.muted,
    cameraEnabled: participant.cameraEnabled,
    ...(participant.photoURL ? { photoURL: participant.photoURL } : {}),
  };

  // Convert participants back to object format for RTDB
  const participantsObj: Record<number, CallParticipant> = {};
  session.participants.forEach((p, i) => {
    participantsObj[i] = p;
  });
  participantsObj[session.participants.length] = sanitizedParticipant;

  // Update call in Realtime DB
  const callRef = ref(rtdb, `calls/${callId}`);
  await set(callRef, {
    ...session,
    participants: participantsObj,
    status: 'connected', // Mark as connected when recipient joins
  });

  console.log(`📞 callService.joinCall: Successfully joined, status set to connected`);
}

/**
 * Leave a call - DELETES the signaling from Realtime DB
 * Call history should be saved locally before calling this
 */
export async function leaveCall(callId: string, userId: string): Promise<void> {
  console.log(`📞 callService.leaveCall: ${userId} leaving ${callId}`);

  try {
    const callRef = ref(rtdb, `calls/${callId}`);
    await remove(callRef);
    console.log(`📞 callService.leaveCall: Call ${callId} deleted from Realtime DB`);
  } catch (error) {
    console.warn(`📞 callService.leaveCall: Failed to delete call ${callId}`, error);
  }
}

/**
 * Clean up call - same as leaveCall (deletes the signaling)
 */
export async function cleanupCall(callId: string): Promise<void> {
  try {
    const callRef = ref(rtdb, `calls/${callId}`);
    await remove(callRef);
    console.log(`📞 callService.cleanupCall: Call ${callId} deleted`);
  } catch (error) {
    console.warn('Error cleaning up call:', error);
  }
}

/**
 * Decline a call - Updates status to 'ended' then deletes after a short delay
 * This allows the caller to see that the call was declined
 */
export async function declineCall(callId: string): Promise<void> {
  console.log(`📞 callService.declineCall: Declining call ${callId}`);

  try {
    // First update status to 'ended' so caller knows it was declined
    await updateCallStatus(callId, 'ended');

    // Delete after a short delay to ensure caller receives the update
    setTimeout(async () => {
      try {
        const callRef = ref(rtdb, `calls/${callId}`);
        await remove(callRef);
        console.log(`📞 callService.declineCall: Call ${callId} cleaned up`);
      } catch (error) {
        console.warn('Error cleaning up declined call:', error);
      }
    }, 2000);
  } catch (error) {
    console.warn(`📞 callService.declineCall: Failed to decline call ${callId}`, error);
  }
}
