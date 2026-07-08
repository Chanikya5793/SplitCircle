import { ackCallRinging, declineCall, getCallSessionOutcome, subscribeToIncomingCallForUser } from '@/services/callService';
import { saveCallToHistory, type CallHistoryEntry } from '@/services/localCallStorage';
import { nativeCallService } from '@/services/nativeCallService';
import { voipPushService } from '@/services/voipPushService';
import { startVoipPushRegistration } from '@/services/voipPushRegistration';
import { MISSED_CALL_CATEGORY_ID, scheduleLocalNotification } from '@/utils/notifications';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
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

// Callee-side ring timeout. Slightly LONGER than the caller's 45s
// RING_TIMEOUT_MS (useCallManager) so the caller-initiated teardown is always
// the primary path; this timer is the belt-and-braces fallback for a callee
// whose RTDB listener never connected (woken from kill by the VoIP push,
// no/flaky network) so the CallKit ring can't spin forever.
const CALLEE_RING_TIMEOUT_MS = 60_000;

interface RecentsStartCallRequest {
  handle: string;
  nativeCallId: string | null;
  hasVideo: boolean;
}

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
  const [recentsStartCall, setRecentsStartCall] = useState<RecentsStartCallRequest | null>(null);

  const incomingCallRef = useRef<IncomingCall | null>(null);
  const displayedIncomingCallIdRef = useRef<string | null>(null);

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    void nativeCallService.initialize();
    voipPushService.initialize();
  }, []);

  useEffect(() => {
    void nativeCallService.setAvailability(Boolean(user));
    startVoipPushRegistration(user?.userId ?? null);
  }, [user]);

  // VoIP-pushed incoming calls. The AppDelegate already reports them to CallKit
  // synchronously (mandatory iOS contract); here we mirror the payload into JS
  // state so when the user accepts on the lock-screen we have everything we
  // need to join the LiveKit room without waiting on Realtime DB to roundtrip.
  useEffect(() => {
    if (!user) return;
    const unsubscribe = voipPushService.onIncomingPush((push) => {
      const payload = push.payload as Record<string, unknown>;
      const callId = (payload.callId ?? payload.uuid) as string | undefined;
      const chatId = payload.chatId as string | undefined;
      if (!callId || !chatId) return;

      const initiatorId = (payload.initiatorId as string | undefined) ?? '';
      if (initiatorId === user.userId) return; // shouldn't happen but guard

      const callTypeRaw = payload.callType as string | undefined;
      const type: 'audio' | 'video' = callTypeRaw === 'video' ? 'video' : 'audio';

      const synthesized: IncomingCall = {
        callId,
        chatId,
        groupId: (payload.groupId as string | undefined) || undefined,
        initiatorId,
        initiatorName: (payload.initiatorName as string | undefined)
          || (payload.callerName as string | undefined)
          || 'Incoming call',
        type,
        startedAt: Date.now(),
      };

      // Only adopt the VoIP payload if we don't already have richer state from
      // the RTDB subscription. This keeps the two paths idempotent.
      if (!incomingCallRef.current || incomingCallRef.current.callId !== callId) {
        debugLog('CallContext: VoIP push primed incoming call', callId);
        setIncomingCall(synthesized);
      }

      // Reconcile against the LIVE call state ASAP. The AppDelegate reported
      // this push to CallKit unconditionally (mandatory iOS 13 contract), but
      // the caller may have hung up before we woke, or the push may have been
      // stored by APNs while this device was offline. Only a DEFINITIVE
      // answer dismisses the ring — read errors (auth still restoring on a
      // cold start, no network) are inconclusive and fall through to the
      // callee ring-timeout instead of killing a legitimate call.
      void (async () => {
        const outcome = await getCallSessionOutcome(callId);

        const dismissDeadCall = (reason: string) => {
          debugLog(`CallContext: VoIP push refers to a dead call (${reason}) — dismissing`, callId);
          void nativeCallService.endCall(callId);
          nativeCallService.clearCall(callId);
          if (incomingCallRef.current?.callId === callId) {
            incomingCallRef.current = null;
            displayedIncomingCallIdRef.current = null;
            setIncomingCall(null);
          }
        };

        if (outcome.kind === 'missing') {
          dismissDeadCall('no longer exists');
          return;
        }

        if (outcome.kind === 'error') {
          debugLog('CallContext: VoIP live-check inconclusive; relying on ring timeout', callId);
          return;
        }

        const session = outcome.session;
        if (session.status === 'ended' || session.status === 'failed') {
          dismissDeadCall(`status ${session.status}`);
          return;
        }

        // Already connected with THIS user as a participant → the call was
        // answered (here or on another device of this account) before the
        // reconcile ran. Clear the synthesized incoming state WITHOUT touching
        // the native call: ending it would issue a CXEndCallAction on the
        // live call's UUID, and leaving the synthesized state in place would
        // let the RTDB "answered elsewhere" branch do the same a moment later.
        if (
          session.status === 'connected'
          && session.participants.some((participant) => participant.userId === user.userId)
        ) {
          debugLog('CallContext: VoIP push for an already-answered call — clearing synthesized state', callId);
          if (incomingCallRef.current?.callId === callId) {
            incomingCallRef.current = null;
            displayedIncomingCallIdRef.current = null;
            setIncomingCall(null);
          }
          return;
        }

        if (Date.now() - session.startedAt > CALLEE_RING_TIMEOUT_MS && session.status === 'ringing') {
          dismissDeadCall('outside ring window');
          return;
        }
      })();
    });

    return unsubscribe;
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

    // Closest iOS-allowed equivalent of a lock-screen "Message" button
    // (which Apple reserves for SMS on phone-number handles): right after a
    // decline, drop a local notification carrying the quick-reply category so
    // the user can pull it down and text the caller without opening the app.
    if (Platform.OS !== 'web') {
      try {
        await scheduleLocalNotification(
          currentIncomingCall.initiatorName,
          currentIncomingCall.type === 'video'
            ? '📹 You declined a video call — pull down to reply'
            : '📞 You declined a voice call — pull down to reply',
          {
            type: 'missed_call',
            chatId: currentIncomingCall.chatId,
            groupId: currentIncomingCall.groupId,
            callId: currentIncomingCall.callId,
            callType: currentIncomingCall.type,
            senderId: currentIncomingCall.initiatorId,
            senderName: currentIncomingCall.initiatorName,
          },
          'calls',
          MISSED_CALL_CATEGORY_ID,
        );
      } catch (error) {
        console.warn('Failed to schedule declined-call reply notification:', error);
      }
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
    // Clear the ref SYNCHRONOUSLY (not just via setState, which lags a frame):
    // joining flips the session to 'connected', and the RTDB echo would
    // otherwise still see this incoming call and fire nativeCallService.endCall
    // — which issues a real CXEndCallAction and tears down the call we just
    // answered (the "hangs up as soon as answered" bug).
    incomingCallRef.current = null;
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

    // Device-ack: this device is now ACTUALLY presenting the incoming call
    // (CallKit banner / in-app ringer), so tell the caller their peer is
    // ringing. This — not APNs accepting the push — is what flips the
    // caller's UI from "Calling…" to "Ringing…" (WhatsApp behavior). The
    // write itself re-checks that the call is still in 'ringing' status.
    void ackCallRinging(incomingCall.callId);
  }, [incomingCall]);

  // Callee-side ring timeout: never let the CallKit ring spin forever when
  // cancel signals can't reach us (app woken from kill with no listener yet,
  // caller offline mid-cancel). Anchored to the call's startedAt so a call
  // adopted late times out sooner rather than ringing a full extra minute.
  useEffect(() => {
    if (!incomingCall) {
      return;
    }

    const timeoutCallId = incomingCall.callId;
    const remainingMs = Math.max(5_000, incomingCall.startedAt + CALLEE_RING_TIMEOUT_MS - Date.now());
    const timer = setTimeout(() => {
      const current = incomingCallRef.current;
      if (!current || current.callId !== timeoutCallId) {
        return;
      }

      debugLog('CallContext: callee ring timeout — dismissing as missed', timeoutCallId);
      void nativeCallService.endCall(timeoutCallId);
      nativeCallService.clearCall(timeoutCallId);
      incomingCallRef.current = null;
      displayedIncomingCallIdRef.current = null;
      setIncomingCall(null);

      void saveCallToHistory({
        callId: current.callId,
        chatId: current.chatId,
        groupId: current.groupId,
        type: current.type,
        direction: 'incoming',
        otherParticipant: {
          userId: current.initiatorId,
          displayName: current.initiatorName,
        },
        startedAt: current.startedAt,
        endedAt: Date.now(),
        duration: 0,
        status: 'missed',
      }).catch((error) => {
        console.warn('Error saving missed call to history:', error);
      });
    }, remainingMs);

    return () => clearTimeout(timer);
  }, [incomingCall]);

  // iOS Phone-app Recents redial (CallKeep didReceiveStartCallAction). The
  // event delivers only the handle we reported the original call with (peer
  // userId for 1:1, chatId for groups). Park the request in state and resolve
  // it in the effect below once threads are available — cold starts deliver
  // the buffered event long before ChatContext has loaded anything.
  useEffect(() => {
    const unsubscribeStartCall = nativeCallService.subscribe('startCall', (payload) => {
      debugLog('CallContext: Recents start-call action received');
      setRecentsStartCall(payload);
    });

    return unsubscribeStartCall;
  }, []);

  useEffect(() => {
    if (!recentsStartCall || !user) {
      return;
    }

    if (threads.length === 0) {
      // Threads not loaded yet (cold start) — keep the request parked; this
      // effect re-runs when ChatContext delivers them.
      return;
    }

    const { handle, nativeCallId, hasVideo } = recentsStartCall;
    setRecentsStartCall(null);

    // CXStartCallAction path creates a placeholder CallKit call; dismiss it —
    // the normal outgoing flow below reports its own call with the app's
    // deterministic UUID. (The Recents/INStartCallIntent path has no UUID.)
    if (nativeCallId) {
      void nativeCallService.dismissNativeCall(nativeCallId);
    }

    if (activeCallRequest) {
      debugLog('CallContext: ignoring Recents redial — a call is already active');
      return;
    }

    const thread = threads.find((candidate) => candidate.chatId === handle)
      ?? threads.find((candidate) =>
        candidate.type === 'direct'
        && handle !== user.userId
        && candidate.participantIds.includes(handle));

    if (!thread) {
      console.warn('CallContext: could not resolve Recents redial handle to a chat');
      return;
    }

    debugLog('CallContext: launching call from Recents redial');
    startCallSession({
      chatId: thread.chatId,
      groupId: thread.groupId,
      type: hasVideo ? 'video' : 'audio',
    });
  }, [recentsStartCall, threads, user, activeCallRequest, startCallSession]);

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
