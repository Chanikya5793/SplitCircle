export type CallType = 'audio' | 'video';
export type CallStatus = 'idle' | 'ringing' | 'connected' | 'ended' | 'failed';

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
  participantIds?: Record<string, boolean>;
  allowedUserIds?: Record<string, boolean>;
  type: CallType;
  status: CallStatus;
  startedAt: number;
  endedAt?: number;
  /**
   * Set by the server after the VoIP push is dispatched: 'ringing' = the
   * callee's device accepted the push (reachable → their phone is ringing),
   * 'calling' = it wasn't (offline). Drives the WhatsApp-style caller label.
   */
  deliveryState?: 'calling' | 'ringing';
  offer?: SessionDescriptionInit;
  answer?: SessionDescriptionInit;
  iceCandidates?: RTCIceCandidateInit[];
}
