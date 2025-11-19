import { colors } from '@/constants';
import { StyleSheet, View } from 'react-native';
import { IconButton } from 'react-native-paper';

interface CallControlsProps {
  micEnabled: boolean;
  cameraEnabled: boolean;
  onToggleMic?: () => void;
  onToggleCamera?: () => void;
  onHangUp?: () => void;
}

export const CallControls = ({
  micEnabled,
  cameraEnabled,
  onToggleMic,
  onToggleCamera,
  onHangUp,
}: CallControlsProps) => (
  <View style={styles.container}>
    <IconButton
      icon={micEnabled ? 'microphone' : 'microphone-off'}
      mode="contained"
      onPress={onToggleMic}
      containerColor={colors.surface}
      iconColor={colors.primary}
      accessibilityLabel="Toggle microphone"
    />
    <IconButton
      icon={cameraEnabled ? 'video' : 'video-off'}
      mode="contained"
      onPress={onToggleCamera}
      containerColor={colors.surface}
      iconColor={colors.primary}
      accessibilityLabel="Toggle camera"
    />
    <IconButton
      icon="phone-hangup"
      mode="contained"
      onPress={onHangUp}
      containerColor={colors.danger}
      iconColor={colors.surface}
      accessibilityLabel="End call"
    />
  </View>
);

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    padding: 16,
  },
});
