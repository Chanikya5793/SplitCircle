import { useAuth } from '@/context/AuthContext';
import type { CallStatus, CallType } from '@/models';
import {
    addIceCandidate,
    createCallSession,
    getCallSession,
    ICE_SERVERS,
    joinCall,
    leaveCall,
    setCallAnswer,
    subscribeToActiveCall,
    subscribeToCallSession,
    subscribeToIceCandidates
} from '@/services/callService';
import Constants from 'expo-constants';
import { useCallback, useEffect, useRef, useState } from 'react';

// Check if we're in Expo Go (no native modules available)
const isExpoGo = Constants.appOwnership === 'expo';

// Conditionally import WebRTC - only available in development builds
let mediaDevices: any;
let MediaStream: any;
let RTCIceCandidate: any;
let RTCPeerConnection: any;
let RTCSessionDescription: any;

if (!isExpoGo) {
  try {
    const webrtc = require('react-native-webrtc');
    mediaDevices = webrtc.mediaDevices;
    MediaStream = webrtc.MediaStream;
    RTCIceCandidate = webrtc.RTCIceCandidate;
    RTCPeerConnection = webrtc.RTCPeerConnection;
    RTCSessionDescription = webrtc.RTCSessionDescription;
  } catch (e) {
    console.warn('WebRTC module not available:', e);
  }
}

interface UseCallManagerArgs {
  chatId?: string;
  groupId?: string;
}

interface UseCallManagerReturn {
  status: CallStatus;
  localStream: any;
  remoteStream: any;
  callId: string | null;
  error: string | null;
  isMuted: boolean;
  isCameraOff: boolean;
  startCall: (callType?: CallType) => Promise<void>;
  joinExistingCall: (callId: string) => Promise<void>;
  endCall: () => Promise<void>;
  toggleMute: () => void;
  toggleCamera: () => void;
}

export const useCallManager = ({ chatId, groupId }: UseCallManagerArgs): UseCallManagerReturn => {
  const { user } = useAuth();
  const peerConnection = useRef<any>(null);
  const [localStream, setLocalStream] = useState<any>(null);
  const [remoteStream, setRemoteStream] = useState<any>(null);
  const [status, setStatus] = useState<CallStatus>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [callType, setCallType] = useState<CallType>('video');
  
  const unsubscribes = useRef<Array<() => void>>([]);
  const isInitiator = useRef(false);
  const answerProcessed = useRef(false);
  const pendingIceCandidates = useRef<RTCIceCandidateInit[]>([]);
  const callIdRef = useRef<string | null>(null);

  // Cleanup subscriptions
  const cleanupSubscriptions = useCallback(() => {
    unsubscribes.current.forEach((unsub) => unsub());
    unsubscribes.current = [];
  }, []);

  // Get local media stream
  const getLocalStream = useCallback(async (type: CallType): Promise<any> => {
    if (isExpoGo || !mediaDevices) {
      // Mock stream for Expo Go
      return null;
    }
    const constraints = {
      audio: true,
      video: type === 'video' ? { facingMode: 'user', width: 640, height: 480 } : false,
    };
    
    const stream = await mediaDevices.getUserMedia(constraints);
    return stream;
  }, []);

  // Create and configure peer connection
  const createPeerConnection = useCallback((): any => {
    if (isExpoGo || !RTCPeerConnection) {
      // Return null for Expo Go
      return null;
    }
    
    const config = {
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10,
    };
    
    const pc = new RTCPeerConnection(config);
    
    // Handle ICE candidates
    pc.onicecandidate = (event: any) => {
      if (event.candidate && callIdRef.current) {
        addIceCandidate(callIdRef.current, event.candidate.toJSON(), isInitiator.current).catch(console.error);
      }
    };
    
    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      console.log('Connection state:', pc.connectionState);
      switch (pc.connectionState) {
        case 'connected':
          setStatus('connected');
          break;
        case 'disconnected':
        case 'failed':
          setStatus('failed');
          setError('Connection lost');
          break;
        case 'closed':
          setStatus('ended');
          break;
      }
    };
    
    // Handle ICE connection state
    pc.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        setError('ICE connection failed');
        setStatus('failed');
      }
    };
    
    // Handle remote stream
    pc.ontrack = (event: any) => {
      console.log('Remote track received:', event.track.kind);
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      }
    };
    
    return pc;
  }, [callId]);

  // Start a new call (as initiator)
  const startCall = useCallback(async (type: CallType = 'video') => {
    if (!chatId || !user) {
      setError('Missing chat ID or user');
      return;
    }
    
    // Mock implementation for Expo Go
    if (isExpoGo || !RTCPeerConnection) {
      console.warn('WebRTC is not available in Expo Go. Using mock implementation.');
      setError(null);
      setStatus('ringing');
      setCallType(type);
      // Simulate connection after a delay
      setTimeout(() => setStatus('connected'), 2000);
      return;
    }
    
    try {
      setError(null);
      setStatus('ringing');
      setCallType(type);
      isInitiator.current = true;
      
      // Get local media
      const stream = await getLocalStream(type);
      setLocalStream(stream);
      
      // Create peer connection
      const pc = createPeerConnection();
      if (!pc) {
        setError('Failed to create peer connection');
        setStatus('failed');
        return;
      }
      peerConnection.current = pc;
      
      // Add local tracks to peer connection
      if (stream) {
        stream.getTracks().forEach((track: any) => {
          pc.addTrack(track, stream);
        });
      }
      
      // Create offer
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: type === 'video',
      });
      await pc.setLocalDescription(offer);
      
      // Create call session in Firestore
      const newCallId = await createCallSession(
        {
          chatId,
          groupId,
          userId: user.userId,
          displayName: user.displayName || 'Unknown',
          photoURL: user.photoURL || undefined,
        },
        type,
        offer
      );
      setCallId(newCallId);
      callIdRef.current = newCallId;
      
      // Subscribe to call session updates
      const unsubSession = subscribeToCallSession(newCallId, async (session) => {
        if (!session) {
          setStatus('ended');
          return;
        }
        
        // Handle answer from remote peer
        // Check signalingState and use flag to prevent duplicate processing
        if (session.answer && !answerProcessed.current && pc.signalingState === 'have-local-offer' && RTCSessionDescription) {
          answerProcessed.current = true;
          try {
            const answerDesc = new RTCSessionDescription(session.answer);
            await pc.setRemoteDescription(answerDesc);
            
            // Process any pending ICE candidates that arrived before the answer
            for (const candidate of pendingIceCandidates.current) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (icErr) {
                console.warn('Error adding pending ICE candidate:', icErr);
              }
            }
            pendingIceCandidates.current = [];
          } catch (descErr) {
            console.error('Error setting remote description:', descErr);
            answerProcessed.current = false; // Reset on error to allow retry
          }
        }
        
        if (session.status === 'ended') {
          // Clean up local resources when remote ends the call
          if (localStream && localStream.getTracks) {
            localStream.getTracks().forEach((track: any) => track.stop());
            setLocalStream(null);
          }
          if (peerConnection.current) {
            peerConnection.current.close();
            peerConnection.current = null;
          }
          cleanupSubscriptions();
          setRemoteStream(null);
          setStatus('ended');
          setCallId(null);
          callIdRef.current = null;
          isInitiator.current = false;
          answerProcessed.current = false;
          pendingIceCandidates.current = [];
        }
      });
      unsubscribes.current.push(unsubSession);
      
      // Subscribe to ICE candidates from answerer
      const unsubCandidates = subscribeToIceCandidates(newCallId, true, async (candidate) => {
        try {
          // Only add ICE candidates after remote description is set
          if (pc.remoteDescription && pc.signalingState === 'stable') {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } else {
            // Queue candidates that arrive before remote description
            pendingIceCandidates.current.push(candidate);
          }
        } catch (err) {
          console.warn('Error adding ICE candidate:', err);
        }
      });
      unsubscribes.current.push(unsubCandidates);
      
    } catch (err) {
      console.error('Error starting call:', err);
      setError(err instanceof Error ? err.message : 'Failed to start call');
      setStatus('failed');
    }
  }, [chatId, groupId, user, getLocalStream, createPeerConnection]);

  // Join an existing call (as answerer)
  const joinExistingCall = useCallback(async (existingCallId: string) => {
    if (!user) {
      setError('User not authenticated');
      return;
    }
    
    // Mock implementation for Expo Go
    if (isExpoGo || !RTCPeerConnection) {
      console.warn('WebRTC is not available in Expo Go. Using mock implementation.');
      setError(null);
      setStatus('ringing');
      setCallId(existingCallId);
      // Simulate connection after a delay
      setTimeout(() => setStatus('connected'), 1500);
      return;
    }
    
    try {
      setError(null);
      setStatus('ringing');
      isInitiator.current = false;
      setCallId(existingCallId);
      callIdRef.current = existingCallId;
      
      // Get call session
      const session = await getCallSession(existingCallId);
      if (!session) {
        setError('Call not found');
        setStatus('failed');
        return;
      }
      
      if (session.status === 'ended') {
        setError('Call has ended');
        setStatus('ended');
        return;
      }
      
      setCallType(session.type);
      
      // Get local media
      const stream = await getLocalStream(session.type);
      setLocalStream(stream);
      
      // Create peer connection
      const pc = createPeerConnection();
      if (!pc) {
        setError('Failed to create peer connection');
        setStatus('failed');
        return;
      }
      peerConnection.current = pc;
      
      // Add local tracks
      if (stream) {
        stream.getTracks().forEach((track: any) => {
          pc.addTrack(track, stream);
        });
      }
      
      // Set remote description from offer
      if (session.offer && RTCSessionDescription) {
        const offerDesc = new RTCSessionDescription(session.offer);
        await pc.setRemoteDescription(offerDesc);
      }
      
      // Create and set answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      // Save answer to Firestore
      await setCallAnswer(existingCallId, answer);
      
      // Join the call
      await joinCall(existingCallId, {
        userId: user.userId,
        displayName: user.displayName || 'Unknown',
        photoURL: user.photoURL || undefined,
        muted: false,
        cameraEnabled: session.type === 'video',
      });
      
      // Subscribe to call session updates
      const unsubSession = subscribeToCallSession(existingCallId, (updatedSession) => {
        if (!updatedSession || updatedSession.status === 'ended') {
          // Clean up local resources when remote ends the call
          if (localStream && localStream.getTracks) {
            localStream.getTracks().forEach((track: any) => track.stop());
            setLocalStream(null);
          }
          if (peerConnection.current) {
            peerConnection.current.close();
            peerConnection.current = null;
          }
          cleanupSubscriptions();
          setRemoteStream(null);
          setStatus('ended');
          setCallId(null);
          callIdRef.current = null;
          isInitiator.current = false;
          answerProcessed.current = false;
          pendingIceCandidates.current = [];
        }
      });
      unsubscribes.current.push(unsubSession);
      
      // Subscribe to ICE candidates from offerer
      const unsubCandidates = subscribeToIceCandidates(existingCallId, false, async (candidate) => {
        try {
          if (pc.remoteDescription && RTCIceCandidate) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          }
        } catch (err) {
          console.warn('Error adding ICE candidate:', err);
        }
      });
      unsubscribes.current.push(unsubCandidates);
      
    } catch (err) {
      console.error('Error joining call:', err);
      setError(err instanceof Error ? err.message : 'Failed to join call');
      setStatus('failed');
    }
  }, [user, getLocalStream, createPeerConnection]);

  // End the call
  const endCall = useCallback(async () => {
    try {
      // Stop local stream tracks
      if (localStream && localStream.getTracks) {
        localStream.getTracks().forEach((track: any) => track.stop());
        setLocalStream(null);
      }
      
      // Close peer connection
      if (peerConnection.current) {
        peerConnection.current.close();
        peerConnection.current = null;
      }
      
      // Cleanup subscriptions
      cleanupSubscriptions();
      
      // Update Firestore
      if (callId && user) {
        await leaveCall(callId, user.userId);
      }
      
      setRemoteStream(null);
      setStatus('ended');
      setCallId(null);
      callIdRef.current = null;
      isInitiator.current = false;
      answerProcessed.current = false;
      pendingIceCandidates.current = [];
      
    } catch (err) {
      console.error('Error ending call:', err);
    }
  }, [callId, user, localStream, cleanupSubscriptions]);

  // Toggle mute
  const toggleMute = useCallback(() => {
    if (localStream && localStream.getAudioTracks) {
      localStream.getAudioTracks().forEach((track: any) => {
        track.enabled = !track.enabled;
      });
      setIsMuted((prev) => !prev);
    } else {
      // Mock toggle for Expo Go
      setIsMuted((prev) => !prev);
    }
  }, [localStream]);

  // Toggle camera
  const toggleCamera = useCallback(() => {
    if (localStream && localStream.getVideoTracks && callType === 'video') {
      localStream.getVideoTracks().forEach((track: any) => {
        track.enabled = !track.enabled;
      });
      setIsCameraOff((prev) => !prev);
    } else if (callType === 'video') {
      // Mock toggle for Expo Go
      setIsCameraOff((prev) => !prev);
    }
  }, [localStream, callType]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupSubscriptions();
      if (localStream && localStream.getTracks) {
        localStream.getTracks().forEach((track: any) => track.stop());
      }
      if (peerConnection.current) {
        peerConnection.current.close();
      }
    };
  }, []);

  // Watch for incoming calls
  useEffect(() => {
    if (!chatId || status !== 'idle') {
      return;
    }
    
    const unsubscribe = subscribeToActiveCall(chatId, (session) => {
      if (session && session.initiatorId !== user?.userId && session.status === 'ringing') {
        // There's an incoming call - the UI should handle this
        console.log('Incoming call detected:', session.callId);
      }
    });
    
    return () => unsubscribe();
  }, [chatId, user?.userId, status]);

  return {
    status,
    localStream,
    remoteStream,
    callId,
    error,
    isMuted,
    isCameraOff,
    startCall,
    joinExistingCall,
    endCall,
    toggleMute,
    toggleCamera,
  };
};
