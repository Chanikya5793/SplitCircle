import { useAuth } from '@/context/AuthContext';
import { db } from '@/firebase';
import type { CallSession, CallStatus, CallType } from '@/models';
import { doc, updateDoc } from 'firebase/firestore';
import { useCallback, useRef, useState } from 'react';

// MOCK: react-native-webrtc is not supported in Expo Go
// import {
//     mediaDevices,
//     MediaStream,
//     MediaStreamTrack,
//     RTCIceCandidate,
//     RTCPeerConnection,
//     RTCSessionDescription,
// } from 'react-native-webrtc';

// Mock types
type MediaStream = any;
type RTCPeerConnection = any;

const ICE_SERVERS: any[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

interface UseCallManagerArgs {
  chatId?: string;
  groupId?: string;
}

export const useCallManager = ({ chatId, groupId }: UseCallManagerArgs) => {
  const { user } = useAuth();
  const connection = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CallStatus>('idle');

  // Mock implementation
  const startCall = useCallback(async (callType: CallType = 'video') => {
    console.warn('WebRTC is disabled in Expo Go');
    setStatus('ringing');
    // Simulate connection after a delay
    setTimeout(() => setStatus('connected'), 2000);
  }, []);

  const endCall = useCallback(async () => {
    setStatus('ended');
    if (chatId) {
        // Just update firestore to end it
        try {
            await updateDoc(doc(db, 'calls', chatId), {
                status: 'ended',
                endedAt: Date.now(),
            } satisfies Partial<CallSession>);
        } catch (e) {
            console.log('Error ending call', e);
        }
    }
  }, [chatId]);

  return {
    status,
    localStream,
    remoteStream,
    startCall,
    endCall,
  };
};
