import { useAuth } from '@/context/AuthContext';
import { db } from '@/firebase';
import type { CallSession, CallStatus, CallType } from '@/models';
import { addDoc, collection, doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    mediaDevices,
    MediaStream,
    MediaStreamTrack,
    RTCIceCandidate,
    RTCPeerConnection,
    RTCSessionDescription,
} from 'react-native-webrtc';

const ICE_SERVERS: RTCConfiguration['iceServers'] = [
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

  const initMediaStream = useCallback(async () => {
    if (localStream.current) {
      return localStream.current;
    }
    const stream = await mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    localStream.current = stream;
    return stream;
  }, []);

  const setupConnection = useCallback(
    async (chatKey: string, currentUserId?: string) => {
      if (connection.current) {
        return connection.current;
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const stream = await initMediaStream();
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const inboundStream = new MediaStream();
      (pc as any).addEventListener('track', (event: any) => {
        event.streams[0]?.getTracks().forEach((track: MediaStreamTrack) => inboundStream.addTrack(track));
      });

      (pc as any).addEventListener('icecandidate', async (event: any) => {
        if (!event.candidate || !chatKey || !currentUserId) {
          return;
        }
        try {
          await addDoc(collection(db, 'calls', chatKey, 'candidates'), {
            candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
            userId: currentUserId,
          });
        } catch (error) {
          console.warn('Failed to publish ICE candidate', error);
        }
      });

      remoteStream.current = inboundStream;
      connection.current = pc;
      return pc;
    },
    [initMediaStream],
  );

  const startCall = useCallback(
    async (callType: CallType = 'video') => {
      if (!chatId || !user) {
        return;
      }
      const pc = await setupConnection(chatId, user.userId);
      const offer = await pc.createOffer();
      const rtcOffer = new RTCSessionDescription(offer);
      await pc.setLocalDescription(rtcOffer);
      setStatus('ringing');

      await setDoc(doc(db, 'calls', chatId), {
        callId: chatId,
        chatId,
        groupId,
        initiatorId: user.userId,
        participants: [
          {
            userId: user.userId,
            displayName: user.displayName,
            photoURL: user.photoURL,
            muted: false,
            cameraEnabled: callType === 'video',
          },
        ],
        type: callType,
        status: 'ringing',
        startedAt: Date.now(),
        offer: rtcOffer.toJSON(),
      } satisfies Partial<CallSession>);
    },
    [chatId, groupId, setupConnection, user],
  );

  const endCall = useCallback(async () => {
    setStatus('ended');
    connection.current?.close();
    connection.current = null;
    localStream.current?.getTracks().forEach((track) => track.stop());
    remoteStream.current = null;
    if (chatId) {
      await updateDoc(doc(db, 'calls', chatId), {
        status: 'ended',
        endedAt: Date.now(),
      } satisfies Partial<CallSession>);
    }
  }, [chatId]);

  useEffect(() => {
    if (!chatId) {
      return () => undefined;
    }

    const unsub = onSnapshot(doc(db, 'calls', chatId), async (snapshot) => {
      const payload = snapshot.data() as CallSession | undefined;
      if (!payload) {
        return;
      }

      if (payload.status === 'ringing' && payload.offer && payload.initiatorId !== user?.userId) {
        const pc = await setupConnection(chatId, user?.userId);
        await pc.setRemoteDescription(new RTCSessionDescription(payload.offer));
        const answer = await pc.createAnswer();
        const rtcAnswer = new RTCSessionDescription(answer);
        await pc.setLocalDescription(rtcAnswer);
        await updateDoc(doc(db, 'calls', chatId), {
          answer: rtcAnswer.toJSON(),
          status: 'connected',
        });
        setStatus('connected');
      }

      if (payload.answer && connection.current && connection.current.signalingState !== 'stable') {
        await connection.current.setRemoteDescription(new RTCSessionDescription(payload.answer));
        setStatus('connected');
      }

      if (payload.status === 'ended') {
        endCall();
      }
    });

    return () => unsub();
  }, [chatId, endCall, setupConnection, user?.userId]);

  useEffect(() => {
    if (!chatId) {
      return () => undefined;
    }
    const candidatesRef = collection(db, 'calls', chatId, 'candidates');
    const unsubscribe = onSnapshot(candidatesRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const data = change.doc.data() as { candidate?: RTCIceCandidateInit; userId?: string };
        if (!data.candidate || data.userId === user?.userId) {
          return;
        }
        if (connection.current) {
          connection.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      });
    });
    return () => unsubscribe();
  }, [chatId, user?.userId]);

  return {
    status,
    localStream,
    remoteStream,
    startCall,
    endCall,
  };
};
