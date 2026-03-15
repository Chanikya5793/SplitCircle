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
const LEGACY_ACTIVE_CALL_QUERY_LIMIT = 50;
const USER_ACTIVE_CALLS_PATH = 'userActiveCalls';
let hasLoggedActiveCallPermissionWarning = false;
let hasLoggedCallSessionPermissionWarning = false;
let hasLoggedActiveCallIndexWriteWarning = false;

const debugLog = (...args: unknown[]) => {
  if (__DEV__) {
    console.log(...args);
  }
};

type RawCallSession = Omit<CallSession, 'participants'> & {
  participants?: Record<string, CallParticipant> | CallParticipant[];
};

type ActiveCallIndexEntry = {
  callId: string;
  chatId: string;
  groupId?: string;
  initiatorId: string;
  type: CallType;
  status: CallSession['status'];
  startedAt: number;
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

function getAllowedUserIds(session: Pick<CallSession, 'allowedUserIds'> | Pick<RawCallSession, 'allowedUserIds'>): string[] {
  return Object.entries(session.allowedUserIds ?? {})
    .filter(([, isAllowed]) => isAllowed === true)
    .map(([userId]) => userId);
}

function toActiveCallIndexEntry(session: Pick<CallSession, 'callId' | 'chatId' | 'groupId' | 'initiatorId' | 'type' | 'status' | 'startedAt'>): ActiveCallIndexEntry {
  return {
    callId: session.callId,
    chatId: session.chatId,
    initiatorId: session.initiatorId,
    type: session.type,
    status: session.status,
    startedAt: session.startedAt,
    ...(session.groupId ? { groupId: session.groupId } : {}),
  };
}

function isActiveStatus(status: CallSession['status']): boolean {
  return status === 'ringing' || status === 'connected';
}

function isValidActiveCallForUser(
  session: CallSession,
  userId: string,
  chatId?: string,
): boolean {
  const isAllowedForUser = session.allowedUserIds?.[userId] === true;
  const isMatchingChat = chatId ? session.chatId === chatId : true;
  const isNotStale = Date.now() - session.startedAt < MAX_ACTIVE_CALL_AGE_MS;
  return isMatchingChat && isAllowedForUser && isActiveStatus(session.status) && isNotStale;
}

function isPermissionDeniedError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code?.toLowerCase() ?? '';
  const message = String(error ?? '').toLowerCase();
  return code.includes('permission_denied') || message.includes('permission_denied');
}

async function syncUserActiveCallIndex(
  session: Pick<CallSession, 'callId' | 'chatId' | 'groupId' | 'initiatorId' | 'type' | 'status' | 'startedAt' | 'allowedUserIds'>,
  previousUserIds: string[] = [],
): Promise<void> {
  const nextUserIds = getAllowedUserIds(session);
  const previousUserIdSet = new Set(previousUserIds);
  const nextUserIdSet = new Set(nextUserIds);
  const entry = toActiveCallIndexEntry(session);
  const updates: Record<string, ActiveCallIndexEntry | null> = {};

  for (const userId of previousUserIdSet) {
    if (!nextUserIdSet.has(userId)) {
      updates[`${USER_ACTIVE_CALLS_PATH}/${userId}/${session.callId}`] = null;
    }
  }

  for (const userId of nextUserIdSet) {
    updates[`${USER_ACTIVE_CALLS_PATH}/${userId}/${session.callId}`] = entry;
  }

  if (Object.keys(updates).length === 0) {
    return;
  }

  try {
    await Promise.all(Object.entries(updates).map(async ([path, value]) => {
      const targetRef = ref(rtdb, path);
      if (value === null) {
        await remove(targetRef);
        return;
      }
      await set(targetRef, value);
    }));
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      if (!hasLoggedActiveCallIndexWriteWarning) {
        hasLoggedActiveCallIndexWriteWarning = true;
        console.warn('Call index write skipped for /userActiveCalls. Falling back to legacy /calls listeners until RTDB rules are deployed.');
      }
      return;
    }

    console.warn('callService.syncUserActiveCallIndex failed', error);
  }
}

async function removeUserActiveCallIndex(callId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }

  const updates: Record<string, null> = {};
  for (const userId of new Set(userIds)) {
    updates[`${USER_ACTIVE_CALLS_PATH}/${userId}/${callId}`] = null;
  }

  try {
    await Promise.all(Object.keys(updates).map(async (path) => {
      await remove(ref(rtdb, path));
    }));
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      if (!hasLoggedActiveCallIndexWriteWarning) {
        hasLoggedActiveCallIndexWriteWarning = true;
        console.warn('Call index write skipped for /userActiveCalls. Falling back to legacy /calls listeners until RTDB rules are deployed.');
      }
      return;
    }

    console.warn('callService.removeUserActiveCallIndex failed', error);
  }
}

async function resolveNewestMatchingCall(
  userId: string,
  entries: Record<string, ActiveCallIndexEntry>,
  matchesChat: (chatId: string) => boolean,
): Promise<CallSession | null> {
  const now = Date.now();
  const candidateEntries = Object.values(entries)
    .filter((entry) => matchesChat(entry.chatId) && isActiveStatus(entry.status) && now - entry.startedAt < MAX_ACTIVE_CALL_AGE_MS)
    .sort((a, b) => b.startedAt - a.startedAt);

  for (const entry of candidateEntries) {
    const session = await getCallSession(entry.callId);
    if (session && isValidActiveCallForUser(session, userId, entry.chatId)) {
      return session;
    }
  }

  return null;
}

function subscribeToIndexedActiveCall(
  userId: string,
  matchesChat: (chatId: string) => boolean,
  callback: (session: CallSession | null) => void,
  onPermissionDenied?: () => void,
): Unsubscribe {
  const userActiveCallsRef = ref(rtdb, `${USER_ACTIVE_CALLS_PATH}/${userId}`);
  let version = 0;

  return onValue(userActiveCallsRef, (snapshot) => {
    const currentVersion = ++version;

    if (!snapshot.exists()) {
      callback(null);
      return;
    }

    const entries = snapshot.val() as Record<string, ActiveCallIndexEntry>;
    void resolveNewestMatchingCall(userId, entries, matchesChat)
      .then((session) => {
        if (currentVersion !== version) {
          return;
        }
        callback(session);
      })
      .catch((error) => {
        if (currentVersion !== version) {
          return;
        }
        console.error('callService active-call index resolution failed', error);
        callback(null);
      });
  }, (error) => {
    if (isPermissionDeniedError(error)) {
      if (!hasLoggedActiveCallPermissionWarning) {
        hasLoggedActiveCallPermissionWarning = true;
        console.warn('Call listener permission denied for /userActiveCalls. Falling back to legacy /calls listener.');
      }
      callback(null);
      onPermissionDenied?.();
      return;
    }

    console.error('callService.subscribeToActiveCall failed', error);
  });
}

function subscribeToLegacyActiveCall(
  userId: string,
  matchesChat: (chatId: string) => boolean,
  callback: (session: CallSession | null) => void
): Unsubscribe {
  const callsQuery = query(
    ref(rtdb, 'calls'),
    orderByChild(`allowedUserIds/${userId}`),
    equalTo(true),
    limitToLast(LEGACY_ACTIVE_CALL_QUERY_LIMIT)
  );

  return onValue(callsQuery, (snapshot) => {
    if (!snapshot.exists()) {
      callback(null);
      return;
    }

    const calls = snapshot.val() as Record<string, RawCallSession>;
    const now = Date.now();
    const newestCall = Object.values(calls)
      .map((rawCall) => toCallSession(rawCall))
      .filter((session) => matchesChat(session.chatId) && isValidActiveCallForUser(session, userId))
      .filter((session) => now - session.startedAt < MAX_ACTIVE_CALL_AGE_MS)
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;

    callback(newestCall);
  }, (error) => {
    if (isPermissionDeniedError(error)) {
      if (!hasLoggedActiveCallPermissionWarning) {
        hasLoggedActiveCallPermissionWarning = true;
        console.warn('Call listener permission denied for legacy /calls query. Verify deployed RTDB rules allow allowedUserIds reads.');
      }
      callback(null);
      return;
    }

    console.error('callService.subscribeToLegacyActiveCall failed', error);
  });
}

function subscribeToActiveCallWithFallback(
  userId: string,
  matchesChat: (chatId: string) => boolean,
  callback: (session: CallSession | null) => void
): Unsubscribe {
  let activeUnsubscribe: Unsubscribe = () => undefined;
  let hasSwitchedToLegacy = false;

  const switchToLegacy = () => {
    if (hasSwitchedToLegacy) {
      return;
    }

    hasSwitchedToLegacy = true;
    activeUnsubscribe();
    activeUnsubscribe = subscribeToLegacyActiveCall(userId, matchesChat, callback);
  };

  activeUnsubscribe = subscribeToIndexedActiveCall(userId, matchesChat, callback, switchToLegacy);
  return () => activeUnsubscribe();
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
  await syncUserActiveCallIndex(callData);

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
  const session = await getCallSession(callId);
  const callRef = ref(rtdb, `calls/${callId}/status`);
  await set(callRef, status);
  if (session) {
    await syncUserActiveCallIndex({ ...session, status });
  }
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
  return subscribeToActiveCallWithFallback(userId, (candidateChatId) => candidateChatId === chatId, callback);
}

export function subscribeToIncomingCallForUser(
  userId: string,
  chatIds: string[],
  callback: (session: CallSession | null) => void
): Unsubscribe {
  const chatIdSet = new Set(chatIds);
  return subscribeToActiveCallWithFallback(userId, (candidateChatId) => chatIdSet.has(candidateChatId), callback);
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
  const previousSnapshot = await get(callRef);
  const previousSession = previousSnapshot.exists()
    ? (previousSnapshot.val() as RawCallSession)
    : null;
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

  await syncUserActiveCallIndex(
    result.snapshot.val() as RawCallSession,
    previousSession ? getAllowedUserIds(previousSession) : [],
  );
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

    const previousSession = snapshot.val() as RawCallSession;
    const result = await runTransaction(callRef, (currentValue) => {
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
      const participantIds = { ...(session.participantIds ?? {}) };
      delete participantIds[userId];

      const allowedUserIds = { ...(session.allowedUserIds ?? {}) };
      delete allowedUserIds[userId];

      // End signaling if the room can no longer host an active conversation.
      if (remainingParticipants.length <= 1) {
        return {
          ...(currentValue as Record<string, unknown>),
          participants: toParticipantsObject(remainingParticipants),
          participantIds,
          allowedUserIds,
          status: 'ended',
          endedAt: Date.now(),
        };
      }

      return {
        ...(currentValue as Record<string, unknown>),
        participants: toParticipantsObject(remainingParticipants),
        participantIds,
        allowedUserIds,
        status: 'connected',
      };
    });

    if (!result.snapshot.exists()) {
      return;
    }

    const nextSession = result.snapshot.val() as RawCallSession;
    if (nextSession.status === 'ended') {
      await removeUserActiveCallIndex(callId, getAllowedUserIds(previousSession));
      await remove(callRef);
    } else {
      await syncUserActiveCallIndex(nextSession, getAllowedUserIds(previousSession));
    }

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
    const snapshot = await get(callRef);
    if (snapshot.exists()) {
      await removeUserActiveCallIndex(callId, getAllowedUserIds(snapshot.val() as RawCallSession));
    }
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
    const session = await getCallSession(callId);

    // First update status to 'ended' so caller knows it was declined
    await updateCallStatus(callId, 'ended');
    if (session) {
      await removeUserActiveCallIndex(callId, getAllowedUserIds(session));
    }

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
