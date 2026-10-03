// In-call controls — native-iOS idiom: translucent circular buttons with
// labels underneath over the dark call backdrop, red end button. Toggles
// invert to solid white with a dark glyph when "off" (exactly how the Phone
// app shows an active Mute). The call screen is always dark regardless of
// app theme, so colors here are fixed, not themed.

import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';

interface ControlButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  accessibilityLabel: string;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Toggle state; false renders the inverted (engaged) look. */
  active?: boolean;
  danger?: boolean;
}

const BUTTON_SIZE = 56;

const ControlButton = ({ icon, label, accessibilityLabel, onPress, onLongPress, active = true, danger }: ControlButtonProps) => {
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
        onLongPress={onLongPress}
        disabled={!onPress}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ selected: !active, disabled: !onPress }}
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
  /** Speaker is currently forced on (drives the audio button's engaged look). */
  speakerOn?: boolean;
  onToggleMic?: () => void;
  onToggleCamera?: () => void;
  /** Tap: toggle the speaker. */
  onToggleSpeaker?: () => void;
  /** Long-press: open the iOS system route picker (Bluetooth / AirPlay / …). */
  onAudioRoute?: () => void;
  /** Flip between the front and back phone camera (video calls only). */
  onFlipCamera?: () => void;
  onHangUp?: () => void;
}

export const CallControls = ({
  micEnabled,
  cameraEnabled,
  speakerOn = false,
  onToggleMic,
  onToggleCamera,
  onToggleSpeaker,
  onAudioRoute,
  onFlipCamera,
  onHangUp,
}: CallControlsProps) => {
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const availableWidth = Math.max(BUTTON_SIZE, (measuredWidth ?? windowWidth) - 32);
  const controls: (ControlButtonProps & { key: string })[] = [
    {
      key: 'mic',
      icon: micEnabled ? 'mic' : 'mic-off',
      label: micEnabled ? 'mute' : 'unmute',
      accessibilityLabel: micEnabled ? 'Mute microphone' : 'Unmute microphone',
      onPress: onToggleMic,
      active: micEnabled,
    },
  ];

  if (onToggleSpeaker || onAudioRoute) {
    controls.push({
      key: 'audio',
      icon: speakerOn ? 'volume-high' : 'volume-medium',
      label: speakerOn ? 'speaker' : 'audio',
      accessibilityLabel: speakerOn ? 'Speaker on. Long-press to choose output' : 'Speaker off. Long-press to choose output',
      onPress: onToggleSpeaker ?? onAudioRoute,
      onLongPress: onAudioRoute,
      active: !speakerOn,
    });
  }
  if (onToggleCamera) {
    controls.push({
      key: 'camera',
      icon: cameraEnabled ? 'videocam' : 'videocam-off',
      label: 'camera',
      accessibilityLabel: cameraEnabled ? 'Turn camera off' : 'Turn camera on',
      onPress: onToggleCamera,
      active: cameraEnabled,
    });
  }
  // Keep the video-call slot when the camera is off so End does not move
  // beneath the user's finger when the parent removes the flip callback.
  if (onFlipCamera || onToggleCamera) {
    controls.push({
      key: 'flip',
      icon: 'camera-reverse',
      label: 'flip',
      accessibilityLabel: onFlipCamera ? 'Flip camera' : 'Flip camera unavailable',
      onPress: onFlipCamera,
    });
  }
  controls.push({
    key: 'end',
    icon: 'call',
    label: 'end',
    accessibilityLabel: 'End call',
    onPress: onHangUp,
    danger: true,
  });

  // Grow each label's allowance with Dynamic Type. Balance compact layouts
  // into 3 + 2 or 2 + 2 rather than leaving a single control on the last row.
  const minimumColumnWidth = Math.max(72, Math.min(128, 52 * fontScale));
  const capacity = Math.max(1, Math.floor((availableWidth + 12) / (minimumColumnWidth + 12)));
  const rowCount = Math.ceil(controls.length / capacity);
  const columns = Math.ceil(controls.length / rowCount);
  const columnWidth = Math.min(
    Math.max(84, minimumColumnWidth),
    (availableWidth - (columns - 1) * 12) / columns,
  );
  const rows = Array.from({ length: rowCount }, (_, index) =>
    controls.slice(index * columns, (index + 1) * columns),
  ).filter((row) => row.length > 0);

  return (
    <View
      style={styles.controls}
      onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}
    >
      {rows.map((row, index) => (
        <View key={index} style={styles.row}>
          {row.map(({ key, ...control }) => (
            <View key={key} style={{ width: columnWidth }}>
              <ControlButton {...control} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  controls: {
    alignSelf: 'stretch',
    paddingHorizontal: 16,
    rowGap: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 12,
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
    alignSelf: 'stretch',
    textAlign: 'center',
    flexShrink: 1,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '500',
  },
  // The "call" glyph points up; rotated it reads as hang-up.
  hangupGlyph: {
    transform: [{ rotate: '135deg' }],
  },
});
