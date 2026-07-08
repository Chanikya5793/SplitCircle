// Web shim for @livekit/react-native and @livekit/react-native-webrtc.
// The native LiveKit SDK evaluates requireNativeComponent at import time,
// which react-native-web 0.21 no longer provides, crashing the whole web
// bundle. Calls are a native-only feature; on web these no-op stand-ins keep
// the rest of the app (auth, groups, expenses, chat) working.

const noOpAsync = async () => undefined;

export const registerGlobals = () => undefined;

export const AudioSession = new Proxy(
  {},
  {
    get: () => noOpAsync,
  },
);

export const LiveKitRoom = () => null;
export const VideoTrack = () => null;
export const AudioTrack = () => null;
export const VideoView = () => null;

export const isTrackReference = () => false;
export const useConnectionState = () => 'disconnected';
export const useParticipants = () => [];
export const useTracks = () => [];
export const useRoomContext = () => null;
export const useLocalParticipant = () => ({ localParticipant: null });
export const useRemoteParticipants = () => [];

// @livekit/react-native-webrtc surface (only reached via gated requires).
export const RTCAudioSession = null;
export const RTCView = () => null;
export const mediaDevices = {
  getUserMedia: async () => {
    throw new Error('WebRTC via @livekit/react-native-webrtc is not available on web');
  },
  enumerateDevices: async () => [],
};

export default {
  registerGlobals,
  AudioSession,
  LiveKitRoom,
  VideoTrack,
  AudioTrack,
  VideoView,
  isTrackReference,
  useConnectionState,
  useParticipants,
  useTracks,
  useRoomContext,
  useLocalParticipant,
  useRemoteParticipants,
  RTCAudioSession,
  RTCView,
  mediaDevices,
};
