import { declineCall, subscribeToActiveCall } from '@/services/callService';
import { saveCallToHistory, type CallHistoryEntry } from '@/services/localCallStorage';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useChat } from './ChatContext';

interface IncomingCall {
  callId: string;
  chatId: string;
  groupId?: string;
  initiatorId: string;
  initiatorName: string;
  type: 'audio' | 'video';
  startedAt: number;
}

interface CallContextValue {
  incomingCall: IncomingCall | null;
  dismissIncomingCall: () => void;
  acceptCall: () => IncomingCall | null;
}

const CallContext = createContext<CallContextValue | null>(null);

export const CallProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const { threads } = useChat();
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);

  // Watch for incoming calls across all user's chat threads
  useEffect(() => {
    if (!user || threads.length === 0) {
      return;
    }

    console.log(`📲 CallContext: Setting up call listeners for ${threads.length} threads`);
    const unsubscribes: Array<() => void> = [];

    // Subscribe to active calls for each thread
    threads.forEach((thread) => {
      const unsub = subscribeToActiveCall(thread.chatId, (session) => {
        if (
          session &&
          session.initiatorId !== user.userId &&
          session.status === 'ringing' &&
          !session.participants.some((p) => p.userId === user.userId)
        ) {
          // Check if call is recent (within last 60 seconds to avoid stale calls)
          const callAge = Date.now() - session.startedAt;
          const MAX_CALL_AGE_MS = 60000; // 60 seconds

          if (callAge > MAX_CALL_AGE_MS) {
            console.log(`📲 Ignoring stale call ${session.callId} (age: ${Math.round(callAge / 1000)}s)`);
            return;
          }

          // Found an incoming call not initiated by current user
          const initiator = session.participants.find((p) => p.userId === session.initiatorId);
          console.log(`📲 INCOMING CALL DETECTED!`);
          console.log(`   - callId: ${session.callId}`);
          console.log(`   - chatId: ${session.chatId}`);
          console.log(`   - from: ${initiator?.displayName || 'Unknown'}`);
          console.log(`   - type: ${session.type}`);
          console.log(`   - age: ${Math.round(callAge / 1000)}s`);

          setIncomingCall({
            callId: session.callId,
            chatId: session.chatId,
            groupId: session.groupId,
            initiatorId: session.initiatorId,
            initiatorName: initiator?.displayName || 'Unknown',
            type: session.type,
            startedAt: session.startedAt,
          });
        } else if (!session || session.status === 'ended') {
          // Call ended or not found
          setIncomingCall((prev) =>
            prev?.chatId === thread.chatId ? null : prev
          );
        } else if (session && session.status === 'connected') {
          // Call was answered, clear the incoming call if it's ours
          setIncomingCall((prev) =>
            prev?.callId === session.callId ? null : prev
          );
        }
      });
      unsubscribes.push(unsub);
    });

    return () => {
      console.log(`📲 CallContext: Cleaning up call listeners`);
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [user, threads]);

  // Dismiss = decline the call and save as missed
  const dismissIncomingCall = useCallback(async () => {
    if (!incomingCall || !user) {
      setIncomingCall(null);
      return;
    }

    console.log(`📲 Declining incoming call: ${incomingCall.callId}`);

    // Save as missed call in local history
    const historyEntry: CallHistoryEntry = {
      callId: incomingCall.callId,
      chatId: incomingCall.chatId,
      groupId: incomingCall.groupId,
      type: incomingCall.type,
      direction: 'incoming',
      otherParticipant: {
        userId: incomingCall.initiatorId,
        displayName: incomingCall.initiatorName,
      },
      startedAt: incomingCall.startedAt,
      endedAt: Date.now(),
      duration: 0,
      status: 'declined',
    };

    try {
      await saveCallToHistory(historyEntry);
      console.log(`📲 Saved declined call to history`);
    } catch (error) {
      console.warn('Error saving declined call to history:', error);
    }

    // Notify the caller that call was declined
    try {
      await declineCall(incomingCall.callId);
    } catch (error) {
      console.warn('Error declining call:', error);
    }

    setIncomingCall(null);
  }, [incomingCall, user]);

  const acceptCall = useCallback(() => {
    const call = incomingCall;
    if (call) {
      console.log(`📲 ACCEPTING CALL: ${call.callId}`);
    }
    setIncomingCall(null);
    return call;
  }, [incomingCall]);

  return (
    <CallContext.Provider value={{ incomingCall, dismissIncomingCall, acceptCall }}>
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
