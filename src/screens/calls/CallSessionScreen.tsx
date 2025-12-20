import { CallControls } from '@/components/CallControls';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useTheme } from '@/context/ThemeContext';
import { useCallManager } from '@/hooks/useCallManager';
import type { CallType } from '@/models';
import Constants from 'expo-constants';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';

// Check if we're in Expo Go
const isExpoGo = Constants.appOwnership === 'expo';

// Conditionally import RTCView
let RTCView: any = null;
if (!isExpoGo) {
  try {
    RTCView = require('react-native-webrtc').RTCView;
  } catch (e) {
    console.warn('RTCView not available');
  }
}

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
    localStream,
    remoteStream,
    error,
    isMuted,
    isCameraOff,
    startCall,
    joinExistingCall,
    endCall,
    toggleMute,
    toggleCamera,
  } = useCallManager({ chatId, groupId });
  const { theme } = useTheme();

  useEffect(() => {
    if (joinCallId) {
      joinExistingCall(joinCallId);
    } else {
      startCall(type);
    }
    return () => {
      endCall();
    };
  }, []);

  const handleHangUp = () => {
    endCall();
    onHangUp();
  };

  const getStatusText = () => {
    switch (status) {
      case 'idle':
        return 'Initializing...';
      case 'ringing':
        return 'Calling...';
      case 'connected':
        return 'Connected';
      case 'ended':
        return 'Call ended';
      case 'failed':
        return error || 'Call failed';
      default:
        return status;
    }
  };

  // Render video view - handles both WebRTC and mock scenarios
  const renderVideoView = (stream: any, mirror: boolean) => {
    if (RTCView && stream && stream.toURL) {
      return (
        <RTCView
          streamURL={stream.toURL()}
          style={styles.rtcView}
          objectFit="cover"
          mirror={mirror}
        />
      );
    }
    return null;
  };

  return (
    <LiquidBackground>
      <View style={styles.container}>
        <GlassView style={styles.statusContainer}>
          <Text style={[styles.status, { color: theme.colors.onSurfaceVariant }]}>
            {getStatusText()}
          </Text>
          {isExpoGo && (
            <Text style={{ color: theme.colors.error, fontSize: 12, marginTop: 4 }}>
              (Mock mode - WebRTC requires dev build)
            </Text>
          )}
          {(status === 'idle' || status === 'ringing') && (
            <ActivityIndicator style={styles.loader} color={theme.colors.primary} />
          )}
        </GlassView>

        {type === 'video' ? (
          <View style={styles.videoGrid}>
            {/* Remote Video */}
            <GlassView style={styles.video}>
              {remoteStream && RTCView ? (
                renderVideoView(remoteStream, false)
              ) : (
                <View style={styles.videoPlaceholder}>
                  <Text style={{ color: theme.colors.onSurfaceVariant }}>
                    {status === 'connected' ? 'Waiting for video...' : 'Remote Video'}
                  </Text>
                </View>
              )}
            </GlassView>
            
            {/* Local Video (Picture-in-Picture style) */}
            <View style={styles.localVideoContainer}>
              <GlassView style={styles.localVideo}>
                {localStream && !isCameraOff && RTCView ? (
                  renderVideoView(localStream, true)
                ) : (
                  <View style={styles.videoPlaceholder}>
                    <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: 12 }}>
                      {isCameraOff ? 'Camera off' : 'You'}
                    </Text>
                  </View>
                )}
              </GlassView>
            </View>
          </View>
        ) : (
          // Audio call UI
          <View style={styles.audioCallContainer}>
            <GlassView style={styles.audioCallCard}>
              <Text variant="headlineMedium" style={{ color: theme.colors.onSurface }}>
                Audio Call
              </Text>
              <Text style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
                {getStatusText()}
              </Text>
            </GlassView>
          </View>
        )}

        <CallControls
          micEnabled={!isMuted}
          cameraEnabled={!isCameraOff}
          onToggleMic={toggleMute}
          onToggleCamera={type === 'video' ? toggleCamera : undefined}
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
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  status: {
    textAlign: 'center',
  },
  loader: {
    marginLeft: 8,
  },
  videoGrid: {
    flex: 1,
    marginVertical: 16,
    position: 'relative',
  },
  video: {
    flex: 1,
    borderRadius: 16,
    overflow: 'hidden',
  },
  localVideoContainer: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    width: 120,
    height: 160,
  },
  localVideo: {
    flex: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  rtcView: {
    flex: 1,
    backgroundColor: '#000',
  },
  videoPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  audioCallContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  audioCallCard: {
    padding: 32,
    borderRadius: 24,
    alignItems: 'center',
  },
});
