// In-call controls — native-iOS idiom: translucent circular buttons with
// labels underneath over the dark call backdrop, red end button. Toggles
// invert to solid white with a dark glyph when "off" (exactly how the Phone
// app shows an active Mute). The call screen is always dark regardless of
// app theme, so colors here are fixed, not themed.

import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface ControlButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  accessibilityLabel: string;
  onPress?: () => void;
  /** Toggle state; false renders the inverted (engaged) look. */
  active?: boolean;
  danger?: boolean;
}

const BUTTON_SIZE = 64;

const ControlButton = ({ icon, label, accessibilityLabel, onPress, active = true, danger }: ControlButtonProps) => {
  const background = danger
    ? '#FF3B30'
    : active
      ? 'rgba(255,255,255,0.18)'
      : 'rgba(255,255,255,0.95)';
  const iconColor = danger ? '#fff' : active ? '#fff' : '#111';

  return (
    <View style={styles.buttonColumn}>
      <TouchableOpacity
        onPress={onPress}
        disabled={!onPress}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ selected: !active }}
        style={[styles.button, { backgroundColor: background }, !onPress && styles.buttonDisabled]}
      >
        <Ionicons
          name={icon}
          size={28}
          color={iconColor}
          style={danger ? styles.hangupGlyph : undefined}
        />
      </TouchableOpacity>
      <Text style={styles.buttonLabel}>{label}</Text>
    </View>
  );
};

interface CallControlsProps {
  micEnabled: boolean;
  cameraEnabled: boolean;
  onToggleMic?: () => void;
  onToggleCamera?: () => void;
  /** Opens the iOS system audio-route picker (Speaker / iPhone / Bluetooth). */
  onAudioRoute?: () => void;
  onHangUp?: () => void;
}

export const CallControls = ({
  micEnabled,
  cameraEnabled,
  onToggleMic,
  onToggleCamera,
  onAudioRoute,
  onHangUp,
}: CallControlsProps) => (
  <View style={styles.row}>
    <ControlButton
      icon={micEnabled ? 'mic' : 'mic-off'}
      label={micEnabled ? 'mute' : 'unmute'}
      accessibilityLabel={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
      onPress={onToggleMic}
      active={micEnabled}
    />
    {onAudioRoute ? (
      <ControlButton
        icon="volume-high"
        label="audio"
        accessibilityLabel="Choose audio output"
        onPress={onAudioRoute}
      />
    ) : null}
    {onToggleCamera ? (
      <ControlButton
        icon={cameraEnabled ? 'videocam' : 'videocam-off'}
        label="camera"
        accessibilityLabel={cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
        onPress={onToggleCamera}
        active={cameraEnabled}
      />
    ) : null}
    <ControlButton
      icon="call"
      label="end"
      accessibilityLabel="End call"
      onPress={onHangUp}
      danger
    />
  </View>
);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 28,
  },
  buttonColumn: {
    alignItems: 'center',
    gap: 8,
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '500',
  },
  // The "call" glyph points up; rotated it reads as hang-up.
  hangupGlyph: {
    transform: [{ rotate: '135deg' }],
  },
});
