import { GlassCard } from '@/components/ui/GlassCard';
import { useTheme } from '@/context/ThemeContext';
import React, { useEffect } from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import Animated, {
    Easing,
    type SharedValue,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withTiming,
} from 'react-native-reanimated';

interface SkeletonLoaderProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
  progress?: SharedValue<number>;
}

export const SkeletonLoader = ({
  width = '100%',
  height = 20,
  borderRadius = 8,
  style,
  progress,
}: SkeletonLoaderProps) => {
  const { theme } = useTheme();
  const ownOpacity = useSharedValue(0.42);
  const opacity = progress ?? ownOpacity;

  useEffect(() => {
    if (progress) return;
    opacity.value = withRepeat(
      withTiming(0.9, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, [opacity, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const backgroundColor = theme.colors.skeleton;

  return (
    <Animated.View
      style={[
        {
          width: width as any,
          height,
          borderRadius,
          backgroundColor,
        },
        animatedStyle,
        style,
      ]}
    />
  );
};

// Preset skeleton components for common use cases

const useSkeletonPulse = () => {
  const pulse = useSharedValue(0.42);

  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(0.9, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse]);

  return pulse;
};

export const GroupCardSkeleton = () => {
  const pulse = useSkeletonPulse();
  
  return (
    <GlassCard style={styles.groupCard} contentStyle={styles.cardContent}>
      <View style={styles.groupCardContent}>
        <SkeletonLoader progress={pulse} width={48} height={48} borderRadius={24} />
        <View style={styles.groupCardMeta}>
          <SkeletonLoader progress={pulse} width="60%" height={18} />
          <SkeletonLoader progress={pulse} width="40%" height={14} style={{ marginTop: 8 }} />
        </View>
      </View>
      <SkeletonLoader progress={pulse} width="30%" height={16} style={{ marginTop: 12, alignSelf: 'flex-end' }} />
    </GlassCard>
  );
};

export const ExpenseCardSkeleton = () => {
  const pulse = useSkeletonPulse();
  
  return (
    <GlassCard style={styles.expenseCard} contentStyle={styles.cardContent}>
      <View style={styles.expenseCardContent}>
        <View style={styles.expenseCardLeft}>
          <SkeletonLoader progress={pulse} width="70%" height={18} />
          <SkeletonLoader progress={pulse} width="50%" height={14} style={{ marginTop: 6 }} />
          <SkeletonLoader progress={pulse} width="30%" height={12} style={{ marginTop: 6 }} />
        </View>
        <SkeletonLoader progress={pulse} width={80} height={24} />
      </View>
    </GlassCard>
  );
};

export const ChatListSkeleton = () => {
  const pulse = useSkeletonPulse();
  
  return (
    <GlassCard style={styles.chatItem} contentStyle={styles.chatItemContent}>
      <SkeletonLoader progress={pulse} width={50} height={50} borderRadius={25} />
      <View style={styles.chatMeta}>
        <SkeletonLoader progress={pulse} width="50%" height={16} />
        <SkeletonLoader progress={pulse} width="80%" height={14} style={{ marginTop: 8 }} />
      </View>
      <SkeletonLoader progress={pulse} width={40} height={12} />
    </GlassCard>
  );
};

export const ProfileSkeleton = () => {
  const pulse = useSkeletonPulse();
  
  return (
    <GlassCard style={styles.profileCard} contentStyle={styles.profileCardContent}>
      <SkeletonLoader progress={pulse} width={80} height={80} borderRadius={40} />
      <SkeletonLoader progress={pulse} width={150} height={20} style={{ marginTop: 16 }} />
      <SkeletonLoader progress={pulse} width={200} height={14} style={{ marginTop: 8 }} />
    </GlassCard>
  );
};

const styles = StyleSheet.create({
  groupCard: {
    borderRadius: 24,
    marginBottom: 12,
    marginHorizontal: 4,
  },
  cardContent: {
    padding: 16,
  },
  groupCardContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  groupCardMeta: {
    flex: 1,
    marginLeft: 12,
  },
  expenseCard: {
    borderRadius: 24,
    marginBottom: 12,
    marginHorizontal: 4,
  },
  expenseCardContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  expenseCardLeft: {
    flex: 1,
  },
  chatItem: {
    marginBottom: 8,
    borderRadius: 16,
  },
  chatItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  chatMeta: {
    flex: 1,
    marginLeft: 12,
  },
  profileCard: {
    borderRadius: 24,
  },
  profileCardContent: {
    alignItems: 'center',
    padding: 24,
  },
});
