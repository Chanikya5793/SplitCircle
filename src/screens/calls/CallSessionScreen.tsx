import { CallControls } from '@/components/CallControls';
import { colors } from '@/constants';
import { useCallManager } from '@/hooks/useCallManager';
import type { CallType } from '@/models';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
// import { RTCView } from 'react-native-webrtc';

interface CallSessionScreenProps {
  chatId: string;
  groupId?: string;
  type: CallType;
  onHangUp: () => void;
}

export const CallSessionScreen = ({ chatId, groupId, type, onHangUp }: CallSessionScreenProps) => {
  const { status, localStream, remoteStream, startCall, endCall } = useCallManager({ chatId, groupId });
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(type === 'video');

  useEffect(() => {
    startCall(type);
    return () => {
      endCall();
    };
  }, [endCall, startCall, type]);

  useEffect(() => {
    const stream = localStream.current;
    if (stream && stream.getAudioTracks) {
        stream.getAudioTracks().forEach((track: any) => {
            track.enabled = micEnabled;
        });
    }
  }, [micEnabled, localStream]);

  useEffect(() => {
    if (type !== 'video') {
      return;
    }
    const stream = localStream.current;
    if (stream && stream.getVideoTracks) {
        stream.getVideoTracks().forEach((track: any) => {
            track.enabled = cameraEnabled;
        });
    }
  }, [cameraEnabled, localStream, type]);

  const handleHangUp = () => {
    endCall();
    onHangUp();
  };

  return (
    <View style={styles.container}>
      <Text style={styles.status}>Call status: {status}</Text>
      {type === 'video' && (
        <View style={styles.videoGrid}>
          {/* Mock Video Views */}
          <View style={[styles.video, { justifyContent: 'center', alignItems: 'center' }]}>
            <Text>Remote Video</Text>
          </View>
          <View style={[styles.video, { justifyContent: 'center', alignItems: 'center' }]}>
            <Text>Local Video</Text>
          </View>
        </View>
      )}
      <CallControls
        micEnabled={micEnabled}
        cameraEnabled={cameraEnabled}
        onToggleMic={() => setMicEnabled((prev) => !prev)}
        onToggleCamera={() => setCameraEnabled((prev) => !prev)}
        onHangUp={handleHangUp}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
  },
  status: {
    textAlign: 'center',
    marginTop: 32,
    color: colors.muted,
  },
  videoGrid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    padding: 16,
    gap: 12,
  },
  video: {
    width: '45%',
    height: 200,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
});
