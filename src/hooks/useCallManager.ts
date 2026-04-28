import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import type { CallStatus, CallType } from '@/models';
import {
  createCallSession,
  getCallSession,
  joinCall,
  leaveCall,
  subscribeToActiveCall,
  subscribeToCallSession
} from '@/services/callService';
import { LiveKitService } from '@/services/LiveKitService';
import { saveCallToHistory, type CallHistoryEntry } from '@/services/localCallStorage';
import { nativeCallService } from '@/services/nativeCallService';
import { requestCallPermissions } from '@/utils/permissions';
import { AudioSession } from '@livekit/react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

const debugLog = (...args: unknown[]) => {
  if (__DEV__) {
    console.log(...args);
  }
};

interface UseCallManagerArgs {
  chatId?: string;
  groupId?: string;
}

interface UseCallManagerReturn {
  status: CallStatus;
  callId: string | null;
  error: string | null;
  isMuted: boolean;
  isCameraOff: boolean;
  serverUrl: string | null;
  token: string | null;
  callType: CallType;
  startCall: (callType?: CallType) => Promise<void>;
  joinExistingCall: (callId: string) => Promise<void>;
  endCall: () => Promise<void>;
  toggleMute: () => void;
  toggleCamera: () => void;
}

export const useCallManager = ({ chatId, groupId }: UseCallManagerArgs): UseCallManagerReturn => {
  const { user } = useAuth();
  const { threads } = useChat();
  const [status, setStatus] = useState<CallStatus>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [callType, setCallType] = useState<CallType>('video');

  // LiveKit connection details
  const [token, setToken] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  const callIdRef = useRef<string | null>(null);
  const callStartedAtRef = useRef<number | null>(null);
  const otherParticipantRef = useRef<{ userId: string; displayName: string; photoURL?: string } | null>(null);
  const isInitiatorRef = useRef<boolean>(false);
  const hasSessionToCleanupRef = useRef(false);
  const allowUnmountCleanupRef = useRef(false);
  const sessionVersionRef = useRef(0);
  const isEndingRef = useRef(false);
  const nativeDirectionRef = useRef<'incoming' | 'outgoing'>('outgoing');
  const hasReportedConnectedNativeRef = useRef(false);
  const endCallRef = useRef<(reason?: 'manual' | 'session-ended' | 'unmount') => Promise<void>>(async () => undefined);
  const unsubscribes = useRef<Array<() => void>>([]);

  // Cleanup subscriptions
  const cleanupSubscriptions = useCallback(() => {
    debugLog('useCallManager cleanup subscriptions');
    unsubscribes.current.forEach((unsub) => unsub());
    unsubscribes.current = [];
  }, []);

  const buildNativeHandle = useCallback((
    fallbackDisplayName?: string,
    fallbackUserId?: string,
  ) => {
    const thread = threads.find((item) => item.chatId === chatId);
    const directParticipant = thread?.participants.find((participant) => participant.userId !== user?.userId);
    const displayName = directParticipant?.displayName
      || fallbackDisplayName
      || (thread?.type === 'group' ? 'Group Call' : 'SplitCircle Contact');
    const handle = directParticipant?.userId || fallbackUserId || chatId || displayName;

    return {
      displayName,
      handle,
    };
  }, [chatId, threads, user?.userId]);

  // Start a new call (as initiator)
  const startCall = useCallback(async (type: CallType = 'video') => {
    if (!chatId || !user) {
      console.error('Cannot start call: missing chat or user');
      setError('Missing chat ID or user');
      return;
    }

    const sessionVersion = ++sessionVersionRef.current;

    try {
      let newCallId: string | null = null;
      cleanupSubscriptions();
      isEndingRef.current = false;
      setError(null);
      setStatus('ringing'); // UI shows "Calling..."
      setCallType(type);
      hasReportedConnectedNativeRef.current = false;
      isInitiatorRef.current = true;
      nativeDirectionRef.current = 'outgoing';
      callStartedAtRef.current = Date.now();

      const hasPermissions = await requestCallPermissions(type);
      if (!hasPermissions) {
        throw new Error(
          type === 'video'
            ? 'Camera and microphone permissions are required for video calls.'
            : 'Microphone permission is required for audio calls.'
        );
      }

      const thread = threads.find((t) => t.chatId === chatId);
      const threadParticipantIds = thread?.participantIds ?? [user.userId];

      // Resolve other participant from thread immediately so call history is never "Unknown"
      const otherP = thread?.participants.find((p) => p.userId !== user.userId);
      if (otherP) {
        otherParticipantRef.current = {
          userId: otherP.userId,
          displayName: otherP.displayName,
          photoURL: otherP.photoURL,
        };
      }

      // 1. Create Call Session in Realtime DB (Ringing)
      newCallId = await createCallSession(
        {
          chatId,
          groupId,
          userId: user.userId,
          displayName: user.displayName || 'Unknown',
          photoURL: user.photoURL || undefined,
          participantIds: threadParticipantIds,
        },
        type
      );

      if (sessionVersionRef.current !== sessionVersion) {
        return;
      }

      setCallId(newCallId);
      callIdRef.current = newCallId;

      const nativePresentation = buildNativeHandle(
        otherParticipantRef.current?.displayName,
        otherParticipantRef.current?.userId,
      );
      await nativeCallService.startOutgoingCall(
        newCallId,
        nativePresentation.handle,
        nativePresentation.displayName,
        type === 'video',
      );

      // 2. Fetch LiveKit Token
      const { token: roomToken, url } = await LiveKitService.getToken(
        newCallId,
        chatId,
        user.displayName || 'User'
      );

      if (sessionVersionRef.current !== sessionVersion || callIdRef.current !== newCallId) {
        return;
      }

      setToken(roomToken);
      setServerUrl(url);

      // 3. Start Audio Session
      await AudioSession.startAudioSession();

      // 4. Subscribe to Call Session to see if answered or ended
      const unsubSession = subscribeToCallSession(newCallId, (session) => {
        // Ignore stale callbacks from an older call lifecycle.
        if (sessionVersionRef.current !== sessionVersion || callIdRef.current !== newCallId) {
          return;
        }

        if (!session) {
          debugLog('useCallManager call session removed; ending call');
          void endCallRef.current('session-ended');
          return;
        }

        if (session.status === 'ended') {
          void endCallRef.current('session-ended');
          return;
        }

        if (session.status === 'connected') {
          debugLog('useCallManager call connected');
          setStatus('connected');

          if (!hasReportedConnectedNativeRef.current) {
            hasReportedConnectedNativeRef.current = true;
            void nativeCallService.markCallConnected(newCallId, nativeDirectionRef.current);
          }

          // Only fill in other participant if not already resolved from thread
          if (!otherParticipantRef.current) {
            const other = session.participants.find(p => p.userId !== user.userId);
            if (other) {
              otherParticipantRef.current = { userId: other.userId, displayName: other.displayName, photoURL: other.photoURL };
            }
          }
        }
      });
      unsubscribes.current.push(unsubSession);

    } catch (err) {
      if (sessionVersionRef.current !== sessionVersion) {
        return;
      }

      console.error('Error starting call', err);
      if (callIdRef.current && user) {
        try {
          await leaveCall(callIdRef.current, user.userId);
        } catch (cleanupError) {
          console.warn('Failed to cleanup failed outbound call setup', cleanupError);
        }
      }
      if (callIdRef.current) {
        await nativeCallService.endCall(callIdRef.current);
        nativeCallService.clearCall(callIdRef.current);
      }
      callIdRef.current = null;
      setCallId(null);
      setError(err instanceof Error ? err.message : 'Failed to start call');
      setStatus('failed');
    }
  }, [buildNativeHandle, chatId, groupId, threads, user]);

  // Join an existing call (as answerer)
  const joinExistingCall = useCallback(async (existingCallId: string) => {
    if (!user || !chatId) {
      console.error('Cannot join call: missing user or chat ID');
      setError('Missing authenticated user or chat ID');
      return;
    }

    const sessionVersion = ++sessionVersionRef.current;

    try {
      cleanupSubscriptions();
      isEndingRef.current = false;
      setError(null);
      setStatus('ringing');
      setCallId(existingCallId);
      callIdRef.current = existingCallId;
      hasReportedConnectedNativeRef.current = false;
      isInitiatorRef.current = false;
      nativeDirectionRef.current = 'incoming';
      callStartedAtRef.current = Date.now();

      // Resolve other participant from thread immediately as fallback
      const thread = threads.find((t) => t.chatId === chatId);
      const threadOther = thread?.participants.find((p) => p.userId !== user.userId);
      if (threadOther) {
        otherParticipantRef.current = {
          userId: threadOther.userId,
          displayName: threadOther.displayName,
          photoURL: threadOther.photoURL,
        };
      }

      const session = await getCallSession(existingCallId);
      if (!session) {
        console.error('Call not found');
        setError('Call not found');
        setStatus('ended');
        return;
      }
      if (session.status === 'ended') {
        console.error('Call already ended');
        setError('Call already ended');
        setStatus('ended');
        return;
      }

      setCallType(session.type);

      const hasPermissions = await requestCallPermissions(session.type);
      if (!hasPermissions) {
        throw new Error(
          session.type === 'video'
            ? 'Camera and microphone permissions are required for video calls.'
            : 'Microphone permission is required for audio calls.'
        );
      }

      // Update from session if we got richer info (e.g. photoURL from initiator)
      const initiator = session.participants.find(p => p.userId === session.initiatorId);
      if (initiator) {
        otherParticipantRef.current = { userId: initiator.userId, displayName: initiator.displayName, photoURL: initiator.photoURL };
      }

      // 1. Fetch LiveKit Token
      const { token: roomToken, url } = await LiveKitService.getToken(
        existingCallId,
        chatId,
        user.displayName || 'User'
      );

      if (sessionVersionRef.current !== sessionVersion || callIdRef.current !== existingCallId) {
        return;
      }

      setToken(roomToken);
      setServerUrl(url);

      // 2. Start Audio Session
      await AudioSession.startAudioSession();

      await nativeCallService.answerIncomingCall(existingCallId);

      // 3. Update Realtime DB (Join) - This also updates status to 'connected'
      await joinCall(existingCallId, {
        userId: user.userId,
        displayName: user.displayName || 'Unknown',
        muted: false,
        cameraEnabled: session.type === 'video',
      });
      debugLog('useCallManager joined call');
      setStatus('connected'); // Immediately set to connected since we just joined
      hasReportedConnectedNativeRef.current = true;
      await nativeCallService.markCallConnected(existingCallId, nativeDirectionRef.current);

      // 4. Subscribe to session for further updates
      const unsubSession = subscribeToCallSession(existingCallId, (updatedSession) => {
        // Ignore stale callbacks from an older call lifecycle.
        if (sessionVersionRef.current !== sessionVersion || callIdRef.current !== existingCallId) {
          return;
        }

        if (!updatedSession) {
          debugLog('useCallManager joined call session removed; ending call');
          void endCallRef.current('session-ended');
          return;
        }

        if (updatedSession.status === 'ended') {
          void endCallRef.current('session-ended');
        }
      });
      unsubscribes.current.push(unsubSession);

    } catch (err) {
      console.error('Error joining call', err);
      await nativeCallService.endCall(existingCallId);
      nativeCallService.clearCall(existingCallId);
      setError(err instanceof Error ? err.message : 'Failed to join call');
      setStatus('failed');
    }
  }, [chatId, threads, user]);

  // End the call
  const endCall = useCallback(async (reason: 'manual' | 'session-ended' | 'unmount' = 'manual') => {
    if (isEndingRef.current) {
      return;
    }

    isEndingRef.current = true;
    sessionVersionRef.current += 1;
    debugLog('useCallManager ending call', reason);

    try {
      cleanupSubscriptions();
      const endingCallId = callIdRef.current;
      const endingStartedAt = callStartedAtRef.current;
      const endingParticipant = otherParticipantRef.current;

      setStatus('ended');
      setCallId(null);

      // Save call history locally before deleting from Realtime DB
      if (endingCallId && user && endingStartedAt && chatId) {
        const endedAt = Date.now();
        const duration = Math.floor((endedAt - endingStartedAt) / 1000);

        // Last-resort: resolve from thread if ref was somehow never set
        let participant = endingParticipant;
        if (!participant) {
          const thread = threads.find((t) => t.chatId === chatId);
          const threadOther = thread?.participants.find((p) => p.userId !== user.userId);
          if (threadOther) {
            participant = { userId: threadOther.userId, displayName: threadOther.displayName, photoURL: threadOther.photoURL };
          }
        }

        const historyEntry: CallHistoryEntry = {
          callId: endingCallId,
          chatId,
          groupId,
          type: callType,
          direction: isInitiatorRef.current ? 'outgoing' : 'incoming',
          otherParticipant: participant || { userId: 'unknown', displayName: 'Unknown' },
          startedAt: endingStartedAt,
          endedAt,
          duration,
          status: duration > 0 ? 'completed' : 'missed',
        };

        await saveCallToHistory(historyEntry);
      }

      // Remove this participant from signaling.
      if (endingCallId && user) {
        await leaveCall(endingCallId, user.userId);
      }

      if (endingCallId) {
        await nativeCallService.endCall(endingCallId);
        nativeCallService.clearCall(endingCallId);
      }

      callIdRef.current = null;
      callStartedAtRef.current = null;
      otherParticipantRef.current = null;
      hasSessionToCleanupRef.current = false;
      hasReportedConnectedNativeRef.current = false;

      await AudioSession.stopAudioSession();
      debugLog('useCallManager call ended');

    } catch (err) {
      console.error('Error ending call', err);
    } finally {
      // Keep `true` while idle; reset when starting/joining a new call.
    }
  }, [user, chatId, groupId, threads, callType, cleanupSubscriptions]);

  useEffect(() => {
    endCallRef.current = endCall;
  }, [endCall]);

  useEffect(() => {
    hasSessionToCleanupRef.current = Boolean(callIdRef.current || callId || token || serverUrl);
  }, [callId, serverUrl, token, status]);

  useEffect(() => {
    const timer = setTimeout(() => {
      // React StrictMode does a mount->cleanup->mount simulation in dev. Avoid treating
      // that first cleanup pass as a real unmount that should terminate the call.
      allowUnmountCleanupRef.current = true;
    }, 0);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const unsubscribeNativeEnd = nativeCallService.subscribe('end', ({ appCallId }) => {
      if (!appCallId || appCallId !== callIdRef.current || isEndingRef.current) {
        return;
      }

      debugLog('useCallManager received native end-call action');
      void endCallRef.current('manual');
    });

    const unsubscribeNativeMute = nativeCallService.subscribe('mute', ({ appCallId, muted }) => {
      if (appCallId && appCallId !== callIdRef.current) {
        return;
      }

      setIsMuted(muted);
    });

    return () => {
      unsubscribeNativeEnd();
      unsubscribeNativeMute();
    };
  }, []);

  // Local state toggles (actual media toggle happens in the UI via LiveKitRoom)
  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  const toggleCamera = useCallback(() => {
    setIsCameraOff((prev) => !prev);
  }, []);

  // Cleanup on unmount:
  // - If there is no active call session yet, only clean listeners.
  // - If call state exists, end the call once.
  useEffect(() => {
    return () => {
      if (!allowUnmountCleanupRef.current) {
        cleanupSubscriptions();
        return;
      }

      if (!hasSessionToCleanupRef.current) {
        cleanupSubscriptions();
        return;
      }

      void endCallRef.current('unmount');
    };
  }, [cleanupSubscriptions]);

  // Watch for incoming calls
  useEffect(() => {
    if (!chatId || !user?.userId || status !== 'idle') {
      return;
    }

    const unsubscribe = subscribeToActiveCall(chatId, user.userId, (session) => {
      if (session && session.initiatorId !== user?.userId && session.status === 'ringing') {
        debugLog('useCallManager incoming call detected');
        // You might want to trigger a ringtone here
      }
    });

    return () => unsubscribe();
  }, [chatId, user?.userId, status]);

  return {
    status,
    callId,
    error,
    isMuted,
    isCameraOff,
    serverUrl,
    token,
    callType,
    startCall,
    joinExistingCall,
    endCall,
    toggleMute,
    toggleCamera,
  };
};
