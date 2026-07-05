import { CallControls } from '@/components/CallControls';
import { GroupAvatar, UserAvatar } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { maskTextValue } from '@/services/privacyGuardService';
import { useCallManager } from '@/hooks/useCallManager';
import type { CallStatus, CallType } from '@/models';
import {
  AudioSession,
  LiveKitRoom,
  isTrackReference,
  useConnectionState,
  useParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
} from '@livekit/react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ConnectionState, Track } from 'livekit-client';

/**
 * Present iOS's system audio-route picker (AVRoutePickerView) so the user can
 * send call audio to the speaker, earpiece, AirPods, a Bluetooth headset, or
 * Ray-Ban Meta glasses — exactly like the Phone/WhatsApp output picker. Wrapped
 * so an older binary lacking the native method falls back to toggling the
 * built-in speaker instead of crashing.
 */
const presentAudioRoutePicker = () => {
  void (async () => {
    try {
      await AudioSession.showAudioRoutePicker();
    } catch {
      // Fallback: flip between the built-in speaker and default routing.
      try {
        const outputs = await AudioSession.getAudioOutputs();
        const next = outputs.includes('force_speaker') ? 'force_speaker' : 'default';
        await AudioSession.selectAudioOutput(next);
      } catch {
        // Nothing else to do — leave routing as-is.
      }
    }
  })();
};
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { AppState, BackHandler, Image, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityIndicator, Text } from 'react-native-paper';

const debugLog = (...args: unknown[]) => {
  if (__DEV__) {
    console.log(...args);
  }
};

type CallTheme = {
  colors: {
    primary: string;
    onSurface: string;
    onSurfaceVariant: string;
  };
};

/** Who we're talking to — drives avatars/titles on every call surface. */
export interface CallPeer {
  name: string;
  photoURL?: string;
  isGroup: boolean;
}

const PeerAvatar = ({ peer, size }: { peer: CallPeer; size: number }) =>
  peer.isGroup ? (
    <GroupAvatar photoURL={peer.photoURL} name={peer.name} size={size} />
  ) : (
    <UserAvatar photoURL={peer.photoURL} displayName={peer.name} size={size} />
  );

// Full-screen dark backdrop — the callee's photo heavily blurred under a
// scrim, iOS-call style. Always dark regardless of app theme.
const CallBackdrop = ({ peer }: { peer: CallPeer }) => (
  <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0B0E14' }]}>
    {peer.photoURL ? (
      <>
        <Image
          source={{ uri: peer.photoURL }}
          style={[StyleSheet.absoluteFill, { opacity: 0.5 }]}
          blurRadius={60}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(8,10,16,0.55)' }]} />
      </>
    ) : null}
  </View>
);

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const isExpectedLiveKitShutdownError = (error: unknown): boolean => {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';

  const normalized = message.toLowerCase();
  return normalized.includes('pc manager is closed')
    || normalized.includes('cannot negotiate on closed engine')
    || normalized.includes('negotiation aborted');
};

// Explicitly publish/unpublish the camera + mic when the room is connected.
// `<LiveKitRoom video audio>` props are unreliable on iOS in @livekit/react-native 2.9
// — they don't always trigger an actual publish, which is why "no video" reproduces
// even though the token has canPublish:true. Calling setCameraEnabled / setMicrophoneEnabled
// against the local participant after connect is the documented robust path.
interface LocalTrackPublisherProps {
  callType: CallType;
  isMuted: boolean;
  isCameraOff: boolean;
}

const LocalTrackPublisher = ({ callType, isMuted, isCameraOff }: LocalTrackPublisherProps) => {
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [retryTick, setRetryTick] = useState(0);
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);

  // iOS forbids starting camera capture while the app is backgrounded — which
  // is exactly the state when a call is answered from the CallKit lock screen.
  // A single silent setCameraEnabled failure used to mean video NEVER started
  // for the callee. Track foreground state and re-attempt on activation.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      setAppActive(state === 'active');
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!room) return;
    if (connectionState !== ConnectionState.Connected) return;

    const local = room.localParticipant;
    const wantCamera = callType === 'video' && !isCameraOff;
    const wantMic = !isMuted;

    void (async () => {
      try {
        if (local.isMicrophoneEnabled !== wantMic) {
          await local.setMicrophoneEnabled(wantMic);
        }
      } catch (error) {
        console.warn('LocalTrackPublisher: setMicrophoneEnabled failed', error);
      }

      try {
        if (callType === 'video') {
          // Don't attempt camera capture in the background — it will fail.
          if (wantCamera && !appActive) return;
          if (local.isCameraEnabled !== wantCamera) {
            await local.setCameraEnabled(wantCamera);
          }
        } else if (local.isCameraEnabled) {
          await local.setCameraEnabled(false);
        }
      } catch (error) {
        console.warn('LocalTrackPublisher: setCameraEnabled failed; retrying shortly', error);
        // Transient failures right after CallKit's audio-session activation
        // are common — schedule a bounded re-attempt instead of giving up.
        if (retryTick < 4 && !retryTimerRef.current) {
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            setRetryTick((t) => t + 1);
          }, 1400);
        }
      }
    })();
  }, [room, connectionState, callType, isMuted, isCameraOff, appActive, retryTick]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  return null;
};

interface VideoRoomContentProps {
  theme: CallTheme;
  isCameraOff: boolean;
  peer: CallPeer;
}

const VideoRoomContent = ({ theme, isCameraOff, peer }: VideoRoomContentProps) => {
  const connectionState = useConnectionState();
  const participants = useParticipants();
  const tracks = useTracks([Track.Source.Camera]);

  const prevConnectionState = useRef<ConnectionState | null>(null);
  const prevParticipantCount = useRef<number | null>(null);

  useEffect(() => {
    if (prevConnectionState.current !== connectionState) {
      debugLog(`LiveKit connection state: ${connectionState}`);
      prevConnectionState.current = connectionState;
    }
  }, [connectionState]);

  useEffect(() => {
    if (prevParticipantCount.current !== participants.length) {
      debugLog(`LiveKit participant count: ${participants.length}`);
      prevParticipantCount.current = participants.length;
    }
  }, [participants]);

  const remoteTrack = tracks.find((track) => !track.participant.isLocal);
  const localTrack = tracks.find((track) => track.participant.isLocal);

  // Diagnostic — surfaces what useTracks is actually returning so we can tell
  // why a video tile is rendering an avatar placeholder ("track empty?",
  // "not a TrackReference?", "subscribed but unmuted not yet?"). Cheap log,
  // fires only when the underlying track set changes.
  useEffect(() => {
    if (!__DEV__) return;
    debugLog('VideoRoomContent tracks snapshot:', {
      total: tracks.length,
      details: tracks.map((t) => ({
        sid: t.publication?.trackSid,
        isLocal: t.participant.isLocal,
        participantId: t.participant.identity,
        isTrackRef: isTrackReference(t),
        muted: t.publication?.isMuted,
        subscribed: t.publication?.isSubscribed,
        track: !!t.publication?.track,
      })),
    });
  }, [tracks]);

  const connectionText = (() => {
    switch (connectionState) {
      case ConnectionState.Connecting:
        return 'Connecting to call...';
      case ConnectionState.Reconnecting:
        return 'Reconnecting...';
      case ConnectionState.Disconnected:
        return 'Disconnected';
      default:
        return null;
    }
  })();

  const hasRemoteVideo = Boolean(remoteTrack && isTrackReference(remoteTrack));

  return (
    <View style={styles.videoFill}>
      {hasRemoteVideo ? (
        <VideoTrack trackRef={remoteTrack!} style={styles.rtcView} objectFit="cover" />
      ) : (
        <View style={styles.identityCenter}>
          <PeerAvatar peer={peer} size={116} />
          <Text style={styles.identityName} numberOfLines={1}>
            {peer.name}
          </Text>
          <Text style={styles.identityStatus}>
            {connectionText ??
              (participants.length > 1 ? 'Waiting for video…' : 'Waiting for participant…')}
          </Text>
        </View>
      )}

      {hasRemoteVideo && (
        <View style={styles.videoTopPill} pointerEvents="none">
          <Text style={styles.videoTopPillText} numberOfLines={1}>
            {peer.name}
          </Text>
        </View>
      )}

      {/* Local preview PiP — floats above the control bar, FaceTime-style. */}
      <View style={styles.pip}>
        {localTrack && !isCameraOff && isTrackReference(localTrack) ? (
          <VideoTrack trackRef={localTrack} style={styles.rtcView} objectFit="cover" zOrder={1} />
        ) : (
          <View style={styles.pipPlaceholder}>
            <Ionicons
              name={isCameraOff ? 'videocam-off' : 'person'}
              size={24}
              color="rgba(255,255,255,0.8)"
            />
          </View>
        )}
      </View>
    </View>
  );
};

interface AudioRoomContentProps {
  theme: CallTheme;
  status: CallStatus;
  callDuration: number;
  peer: CallPeer;
}

const AudioRoomContent = ({ theme, status, callDuration, peer }: AudioRoomContentProps) => {
  const connectionState = useConnectionState();
  const participants = useParticipants();

  const prevConnectionState = useRef<ConnectionState | null>(null);
  const prevParticipantCount = useRef<number | null>(null);

  useEffect(() => {
    if (prevConnectionState.current !== connectionState || prevParticipantCount.current !== participants.length) {
      if (prevConnectionState.current !== connectionState) {
        debugLog(`Audio call connection: ${connectionState}`);
        prevConnectionState.current = connectionState;
      }
      if (prevParticipantCount.current !== participants.length) {
        debugLog(`Audio call participant count: ${participants.length}`);
        prevParticipantCount.current = participants.length;
      }
    }
  }, [connectionState, participants]);

  const remoteParticipant = participants.find((participant) => !participant.isLocal);

  return (
    <View style={styles.identityCenter}>
      <PeerAvatar peer={peer} size={116} />
      <Text style={styles.identityName} numberOfLines={1}>
        {peer.name}
      </Text>
      <Text style={styles.identityStatus}>
        {status === 'connected'
          ? formatDuration(callDuration)
          : remoteParticipant
            ? 'Ringing…'
            : 'Calling…'}
      </Text>
    </View>
  );
};

interface CallPresenceWatcherProps {
  status: CallStatus;
  callDuration: number;
  endCall: () => Promise<void>;
  isLocalHangupRef: MutableRefObject<boolean>;
  hasAutoClosedRef: MutableRefObject<boolean>;
}

const CallPresenceWatcher = ({
  status,
  callDuration,
  endCall,
  isLocalHangupRef,
  hasAutoClosedRef,
}: CallPresenceWatcherProps) => {
  const connectionState = useConnectionState();
  const participants = useParticipants();

  const hadRemoteParticipantRef = useRef(false);
  const remoteCountRef = useRef(0);
  const prevRemoteCountRef = useRef<number | null>(null);
  const remoteLeftTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const remoteCount = participants.filter((participant) => !participant.isLocal).length;
    remoteCountRef.current = remoteCount;
    if (prevRemoteCountRef.current !== remoteCount) {
      debugLog(`CallPresenceWatcher remote participant count: ${remoteCount}`);
      prevRemoteCountRef.current = remoteCount;
    }

    if (remoteCount > 0) {
      hadRemoteParticipantRef.current = true;
      if (remoteLeftTimerRef.current) {
        clearTimeout(remoteLeftTimerRef.current);
        remoteLeftTimerRef.current = null;
      }
      return;
    }

    const connectedNoRemote =
      connectionState === ConnectionState.Connected &&
      status === 'connected' &&
      !isLocalHangupRef.current &&
      !hasAutoClosedRef.current;

    if (!connectedNoRemote) {
      if (remoteLeftTimerRef.current) {
        clearTimeout(remoteLeftTimerRef.current);
        remoteLeftTimerRef.current = null;
      }
      return;
    }

    // In case the hook remounted mid-call or remote never appeared in participants due timing,
    // still fail-safe end a "connected but alone" call after some connected duration.
    const shouldArmFallback = hadRemoteParticipantRef.current || callDuration >= 10;

    if (!shouldArmFallback || remoteLeftTimerRef.current) {
      return;
    }

    debugLog('CallPresenceWatcher arming remote-left fallback timer');
    remoteLeftTimerRef.current = setTimeout(() => {
      remoteLeftTimerRef.current = null;

      if (isLocalHangupRef.current || hasAutoClosedRef.current) {
        return;
      }

      if (remoteCountRef.current > 0) {
        return;
      }

      hasAutoClosedRef.current = true;
      debugLog('CallSessionScreen detected remote participant left; ending call');
      void endCall();
    }, 1200);
  }, [callDuration, connectionState, endCall, hasAutoClosedRef, isLocalHangupRef, participants, status]);

  useEffect(() => {
    return () => {
      if (remoteLeftTimerRef.current) {
        clearTimeout(remoteLeftTimerRef.current);
      }
    };
  }, []);

  return null;
};

interface CallSessionScreenProps {
  chatId: string;
  groupId?: string;
  type: CallType;
  joinCallId?: string;
  visible?: boolean;
  onHangUp: () => void;
  onMinimize?: () => void;
}

export const CallSessionScreen = ({
  chatId,
  groupId,
  type,
  joinCallId,
  visible = true,
  onHangUp,
  onMinimize,
}: CallSessionScreenProps) => {
  const {
    status,
    serverUrl,
    token,
    error,
    isMuted,
    isCameraOff,
    callType,
    startCall,
    joinExistingCall,
    endCall,
    toggleMute,
    toggleCamera,
  } = useCallManager({ chatId, groupId });
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { threads } = useChat();
  const { groups } = useGroups();
  const { user } = useAuth();
  const [callDuration, setCallDuration] = useState(0);
  const [shouldConnectRoom, setShouldConnectRoom] = useState(true);

  // Who this call is with — group identity for group calls, the other
  // participant for DMs. Pure presentation; falls back gracefully when the
  // thread hasn't loaded yet.
  // Privacy guard: if calls are hidden and the user trips the guard mid-call,
  // mask the peer's name and drop their photo so the call screen gives nothing
  // away (the call keeps working — this is presentation only).
  const { isShielded: guardIsShielded, settings: guardSettings } = usePrivacyGuard();
  const callsHidden = guardIsShielded('calls');

  const peer = useMemo<CallPeer>(() => {
    let raw: CallPeer;
    if (groupId) {
      const group = groups.find((g) => g.groupId === groupId);
      raw = group ? { name: group.name, photoURL: group.photoURL, isGroup: true } : { name: 'Group call', isGroup: true };
    } else {
      const thread = threads.find((t) => t.chatId === chatId);
      if (thread?.type === 'group') {
        const group = groups.find((g) => g.groupId === thread.groupId);
        raw = { name: group?.name ?? 'Group call', photoURL: group?.photoURL, isGroup: true };
      } else if (thread) {
        const other = thread.participants.find((p) => p.userId !== user?.userId) ?? thread.participants[0];
        raw = other
          ? { name: other.displayName || 'Call', photoURL: other.photoURL, isGroup: false }
          : { name: type === 'video' ? 'Video call' : 'Audio call', isGroup: false };
      } else {
        raw = { name: type === 'video' ? 'Video call' : 'Audio call', isGroup: false };
      }
    }
    if (!callsHidden) return raw;
    return {
      ...raw,
      name: guardSettings.action === 'vanish' ? 'Call' : maskTextValue(raw.name, guardSettings.textStyle),
      photoURL: undefined,
    };
  }, [chatId, groupId, groups, threads, type, user?.userId, callsHidden, guardSettings.action, guardSettings.textStyle]);

  const hasInitializedRef = useRef(false);
  const isLocalHangupRef = useRef(false);
  const hasAutoClosedRef = useRef(false);
  const closeRequestedRef = useRef(false);
  const hasFinalizedHangupRef = useRef(false);
  const hangupFallbackTimerRef = useRef<NodeJS.Timeout | null>(null);

  const liveKitOptions = useMemo(
    () => ({
      adaptiveStream: true,
      dynacast: true,
    }),
    []
  );

  const finalizeHangUp = useCallback(() => {
    if (hasFinalizedHangupRef.current) {
      return;
    }

    hasFinalizedHangupRef.current = true;
    if (hangupFallbackTimerRef.current) {
      clearTimeout(hangupFallbackTimerRef.current);
      hangupFallbackTimerRef.current = null;
    }
    onHangUp();
  }, [onHangUp]);

  const requestRoomShutdown = useCallback(() => {
    if (closeRequestedRef.current) {
      return;
    }

    closeRequestedRef.current = true;
    setShouldConnectRoom(false);

    if (!token || !serverUrl) {
      finalizeHangUp();
      return;
    }

    if (hangupFallbackTimerRef.current) {
      clearTimeout(hangupFallbackTimerRef.current);
    }

    hangupFallbackTimerRef.current = setTimeout(() => {
      debugLog('CallSessionScreen forcing close after disconnect fallback timeout');
      finalizeHangUp();
    }, 1500);
  }, [finalizeHangUp, serverUrl, token]);

  const handleRoomConnected = useCallback(() => {
    debugLog('LiveKitRoom connected');
  }, []);

  const handleRoomDisconnected = useCallback(() => {
    debugLog('LiveKitRoom disconnected');
    if (closeRequestedRef.current) {
      finalizeHangUp();
    }
  }, [finalizeHangUp]);

  const handleRoomError = useCallback((roomError: unknown) => {
    if (isExpectedLiveKitShutdownError(roomError)) {
      console.warn('LiveKitRoom ignored expected shutdown race:', roomError);
      return;
    }

    console.error('🎥 LiveKitRoom error:', roomError);
  }, []);

  useEffect(() => {
    if (hasInitializedRef.current) {
      return;
    }
    hasInitializedRef.current = true;
    setShouldConnectRoom(true);

    debugLog('CallSessionScreen mounted');
    if (joinCallId) {
      debugLog('CallSessionScreen joining existing call');
      void joinExistingCall(joinCallId);
    } else {
      debugLog('CallSessionScreen starting new call');
      void startCall(type);
    }
  }, [joinCallId, joinExistingCall, startCall, type]);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (status === 'connected') {
      interval = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    }

    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [status]);

  const handleHangUp = useCallback(() => {
    debugLog('CallSessionScreen hang up');
    isLocalHangupRef.current = true;
    requestRoomShutdown();
    void endCall();
  }, [endCall, requestRoomShutdown]);

  const handleMinimize = useCallback(() => {
    if (!onMinimize) {
      return;
    }

    debugLog('CallSessionScreen minimize');
    onMinimize();
  }, [onMinimize]);

  useEffect(() => {
    if (status !== 'ended') {
      return;
    }

    requestRoomShutdown();
    debugLog('CallSessionScreen auto close after remote/session end');
  }, [requestRoomShutdown, status]);

  useEffect(() => {
    return () => {
      if (hangupFallbackTimerRef.current) {
        clearTimeout(hangupFallbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!visible || !onMinimize) {
      return;
    }

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      handleMinimize();
      return true;
    });

    return () => subscription.remove();
  }, [handleMinimize, onMinimize, visible]);

  const statusText = useMemo(() => {
    switch (status) {
      case 'idle':
        return 'Initializing...';
      case 'ringing':
        return 'Calling...';
      case 'connected':
        return formatDuration(callDuration);
      case 'ended':
        return 'Call ended';
      case 'failed':
        return error || 'Call failed';
      default:
        return status;
    }
  }, [callDuration, error, status]);

  return (
    <View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.overlay, visible ? styles.overlayVisible : styles.overlayHidden]}
    >
      <CallBackdrop peer={peer} />
      <View style={styles.container}>
        {/* Status chip — call type + live status, iOS-thin, top center. */}
        <View style={[styles.statusChip, { top: insets.top + 10 }]} pointerEvents="none">
          <Ionicons
            name={callType === 'video' ? 'videocam' : 'call'}
            size={13}
            color="rgba(255,255,255,0.75)"
          />
          <Text style={styles.statusChipText} numberOfLines={1}>
            {statusText}
          </Text>
        </View>
        {onMinimize ? (
          <TouchableOpacity
            onPress={handleMinimize}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Minimize call"
            style={[styles.minimizeBtn, { top: insets.top + 4 }]}
          >
            <Ionicons name="chevron-down" size={22} color="#fff" />
          </TouchableOpacity>
        ) : null}

        {token && serverUrl ? (
          <View style={styles.roomContainer}>
            <LiveKitRoom
              serverUrl={serverUrl}
              token={token}
              connect={shouldConnectRoom}
              options={liveKitOptions}
              // NOTE: do NOT pass `video` / `audio` props here. They fight with
              // LocalTrackPublisher below — when both try to manage the same
              // publication, useTracks() returns the track in a state where
              // isTrackReference() is false, so neither local preview nor the
              // remote tile renders even though media is flowing on the wire.
              // LocalTrackPublisher is the single source of truth for publish
              // state in this codebase.
              onConnected={handleRoomConnected}
              onDisconnected={handleRoomDisconnected}
              onError={handleRoomError}
            >
              <LocalTrackPublisher
                callType={callType}
                isMuted={isMuted}
                isCameraOff={isCameraOff}
              />
              <CallPresenceWatcher
                status={status}
                callDuration={callDuration}
                endCall={endCall}
                isLocalHangupRef={isLocalHangupRef}
                hasAutoClosedRef={hasAutoClosedRef}
              />
              {callType === 'video' ? (
                <VideoRoomContent theme={theme as CallTheme} isCameraOff={isCameraOff} peer={peer} />
              ) : (
                <AudioRoomContent
                  theme={theme as CallTheme}
                  status={status}
                  callDuration={callDuration}
                  peer={peer}
                />
              )}
            </LiveKitRoom>
          </View>
        ) : (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.loadingText}>Setting up call…</Text>
          </View>
        )}

        <View style={[styles.controlsWrap, { paddingBottom: insets.bottom + 18 }]}>
          <CallControls
            micEnabled={!isMuted}
            cameraEnabled={!isCameraOff}
            onToggleMic={toggleMute}
            onToggleCamera={callType === 'video' ? toggleCamera : undefined}
            onAudioRoute={presentAudioRoutePicker}
            onHangUp={handleHangUp}
          />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
    elevation: 1000,
    backgroundColor: '#0B0E14',
  },
  overlayVisible: {
    opacity: 1,
  },
  overlayHidden: {
    opacity: 0,
  },
  container: {
    flex: 1,
  },
  statusChip: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.12)',
    zIndex: 20,
    maxWidth: '70%',
  },
  statusChipText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  minimizeBtn: {
    position: 'absolute',
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  roomContainer: {
    ...StyleSheet.absoluteFillObject,
  },
  videoFill: {
    flex: 1,
  },
  rtcView: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  identityCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 140,
    gap: 6,
  },
  identityName: {
    color: '#fff',
    fontSize: 30,
    fontWeight: '600',
    letterSpacing: 0.2,
    marginTop: 14,
    maxWidth: '80%',
    textAlign: 'center',
  },
  identityStatus: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  videoTopPill: {
    position: 'absolute',
    top: 110,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(10,12,18,0.55)',
    maxWidth: '70%',
  },
  videoTopPillText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  pip: {
    position: 'absolute',
    right: 16,
    bottom: 170,
    width: 108,
    height: 158,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#1B1E26',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  pipPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.7)',
  },
  controlsWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
  },
});
