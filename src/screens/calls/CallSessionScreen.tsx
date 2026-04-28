import { CallControls } from '@/components/CallControls';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useTheme } from '@/context/ThemeContext';
import { useCallManager } from '@/hooks/useCallManager';
import type { CallStatus, CallType } from '@/models';
import {
  LiveKitRoom,
  isTrackReference,
  useConnectionState,
  useParticipants,
  useTracks,
  VideoTrack,
} from '@livekit/react-native';
import { ConnectionState, Track } from 'livekit-client';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { ActivityIndicator, IconButton, Text } from 'react-native-paper';

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

interface VideoRoomContentProps {
  theme: CallTheme;
  isCameraOff: boolean;
}

const VideoRoomContent = ({ theme, isCameraOff }: VideoRoomContentProps) => {
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

  return (
    <View style={styles.videoGrid}>
      {connectionText && (
        <View style={styles.connectionOverlay}>
          <GlassView style={styles.connectionBadge}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
            <Text style={[styles.connectionText, { color: theme.colors.onSurface }]}>
              {connectionText}
            </Text>
          </GlassView>
        </View>
      )}

      <GlassView style={styles.video}>
        {remoteTrack && isTrackReference(remoteTrack) ? (
          <VideoTrack trackRef={remoteTrack} style={styles.rtcView} objectFit="cover" />
        ) : (
          <View style={styles.videoPlaceholder}>
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarText}>👤</Text>
            </View>
            <Text style={[styles.placeholderText, { color: theme.colors.onSurfaceVariant }]}>
              {connectionState === ConnectionState.Connected
                ? participants.length > 1
                  ? 'Waiting for video...'
                  : 'Waiting for participant...'
                : 'Connecting...'}
            </Text>
          </View>
        )}
      </GlassView>

      <View style={styles.localVideoContainer}>
        <GlassView style={styles.localVideo}>
          {localTrack && !isCameraOff && isTrackReference(localTrack) ? (
            <VideoTrack
              trackRef={localTrack}
              style={styles.rtcView}
              objectFit="cover"
              zOrder={1}
            />
          ) : (
            <View style={styles.videoPlaceholder}>
              <Text style={styles.localAvatarText}>{isCameraOff ? '📷' : '👤'}</Text>
            </View>
          )}
        </GlassView>
        {isCameraOff && (
          <View style={styles.cameraOffBadge}>
            <Text style={styles.cameraOffText}>Camera off</Text>
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
}

const AudioRoomContent = ({ theme, status, callDuration }: AudioRoomContentProps) => {
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
    <View style={styles.audioCallContainer}>
      <GlassView style={styles.audioCallCard}>
        <View style={styles.audioAvatar}>
          <Text style={styles.audioAvatarText}>🎧</Text>
        </View>
        <Text variant="headlineMedium" style={[styles.audioTitle, { color: theme.colors.onSurface }]}> 
          Audio Call
        </Text>
        <Text style={[styles.audioSubtitle, { color: theme.colors.onSurfaceVariant }]}> 
          {remoteParticipant ? remoteParticipant.name || 'Connected' : 'Waiting for participant...'}
        </Text>
        {status === 'connected' && (
          <Text style={[styles.audioDuration, { color: theme.colors.primary }]}>
            {formatDuration(callDuration)}
          </Text>
        )}
      </GlassView>
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
  const [callDuration, setCallDuration] = useState(0);
  const [shouldConnectRoom, setShouldConnectRoom] = useState(true);

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
      <LiquidBackground>
      <View style={styles.container}>
        <GlassView style={styles.statusContainer}>
          {onMinimize ? (
            <IconButton
              icon="chevron-down"
              mode="contained-tonal"
              size={20}
              onPress={handleMinimize}
              style={styles.minimizeButton}
              accessibilityLabel="Minimize call"
            />
          ) : null}
          <View style={styles.statusContent}>
            <Text style={[styles.statusTitle, { color: theme.colors.onSurface }]}> 
              {callType === 'video' ? '📹 Video Call' : '📞 Audio Call'}
            </Text>
            <View style={styles.statusRow}>
              <Text style={[styles.statusText, { color: theme.colors.onSurfaceVariant }]}>
                {statusText}
              </Text>
              {(status === 'idle' || status === 'ringing') && (
                <ActivityIndicator size="small" color={theme.colors.primary} style={styles.loader} />
              )}
            </View>
          </View>
        </GlassView>

        {token && serverUrl ? (
          <View style={styles.roomContainer}>
            <LiveKitRoom
              serverUrl={serverUrl}
              token={token}
              connect={shouldConnectRoom}
              options={liveKitOptions}
              video={callType === 'video' && !isCameraOff}
              audio={!isMuted}
              onConnected={handleRoomConnected}
              onDisconnected={handleRoomDisconnected}
              onError={handleRoomError}
            >
              <CallPresenceWatcher
                status={status}
                callDuration={callDuration}
                endCall={endCall}
                isLocalHangupRef={isLocalHangupRef}
                hasAutoClosedRef={hasAutoClosedRef}
              />
              {callType === 'video' ? (
                <VideoRoomContent theme={theme as CallTheme} isCameraOff={isCameraOff} />
              ) : (
                <AudioRoomContent
                  theme={theme as CallTheme}
                  status={status}
                  callDuration={callDuration}
                />
              )}
            </LiveKitRoom>
          </View>
        ) : (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.loadingText, { color: theme.colors.onSurfaceVariant }]}> 
              Setting up call...
            </Text>
          </View>
        )}

        <CallControls
          micEnabled={!isMuted}
          cameraEnabled={!isCameraOff}
          onToggleMic={toggleMute}
          onToggleCamera={callType === 'video' ? toggleCamera : undefined}
          onHangUp={handleHangUp}
        />
      </View>
      </LiquidBackground>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1000,
    elevation: 1000,
  },
  overlayVisible: {
    opacity: 1,
  },
  overlayHidden: {
    opacity: 0,
  },
  container: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 16,
  },
  statusContainer: {
    position: 'relative',
    padding: 16,
    borderRadius: 16,
    zIndex: 10,
  },
  minimizeButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 20,
  },
  statusContent: {
    alignItems: 'center',
  },
  statusTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 4,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    fontSize: 14,
  },
  loader: {
    marginLeft: 4,
  },
  roomContainer: {
    flex: 1,
    marginVertical: 16,
  },
  videoGrid: {
    flex: 1,
    position: 'relative',
  },
  video: {
    flex: 1,
    borderRadius: 20,
    overflow: 'hidden',
  },
  localVideoContainer: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    width: 100,
    height: 140,
  },
  localVideo: {
    flex: 1,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  rtcView: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  videoPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  avatarPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  avatarText: {
    fontSize: 48,
  },
  localAvatarText: {
    fontSize: 24,
  },
  placeholderText: {
    fontSize: 14,
  },
  cameraOffBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 8,
    padding: 4,
  },
  cameraOffText: {
    color: '#fff',
    fontSize: 10,
    textAlign: 'center',
  },
  connectionOverlay: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    zIndex: 20,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderRadius: 12,
    gap: 8,
  },
  connectionText: {
    fontSize: 14,
    fontWeight: '500',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
  },
  audioCallContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  audioCallCard: {
    padding: 40,
    borderRadius: 32,
    alignItems: 'center',
    minWidth: 280,
  },
  audioAvatar: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  audioAvatarText: {
    fontSize: 56,
  },
  audioTitle: {
    marginBottom: 8,
  },
  audioSubtitle: {
    fontSize: 16,
    marginBottom: 16,
  },
  audioDuration: {
    fontSize: 24,
    fontWeight: '600',
  },
});
