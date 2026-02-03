import { useAuth } from '@/context/AuthContext';
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
import { AudioSession } from '@livekit/react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  const otherParticipantRef = useRef<{ userId: string; displayName: string } | null>(null);
  const isInitiatorRef = useRef<boolean>(false);
  const unsubscribes = useRef<Array<() => void>>([]);

  // Cleanup subscriptions
  const cleanupSubscriptions = useCallback(() => {
    console.log('📞 Cleaning up call subscriptions');
    unsubscribes.current.forEach((unsub) => unsub());
    unsubscribes.current = [];
  }, []);

  // Start a new call (as initiator)
  const startCall = useCallback(async (type: CallType = 'video') => {
    if (!chatId || !user) {
      console.error('📞 Cannot start call: Missing chat ID or user');
      setError('Missing chat ID or user');
      return;
    }

    console.log(`📞 Starting ${type} call for chat: ${chatId}`);

    try {
      setError(null);
      setStatus('ringing'); // UI shows "Calling..."
      setCallType(type);
      isInitiatorRef.current = true;
      callStartedAtRef.current = Date.now();

      // 1. Create Call Session in Realtime DB (Ringing)
      console.log('📞 Creating call session in Realtime DB...');
      const newCallId = await createCallSession(
        {
          chatId,
          groupId,
          userId: user.userId,
          displayName: user.displayName || 'Unknown',
          photoURL: user.photoURL || undefined,
        },
        type
      );
      console.log(`📞 Call session created: ${newCallId}`);
      setCallId(newCallId);
      callIdRef.current = newCallId;

      // 2. Fetch LiveKit Token
      console.log('📞 Fetching LiveKit token...');
      const { token: roomToken, url } = await LiveKitService.getToken(
        newCallId,
        user.userId,
        user.displayName || 'User'
      );
      console.log(`📞 Token received! Server URL: ${url}`);
      setToken(roomToken);
      setServerUrl(url);

      // 3. Start Audio Session
      console.log('📞 Starting audio session...');
      await AudioSession.startAudioSession();
      console.log('📞 Audio session started');

      // 4. Subscribe to Call Session to see if answered or ended
      const unsubSession = subscribeToCallSession(newCallId, async (session) => {
        console.log(`📞 Call session update: status=${session?.status}`);
        if (!session || session.status === 'ended') {
          console.log('📞 Call ended by Realtime DB update');
          endCall();
          return;
        }
        if (session.status === 'connected') {
          console.log('📞 Call connected! Other party joined.');
          setStatus('connected');
          // Track other participant for history
          const other = session.participants.find(p => p.userId !== user.userId);
          if (other) {
            otherParticipantRef.current = { userId: other.userId, displayName: other.displayName };
          }
        }
      });
      unsubscribes.current.push(unsubSession);

    } catch (err) {
      console.error('📞 Error starting call:', err);
      setError(err instanceof Error ? err.message : 'Failed to start call');
      setStatus('failed');
    }
  }, [chatId, groupId, user, cleanupSubscriptions]);

  // Join an existing call (as answerer)
  const joinExistingCall = useCallback(async (existingCallId: string) => {
    if (!user) {
      console.error('📞 Cannot join call: User not authenticated');
      setError('User not authenticated');
      return;
    }

    console.log(`📞 Joining existing call: ${existingCallId}`);

    try {
      setError(null);
      setStatus('ringing');
      setCallId(existingCallId);
      callIdRef.current = existingCallId;
      isInitiatorRef.current = false;
      callStartedAtRef.current = Date.now();

      const session = await getCallSession(existingCallId);
      if (!session) {
        console.error('📞 Call not found');
        setError('Call not found');
        setStatus('ended');
        return;
      }
      if (session.status === 'ended') {
        console.error('📞 Call already ended');
        setError('Call already ended');
        setStatus('ended');
        return;
      }

      console.log(`📞 Call found: type=${session.type}, status=${session.status}`);
      setCallType(session.type);

      // Track initiator as other participant for history
      const initiator = session.participants.find(p => p.userId === session.initiatorId);
      if (initiator) {
        otherParticipantRef.current = { userId: initiator.userId, displayName: initiator.displayName };
      }

      // 1. Fetch LiveKit Token
      console.log('📞 Fetching LiveKit token for joining...');
      const { token: roomToken, url } = await LiveKitService.getToken(
        existingCallId,
        user.userId,
        user.displayName || 'User'
      );
      console.log(`📞 Token received! Server URL: ${url}`);
      setToken(roomToken);
      setServerUrl(url);

      // 2. Start Audio Session
      console.log('📞 Starting audio session...');
      await AudioSession.startAudioSession();
      console.log('📞 Audio session started');

      // 3. Update Realtime DB (Join) - This also updates status to 'connected'
      console.log('📞 Joining call in Realtime DB...');
      await joinCall(existingCallId, {
        userId: user.userId,
        displayName: user.displayName || 'Unknown',
        muted: false,
        cameraEnabled: session.type === 'video',
      });
      console.log('📞 Joined call successfully!');
      setStatus('connected'); // Immediately set to connected since we just joined

      // 4. Subscribe to session for further updates
      const unsubSession = subscribeToCallSession(existingCallId, (updatedSession) => {
        console.log(`📞 Call session update: status=${updatedSession?.status}`);
        if (!updatedSession || updatedSession.status === 'ended') {
          console.log('📞 Call ended by Realtime DB update');
          endCall();
        }
      });
      unsubscribes.current.push(unsubSession);

    } catch (err) {
      console.error('📞 Error joining call:', err);
      setError(err instanceof Error ? err.message : 'Failed to join call');
      setStatus('failed');
    }
  }, [user, cleanupSubscriptions]);

  // End the call
  const endCall = useCallback(async () => {
    console.log('📞 Ending call...');
    try {
      cleanupSubscriptions();

      // Save call history locally before deleting from Realtime DB
      if (callIdRef.current && user && callStartedAtRef.current && chatId) {
        const endedAt = Date.now();
        const duration = Math.floor((endedAt - callStartedAtRef.current) / 1000);

        const historyEntry: CallHistoryEntry = {
          callId: callIdRef.current,
          chatId,
          groupId,
          type: callType,
          direction: isInitiatorRef.current ? 'outgoing' : 'incoming',
          otherParticipant: otherParticipantRef.current || { userId: 'unknown', displayName: 'Unknown' },
          startedAt: callStartedAtRef.current,
          endedAt,
          duration,
          status: duration > 0 ? 'completed' : 'missed',
        };

        console.log(`📞 Saving call to local history: ${callIdRef.current}`);
        await saveCallToHistory(historyEntry);
      }

      // Delete signaling from Realtime DB
      if (callIdRef.current && user) {
        console.log(`📞 Deleting call from Realtime DB: ${callIdRef.current}`);
        await leaveCall(callIdRef.current, user.userId);
      }

      setToken(null);
      setServerUrl(null);
      setStatus('ended');
      setCallId(null);
      callIdRef.current = null;
      callStartedAtRef.current = null;
      otherParticipantRef.current = null;

      console.log('📞 Stopping audio session...');
      AudioSession.stopAudioSession();
      console.log('📞 Call ended successfully');

    } catch (err) {
      console.error('📞 Error ending call:', err);
    }
  }, [user, chatId, groupId, callType, cleanupSubscriptions]);

  // Local state toggles (actual media toggle happens in the UI via LiveKitRoom)
  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      console.log(`📞 Toggle mute: ${!prev ? 'muted' : 'unmuted'}`);
      return !prev;
    });
  }, []);

  const toggleCamera = useCallback(() => {
    setIsCameraOff((prev) => {
      console.log(`📞 Toggle camera: ${!prev ? 'off' : 'on'}`);
      return !prev;
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      endCall();
    };
  }, []);

  // Watch for incoming calls
  useEffect(() => {
    if (!chatId || status !== 'idle') {
      return;
    }

    const unsubscribe = subscribeToActiveCall(chatId, (session) => {
      if (session && session.initiatorId !== user?.userId && session.status === 'ringing') {
        console.log('📞 Incoming call detected:', session.callId);
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
