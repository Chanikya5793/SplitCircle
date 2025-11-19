export type CallType = 'audio' | 'video';
export type CallStatus = 'idle' | 'ringing' | 'connected' | 'ended' | 'failed';

export interface CallParticipant {
  userId: string;
  displayName: string;
  photoURL?: string;
  muted: boolean;
  cameraEnabled: boolean;
}

type SessionDescriptionInit = import('react-native-webrtc/lib/typescript/RTCSessionDescription').RTCSessionDescriptionInit;

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
  offer?: SessionDescriptionInit;
  answer?: SessionDescriptionInit;
  iceCandidates?: RTCIceCandidateInit[];
}
