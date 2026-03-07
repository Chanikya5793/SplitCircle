/**
 * Call Service - Uses Firebase Realtime Database for ephemeral signaling
 * 
 * Architecture (aligned with app DNA):
 * - Realtime DB: Temporary call signaling (deleted after call ends)
 * - AsyncStorage: Local call history (permanent on device)
 * - LiveKit: Actual audio/video handling
 */

import {
  equalTo,
  get,
  getDatabase,
  limitToLast,
  onValue,
  orderByChild,
  query,
  ref,
  remove,
  runTransaction,
  set,
  type Unsubscribe
} from 'firebase/database';
import type { CallParticipant, CallSession, CallType } from '@/models';

// Get Realtime Database instance
const rtdb = getDatabase();
const MAX_ACTIVE_CALL_AGE_MS = 5 * 60 * 1000;
const ACTIVE_CALL_QUERY_LIMIT = 50;
let hasLoggedActiveCallPermissionWarning = false;
let hasLoggedCallSessionPermissionWarning = false;

const debugLog = (...args: unknown[]) => {
  if (__DEV__) {
    console.log(...args);
  }
};

type RawCallSession = Omit<CallSession, 'participants'> & {
  participants?: Record<string, CallParticipant> | CallParticipant[];
};

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
  participantIds?: string[];
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

function toParticipantsObject(participants: CallParticipant[]): Record<string, CallParticipant> {
  return participants.reduce<Record<string, CallParticipant>>((acc, participant, index) => {
    acc[index.toString()] = participant;
    return acc;
  }, {});
}

function toCallSession(data: RawCallSession): CallSession {
  return {
    ...data,
    participants: normalizeParticipants(data.participants),
  };
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
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

  const participant: CallParticipant = {
    userId: config.userId,
    displayName: config.displayName,
    muted: false,
    cameraEnabled: type === 'video',
    ...(config.photoURL ? { photoURL: config.photoURL } : {}),
  };

  const allowedUserIdsList = Array.from(new Set([...(config.participantIds ?? []), config.userId]));
  const allowedUserIds = allowedUserIdsList.reduce<Record<string, true>>((acc, id) => {
    acc[id] = true;
    return acc;
  }, {});

  // Store participants as object with index keys for RTDB compatibility
  const callData: RawCallSession = {
    callId,
    chatId: config.chatId,
    initiatorId: config.userId,
    participants: { 0: participant },  // Use object with numeric keys for RTDB
    participantIds: { [config.userId]: true },
    allowedUserIds,
    type,
    status: 'ringing',
    startedAt: Date.now(),
    ...(config.groupId ? { groupId: config.groupId } : {}),
  };

  const callRef = ref(rtdb, `calls/${callId}`);
  await set(callRef, callData);

  debugLog('callService.createCallSession created');
  return callId;
}

/**
 * Get a call session by ID (one-time fetch)
 */
export async function getCallSession(callId: string): Promise<CallSession | null> {
  try {
    const callRef = ref(rtdb, `calls/${callId}`);
    const snapshot = await get(callRef);

    if (!snapshot.exists()) {
      return null;
    }

    const data = snapshot.val() as RawCallSession;
    return toCallSession(data);
  } catch (error) {
    console.error('callService.getCallSession failed', error);
    return null;
  }
}

/**
 * Update call session status
 */
export async function updateCallStatus(callId: string, status: CallSession['status']): Promise<void> {
  const callRef = ref(rtdb, `calls/${callId}/status`);
  await set(callRef, status);
  debugLog('callService.updateCallStatus applied');
}

/**
 * Subscribe to call session changes
 */
export function subscribeToCallSession(
  callId: string,
  callback: (session: CallSession | null) => void
): Unsubscribe {
  const callRef = ref(rtdb, `calls/${callId}`);

  return onValue(callRef, (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }
    const data = snapshot.val() as RawCallSession;
    const session = toCallSession(data);
    callback(session);
  }, (error) => {
    const code = (error as { code?: string } | undefined)?.code?.toLowerCase() ?? '';
    const message = String(error ?? '').toLowerCase();
    const isPermissionDenied = code.includes('permission_denied') || message.includes('permission_denied');

    if (isPermissionDenied) {
      if (!hasLoggedCallSessionPermissionWarning) {
        hasLoggedCallSessionPermissionWarning = true;
        console.warn('Call session listener permission denied. Verify /calls/$callId read rule and allowedUserIds for the current user.');
      }
      return;
    }

    console.error('callService.subscribeToCallSession failed', error);
  });
}

/**
 * Find active call for a chat
 * Returns the newest active call (by startedAt) to avoid picking up stale calls
 */
export function subscribeToActiveCall(
  chatId: string,
  userId: string,
  callback: (session: CallSession | null) => void
): Unsubscribe {
  // Query only calls where this user is explicitly allowed.
  const callsQuery = query(
    ref(rtdb, 'calls'),
    orderByChild(`allowedUserIds/${userId}`),
    equalTo(true),
    limitToLast(ACTIVE_CALL_QUERY_LIMIT)
  );
  const unsubscribe = onValue(callsQuery, (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }

    const calls = snapshot.val() as Record<string, RawCallSession>;
    const now = Date.now();
    const validCalls = Object.values(calls)
      .map((rawCall) => toCallSession(rawCall))
      .filter((call) => {
        const isActiveStatus = call.status === 'ringing' || call.status === 'connected';
        const isNotStale = now - call.startedAt < MAX_ACTIVE_CALL_AGE_MS;
        const isAllowedForUser = call.allowedUserIds?.[userId] === true;
        return call.chatId === chatId && isAllowedForUser && isActiveStatus && isNotStale;
      })
      .sort((a, b) => b.startedAt - a.startedAt);

    const newestCall = validCalls[0] ?? null;
    if (!newestCall) {
      callback(null);
      return;
    }

    callback(newestCall);
  }, (error) => {
    const code = (error as { code?: string } | undefined)?.code?.toLowerCase() ?? '';
    const message = String(error ?? '').toLowerCase();
    const isPermissionDenied = code.includes('permission_denied') || message.includes('permission_denied');

    if (isPermissionDenied) {
      if (!hasLoggedActiveCallPermissionWarning) {
        hasLoggedActiveCallPermissionWarning = true;
        console.warn('Call listener permission denied for /calls query. Verify deployed RTDB rules allow user-scoped allowedUserIds queries.');
      }
      callback(null);
      return;
    }

    console.error('callService.subscribeToActiveCall failed', error);
  });

  return unsubscribe;
}

/**
 * Join an existing call
 */
export async function joinCall(
  callId: string,
  participant: CallParticipant
): Promise<void> {
  const sanitizedParticipant: CallParticipant = {
    userId: participant.userId,
    displayName: participant.displayName,
    muted: participant.muted,
    cameraEnabled: participant.cameraEnabled,
    ...(participant.photoURL ? { photoURL: participant.photoURL } : {}),
  };

  const callRef = ref(rtdb, `calls/${callId}`);
  const result = await runTransaction(callRef, (currentValue) => {
    if (!currentValue) {
      return currentValue;
    }

    const session = toCallSession(currentValue as RawCallSession);
    if (session.status === 'ended' || session.status === 'failed') {
      return currentValue;
    }

    if (session.participants.some((p) => p.userId === participant.userId)) {
      return currentValue;
    }

    const participants = [...session.participants, sanitizedParticipant];
    return {
      ...(currentValue as Record<string, unknown>),
      participants: toParticipantsObject(participants),
      participantIds: {
        ...(session.participantIds ?? {}),
        [participant.userId]: true,
      },
      allowedUserIds: {
        ...(session.allowedUserIds ?? {}),
        [participant.userId]: true,
      },
      status: 'connected',
    };
  });

  if (!result.snapshot.exists()) {
    throw new Error('Call not found');
  }

  debugLog('callService.joinCall applied');
}

/**
 * Leave a call.
 * Removes only the current participant and keeps the call alive for others.
 * If one or zero participants remain, signaling is deleted.
 */
export async function leaveCall(callId: string, userId: string): Promise<void> {
  try {
    const callRef = ref(rtdb, `calls/${callId}`);
    const snapshot = await get(callRef);
    if (!snapshot.exists()) {
      return;
    }

    await runTransaction(callRef, (currentValue) => {
      if (!currentValue) {
        return currentValue;
      }

      const session = toCallSession(currentValue as RawCallSession);
      const isCurrentParticipant = session.participants.some((participant) => participant.userId === userId)
        || session.participantIds?.[userId] === true;

      if (!isCurrentParticipant) {
        return currentValue;
      }

      const remainingParticipants = session.participants.filter((participant) => participant.userId !== userId);

      // End signaling if the room can no longer host an active conversation.
      if (remainingParticipants.length <= 1) {
        return null;
      }

      const participantIds = { ...(session.participantIds ?? {}) };
      delete participantIds[userId];

      const allowedUserIds = { ...(session.allowedUserIds ?? {}) };
      delete allowedUserIds[userId];

      return {
        ...(currentValue as Record<string, unknown>),
        participants: toParticipantsObject(remainingParticipants),
        participantIds,
        allowedUserIds,
        status: 'connected',
      };
    });
    debugLog('callService.leaveCall applied');
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code?.toLowerCase() ?? '';
    const message = String(error ?? '').toLowerCase();
    const isPermissionDenied = code.includes('permission_denied') || message.includes('permission_denied');

    if (isPermissionDenied) {
      debugLog('callService.leaveCall skipped due permission_denied (likely already cleaned up)');
      return;
    }

    console.warn('callService.leaveCall failed', error);
  }
}

/**
 * Clean up call - same as leaveCall (deletes the signaling)
 */
export async function cleanupCall(callId: string): Promise<void> {
  try {
    const callRef = ref(rtdb, `calls/${callId}`);
    await remove(callRef);
    debugLog('callService.cleanupCall applied');
  } catch (error) {
    console.warn('callService.cleanupCall failed', error);
  }
}

/**
 * Decline a call - Updates status to 'ended' then deletes after a short delay
 * This allows the caller to see that the call was declined
 */
export async function declineCall(callId: string): Promise<void> {
  try {
    // First update status to 'ended' so caller knows it was declined
    await updateCallStatus(callId, 'ended');

    // Delete after a short delay to ensure caller receives the update
    setTimeout(async () => {
      try {
        const callRef = ref(rtdb, `calls/${callId}`);
        await remove(callRef);
        debugLog('callService.declineCall cleanup applied');
      } catch (error) {
        console.warn('callService.declineCall cleanup failed', error);
      }
    }, 2000);
  } catch (error) {
    console.warn('callService.declineCall failed', error);
  }
}
