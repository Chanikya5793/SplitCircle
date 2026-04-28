import { declineCall, subscribeToIncomingCallForUser } from '@/services/callService';
import { saveCallToHistory, type CallHistoryEntry } from '@/services/localCallStorage';
import { nativeCallService } from '@/services/nativeCallService';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useChat } from './ChatContext';

const debugLog = (...args: unknown[]) => {
  if (__DEV__) {
    console.log(...args);
  }
};

interface IncomingCall {
  callId: string;
  chatId: string;
  groupId?: string;
  initiatorId: string;
  initiatorName: string;
  type: 'audio' | 'video';
  startedAt: number;
}

export interface ActiveCallRequest {
  chatId: string;
  groupId?: string;
  type: 'audio' | 'video';
  joinCallId?: string;
}

interface CallContextValue {
  incomingCall: IncomingCall | null;
  activeCallRequest: ActiveCallRequest | null;
  isCallUiVisible: boolean;
  startCallSession: (request: ActiveCallRequest) => void;
  showActiveCallUi: () => void;
  hideActiveCallUi: () => void;
  clearActiveCall: () => void;
  dismissIncomingCall: () => void;
  acceptIncomingCall: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

const isSameActiveCall = (
  left: ActiveCallRequest | null,
  right: ActiveCallRequest,
): boolean => {
  if (!left) {
    return false;
  }

  return left.chatId === right.chatId
    && left.groupId === right.groupId
    && left.type === right.type
    && left.joinCallId === right.joinCallId;
};

export const CallProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const { threads } = useChat();
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [activeCallRequest, setActiveCallRequest] = useState<ActiveCallRequest | null>(null);
  const [isCallUiVisible, setIsCallUiVisible] = useState(false);

  const incomingCallRef = useRef<IncomingCall | null>(null);
  const displayedIncomingCallIdRef = useRef<string | null>(null);

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    void nativeCallService.initialize();
  }, []);

  useEffect(() => {
    void nativeCallService.setAvailability(Boolean(user));
  }, [user]);

  const showActiveCallUi = useCallback(() => {
    if (!activeCallRequest) {
      return;
    }

    setIsCallUiVisible(true);
    nativeCallService.bringAppToForeground();
  }, [activeCallRequest]);

  const hideActiveCallUi = useCallback(() => {
    setIsCallUiVisible(false);
  }, []);

  const clearActiveCall = useCallback(() => {
    debugLog('CallContext: clearing active call');
    setActiveCallRequest(null);
    setIsCallUiVisible(false);
  }, []);

  const startCallSession = useCallback((request: ActiveCallRequest) => {
    debugLog('CallContext: opening call session UI');
    setIncomingCall(null);
    setActiveCallRequest((current) => {
      if (!current) {
        return request;
      }

      if (isSameActiveCall(current, request)) {
        return current;
      }

      console.warn('CallContext: a call is already active, reusing the existing session UI.');
      return current;
    });
    setIsCallUiVisible(true);
    nativeCallService.bringAppToForeground();
  }, []);

  const dismissIncomingCall = useCallback(async () => {
    if (!incomingCallRef.current || !user) {
      setIncomingCall(null);
      return;
    }

    const currentIncomingCall = incomingCallRef.current;
    debugLog('CallContext: declining incoming call');

    const historyEntry: CallHistoryEntry = {
      callId: currentIncomingCall.callId,
      chatId: currentIncomingCall.chatId,
      groupId: currentIncomingCall.groupId,
      type: currentIncomingCall.type,
      direction: 'incoming',
      otherParticipant: {
        userId: currentIncomingCall.initiatorId,
        displayName: currentIncomingCall.initiatorName,
      },
      startedAt: currentIncomingCall.startedAt,
      endedAt: Date.now(),
      duration: 0,
      status: 'declined',
    };

    try {
      await saveCallToHistory(historyEntry);
      debugLog('CallContext: saved declined call to history');
    } catch (error) {
      console.warn('Error saving declined call to history:', error);
    }

    try {
      await nativeCallService.rejectIncomingCall(currentIncomingCall.callId);
      await declineCall(currentIncomingCall.callId);
    } catch (error) {
      console.warn('Error declining call:', error);
    } finally {
      await nativeCallService.endCall(currentIncomingCall.callId);
      nativeCallService.clearCall(currentIncomingCall.callId);
    }

    displayedIncomingCallIdRef.current = null;
    setIncomingCall(null);
  }, [user]);

  const acceptIncomingCall = useCallback(() => {
    const call = incomingCallRef.current;
    if (!call) {
      return;
    }

    debugLog('CallContext: accepting incoming call');
    setIncomingCall(null);
    startCallSession({
      chatId: call.chatId,
      groupId: call.groupId,
      type: call.type,
      joinCallId: call.callId,
    });
  }, [startCallSession]);

  // Watch for incoming calls across all user's chat threads
  useEffect(() => {
    if (!user || threads.length === 0) {
      return;
    }

    debugLog(`CallContext: watching ${threads.length} thread(s) for calls`);
    const chatIds = threads.map((thread) => thread.chatId);
    const unsubscribe = subscribeToIncomingCallForUser(user.userId, chatIds, (session) => {
      const currentIncomingCall = incomingCallRef.current;

      if (
        session &&
        session.initiatorId !== user.userId &&
        session.status === 'ringing' &&
        !session.participants.some((participant) => participant.userId === user.userId)
      ) {
        const callAge = Date.now() - session.startedAt;
        const MAX_CALL_AGE_MS = 60000;

        if (callAge > MAX_CALL_AGE_MS) {
          debugLog('CallContext: ignoring stale incoming call');
          return;
        }

        const initiator = session.participants.find((participant) => participant.userId === session.initiatorId);
        debugLog('CallContext: incoming call detected');

        setIncomingCall({
          callId: session.callId,
          chatId: session.chatId,
          groupId: session.groupId,
          initiatorId: session.initiatorId,
          initiatorName: initiator?.displayName || 'Unknown',
          type: session.type,
          startedAt: session.startedAt,
        });
        return;
      }

      if (!session || session.status === 'ended') {
        if (currentIncomingCall) {
          void nativeCallService.endCall(currentIncomingCall.callId);
          nativeCallService.clearCall(currentIncomingCall.callId);
        }
        displayedIncomingCallIdRef.current = null;
        setIncomingCall(null);
        return;
      }

      if (session.status === 'connected' && currentIncomingCall?.callId === session.callId) {
        void nativeCallService.endCall(currentIncomingCall.callId);
        displayedIncomingCallIdRef.current = null;
        setIncomingCall(null);
      }
    });

    return () => {
      debugLog('CallContext: cleanup listeners');
      unsubscribe();
    };
  }, [threads, user]);

  useEffect(() => {
    if (!incomingCall) {
      return;
    }

    if (displayedIncomingCallIdRef.current === incomingCall.callId) {
      return;
    }

    displayedIncomingCallIdRef.current = incomingCall.callId;
    void nativeCallService.displayIncomingCall(
      incomingCall.callId,
      incomingCall.initiatorId,
      incomingCall.initiatorName,
      incomingCall.type === 'video',
    );
  }, [incomingCall]);

  useEffect(() => {
    const unsubscribeAnswer = nativeCallService.subscribe('answer', ({ appCallId }) => {
      const currentIncomingCall = incomingCallRef.current;
      if (!currentIncomingCall) {
        return;
      }

      if (appCallId && appCallId !== currentIncomingCall.callId) {
        return;
      }

      acceptIncomingCall();
    });

    const unsubscribeEnd = nativeCallService.subscribe('end', ({ appCallId }) => {
      const currentIncomingCall = incomingCallRef.current;
      if (!currentIncomingCall) {
        return;
      }

      if (appCallId && appCallId !== currentIncomingCall.callId) {
        return;
      }

      void dismissIncomingCall();
    });

    return () => {
      unsubscribeAnswer();
      unsubscribeEnd();
    };
  }, [acceptIncomingCall, dismissIncomingCall]);

  return (
    <CallContext.Provider
      value={{
        incomingCall,
        activeCallRequest,
        isCallUiVisible,
        startCallSession,
        showActiveCallUi,
        hideActiveCallUi,
        clearActiveCall,
        dismissIncomingCall,
        acceptIncomingCall,
      }}
    >
      {children}
    </CallContext.Provider>
  );
};

export const useCallContext = () => {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error('useCallContext must be used within a CallProvider');
  }
  return context;
};
