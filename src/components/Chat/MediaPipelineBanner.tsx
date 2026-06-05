import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

interface MediaPipelineBannerProps {
  visible: boolean;
  message?: string;
  /** Pixels of bottom inset (composer height + safe-area) so the banner
   *  parks just above the composer instead of overlapping it. */
  bottomOffset: number;
}

/**
 * Non-blocking progress strip for the chat media pipeline.
 *
 * Unlike `LoadingOverlay`, this renders as a regular `<View>` (not a `<Modal>`),
 * so it never intercepts touches outside its own row — the chat list, composer,
 * and back navigation all stay live while uploads run. Each individual message
 * bubble already shows its own per-message "sending" spinner, so this strip is
 * purely an aggregate progress hint for the user.
 */
export const MediaPipelineBanner = ({
  visible,
  message,
  bottomOffset,
}: MediaPipelineBannerProps) => {
  const { theme } = useTheme();
  if (!visible) return null;
  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrapper, { bottom: bottomOffset }]}
    >
      <GlassView style={styles.banner}>
        <ActivityIndicator size="small" color={theme.colors.primary} />
        <Text
          numberOfLines={1}
          style={[styles.text, { color: theme.colors.onSurface }]}
        >
          {message ?? 'Sending media…'}
        </Text>
      </GlassView>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 12,
    right: 12,
    alignItems: 'center',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 18,
    minHeight: 36,
    maxWidth: '100%',
  },
  text: {
    fontSize: 13,
    fontWeight: '500',
    flexShrink: 1,
  },
});
