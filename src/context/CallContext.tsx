import { subscribeToActiveCall } from '@/services/callService';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useChat } from './ChatContext';

interface IncomingCall {
  callId: string;
  chatId: string;
  groupId?: string;
  initiatorName: string;
  type: 'audio' | 'video';
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
          // Found an incoming call not initiated by current user
          const initiator = session.participants.find((p) => p.userId === session.initiatorId);
          setIncomingCall({
            callId: session.callId,
            chatId: session.chatId,
            groupId: session.groupId,
            initiatorName: initiator?.displayName || 'Unknown',
            type: session.type,
          });
        } else if (!session || session.status === 'ended') {
          // Call ended or not found
          setIncomingCall((prev) =>
            prev?.chatId === thread.chatId ? null : prev
          );
        }
      });
      unsubscribes.push(unsub);
    });

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [user, threads]);

  const dismissIncomingCall = useCallback(() => {
    setIncomingCall(null);
  }, []);

  const acceptCall = useCallback(() => {
    const call = incomingCall;
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
