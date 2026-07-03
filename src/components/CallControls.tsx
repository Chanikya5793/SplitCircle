// In-call control bar — FaceTime-style circular controls on a glass pill.
// Toggles invert when "off" (white fill, dark glyph) so state reads at a
// glance over any wallpaper or remote video frame; hang-up stays the one
// destructive red circle.

import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, TouchableOpacity, View } from 'react-native';

interface ControlButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  /** Toggle state; when false the button inverts to show "off". */
  active?: boolean;
  danger?: boolean;
  size?: number;
}

const ControlButton = ({ icon, label, onPress, active = true, danger, size = 56 }: ControlButtonProps) => {
  const { isDark } = useTheme();

  const background = danger
    ? '#E5484D'
    : active
      ? isDark
        ? 'rgba(255,255,255,0.14)'
        : 'rgba(0,0,0,0.08)'
      : isDark
        ? 'rgba(255,255,255,0.92)'
        : 'rgba(30,30,30,0.85)';
  const iconColor = danger
    ? '#fff'
    : active
      ? isDark
        ? '#fff'
        : '#1d1d1f'
      : isDark
        ? '#1d1d1f'
        : '#fff';

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !active }}
      style={[
        styles.button,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: background },
        !onPress && styles.buttonDisabled,
      ]}
    >
      <Ionicons
        name={icon}
        size={size * 0.44}
        color={iconColor}
        style={danger ? styles.hangupGlyph : undefined}
      />
    </TouchableOpacity>
  );
};

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
  <View style={styles.wrapper}>
    <GlassView style={styles.pill} contentStyle={styles.pillContent} intensity={50}>
      <ControlButton
        icon={micEnabled ? 'mic' : 'mic-off'}
        label={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
        onPress={onToggleMic}
        active={micEnabled}
      />
      {onToggleCamera ? (
        <ControlButton
          icon={cameraEnabled ? 'videocam' : 'videocam-off'}
          label={cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
          onPress={onToggleCamera}
          active={cameraEnabled}
        />
      ) : null}
      <ControlButton icon="call" label="End call" onPress={onHangUp} danger size={64} />
    </GlassView>
  </View>
);

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  pill: {
    borderRadius: 40,
    overflow: 'hidden',
  },
  pillContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  // The "call" glyph points up; rotated it reads as hang-up.
  hangupGlyph: {
    transform: [{ rotate: '135deg' }],
  },
});
