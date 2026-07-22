// Placeholder shown while narrateInsights() is still resolving (on-device
// model load / PCC round trip can take a few seconds — without this the AI
// card just doesn't exist yet, which reads as "the feature is broken").
import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Icon, Text } from 'react-native-paper';

export const AiNarrativeSkeleton = () => {
  const { theme } = useTheme();
  const pulse = useSharedValue(0);

  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [pulse]);

  const iconStyle = useAnimatedStyle(() => ({
    opacity: 0.5 + pulse.value * 0.5,
    transform: [{ scale: 0.92 + pulse.value * 0.08 }],
  }));
  const barStyle = useAnimatedStyle(() => ({
    opacity: 0.35 + pulse.value * 0.35,
  }));

  const barColor = theme.colors.skeleton;

  return (
    <GlassCard style={styles.card}>
      <View style={styles.header}>
        <Animated.View style={iconStyle}>
          <Icon source="chip" size={16} color={theme.colors.primary} />
        </Animated.View>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          Thinking about your spending…
        </Text>
      </View>
      <Animated.View style={[styles.bar, { width: '92%', backgroundColor: barColor }, barStyle]} />
      <Animated.View style={[styles.bar, { width: '76%', backgroundColor: barColor }, barStyle]} />
      <Animated.View style={[styles.bar, { width: '58%', backgroundColor: barColor }, barStyle]} />
    </GlassCard>
  );
};

const styles = StyleSheet.create({
  card: {
    padding: 16,
    borderRadius: 20,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  bar: {
    height: 12,
    borderRadius: 6,
  },
});
