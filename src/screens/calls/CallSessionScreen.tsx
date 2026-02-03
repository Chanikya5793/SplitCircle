import { CallControls } from '@/components/CallControls';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useTheme } from '@/context/ThemeContext';
import { useCallManager } from '@/hooks/useCallManager';
import type { CallType } from '@/models';
import {
  LiveKitRoom,
  isTrackReference,
  useConnectionState,
  useParticipants,
  useTracks,
  VideoTrack,
} from '@livekit/react-native';
import { ConnectionState, Track } from 'livekit-client';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';

interface CallSessionScreenProps {
  chatId: string;
  groupId?: string;
  type: CallType;
  joinCallId?: string;
  onHangUp: () => void;
}

export const CallSessionScreen = ({ chatId, groupId, type, joinCallId, onHangUp }: CallSessionScreenProps) => {
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

  useEffect(() => {
    console.log('🎬 CallSessionScreen mounted');
    if (joinCallId) {
      console.log(`🎬 Joining existing call: ${joinCallId}`);
      joinExistingCall(joinCallId);
    } else {
      console.log(`🎬 Starting new ${type} call`);
      startCall(type);
    }
  }, []); // Only run on mount to start

  // Call duration timer
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (status === 'connected') {
      interval = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [status]);

  const handleHangUp = () => {
    console.log('🎬 Hang up pressed');
    endCall();
    onHangUp();
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getStatusText = () => {
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
  };

  // Inner component that uses LiveKit hooks (must be inside LiveKitRoom)
  const RoomContent = () => {
    const connectionState = useConnectionState();
    const participants = useParticipants();
    const tracks = useTracks([Track.Source.Camera]);

    // Log connection state changes
    useEffect(() => {
      console.log(`🎥 LiveKit connection state: ${connectionState}`);
    }, [connectionState]);

    // Log participant changes
    useEffect(() => {
      console.log(`👥 Participants in room: ${participants.length}`);
      participants.forEach((p) => {
        console.log(`   - ${p.identity} (local: ${p.isLocal})`);
      });
    }, [participants]);

    // Find remote track (first one that isn't local, simplified for 1:1)
    const remoteTrack = tracks.find((t) => !t.participant.isLocal);
    const localTrack = tracks.find((t) => t.participant.isLocal);

    const getConnectionStateText = () => {
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
    };

    const connectionText = getConnectionStateText();

    return (
      <View style={styles.videoGrid}>
        {/* Connection state overlay */}
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

        {/* Remote Video */}
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
                  ? 'Waiting for video...'
                  : 'Connecting...'}
              </Text>
            </View>
          )}
        </GlassView>

        {/* Local Video (Picture-in-Picture style) */}
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
                <Text style={styles.localAvatarText}>
                  {isCameraOff ? '📷' : '👤'}
                </Text>
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

  // Audio call content (also must be inside LiveKitRoom for hooks)
  const AudioCallContent = () => {
    const connectionState = useConnectionState();
    const participants = useParticipants();

    useEffect(() => {
      console.log(`🔊 Audio call - connection: ${connectionState}, participants: ${participants.length}`);
    }, [connectionState, participants]);

    const remoteParticipant = participants.find((p) => !p.isLocal);

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

  return (
    <LiquidBackground>
      <View style={styles.container}>
        {/* Status Header */}
        <GlassView style={styles.statusContainer}>
          <View style={styles.statusContent}>
            <Text style={[styles.statusTitle, { color: theme.colors.onSurface }]}>
              {callType === 'video' ? '📹 Video Call' : '📞 Audio Call'}
            </Text>
            <View style={styles.statusRow}>
              <Text style={[styles.statusText, { color: theme.colors.onSurfaceVariant }]}>
                {getStatusText()}
              </Text>
              {(status === 'idle' || status === 'ringing') && (
                <ActivityIndicator size="small" color={theme.colors.primary} style={styles.loader} />
              )}
            </View>
          </View>
        </GlassView>

        {/* Main Content */}
        {token && serverUrl ? (
          <View style={styles.roomContainer}>
            <LiveKitRoom
              serverUrl={serverUrl}
              token={token}
              connect={true}
              options={{
                adaptiveStream: true,
                dynacast: true,
              }}
              video={callType === 'video' && !isCameraOff}
              audio={!isMuted}
              onConnected={() => console.log('🎥 LiveKitRoom: Connected!')}
              onDisconnected={() => console.log('🎥 LiveKitRoom: Disconnected')}
              onError={(error) => console.error('🎥 LiveKitRoom error:', error)}
            >
              {callType === 'video' ? <RoomContent /> : <AudioCallContent />}
            </LiveKitRoom>
          </View>
        ) : (
          // Loading state before we have token
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.loadingText, { color: theme.colors.onSurfaceVariant }]}>
              Setting up call...
            </Text>
          </View>
        )}

        {/* Call Controls */}
        <CallControls
          micEnabled={!isMuted}
          cameraEnabled={!isCameraOff}
          onToggleMic={toggleMute}
          onToggleCamera={callType === 'video' ? toggleCamera : undefined}
          onHangUp={handleHangUp}
        />
      </View>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 16,
  },
  statusContainer: {
    padding: 16,
    borderRadius: 16,
    zIndex: 10,
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
