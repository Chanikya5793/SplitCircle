export type CallType = 'audio' | 'video';
export type CallStatus = 'idle' | 'ringing' | 'connected' | 'ended' | 'failed' | 'missed' | 'rejected';
export type CallDirection = 'incoming' | 'outgoing';

export interface CallParticipant {
  userId: string;
  displayName: string;
  photoURL?: string;
  muted: boolean;
  cameraEnabled: boolean;
}

// type SessionDescriptionInit = import('react-native-webrtc/lib/typescript/RTCSessionDescription').RTCSessionDescriptionInit;
type SessionDescriptionInit = any;

export interface CallSession {
  callId: string;
  chatId: string;
  groupId?: string;
  initiatorId: string;
  participants: CallParticipant[];
  type: CallType;
  status: CallStatus;
  startedAt: number;
  endedAt?: number;
  connectedAt?: number;
  duration?: number; // Duration in seconds
  offer?: SessionDescriptionInit;
  answer?: SessionDescriptionInit;
  iceCandidates?: RTCIceCandidateInit[];
}

// Call History specific interface for display purposes
export interface CallHistoryItem {
  callId: string;
  chatId: string;
  groupId?: string;
  type: CallType;
  status: CallStatus;
  direction: CallDirection;
  startedAt: number;
  endedAt?: number;
  connectedAt?: number;
  duration?: number;
  participantName: string;
  participantAvatar?: string;
  participantIds: string[];
  isGroupCall: boolean;
}
