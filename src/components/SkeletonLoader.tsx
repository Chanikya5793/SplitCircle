import { useTheme } from '@/context/ThemeContext';
import React, { useEffect } from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import Animated, {
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
}

export const SkeletonLoader = ({
  width = '100%',
  height = 20,
  borderRadius = 8,
  style,
}: SkeletonLoaderProps) => {
  const { isDark } = useTheme();
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.7, { duration: 800 }),
      -1,
      true
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const backgroundColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

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

export const GroupCardSkeleton = () => {
  const { isDark } = useTheme();
  
  return (
    <View style={[styles.groupCard, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.3)' }]}>
      <View style={styles.groupCardContent}>
        <SkeletonLoader width={48} height={48} borderRadius={24} />
        <View style={styles.groupCardMeta}>
          <SkeletonLoader width="60%" height={18} />
          <SkeletonLoader width="40%" height={14} style={{ marginTop: 8 }} />
        </View>
      </View>
      <SkeletonLoader width="30%" height={16} style={{ marginTop: 12, alignSelf: 'flex-end' }} />
    </View>
  );
};

export const ExpenseCardSkeleton = () => {
  const { isDark } = useTheme();
  
  return (
    <View style={[styles.expenseCard, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.3)' }]}>
      <View style={styles.expenseCardContent}>
        <View style={styles.expenseCardLeft}>
          <SkeletonLoader width="70%" height={18} />
          <SkeletonLoader width="50%" height={14} style={{ marginTop: 6 }} />
          <SkeletonLoader width="30%" height={12} style={{ marginTop: 6 }} />
        </View>
        <SkeletonLoader width={80} height={24} />
      </View>
    </View>
  );
};

export const ChatListSkeleton = () => {
  const { isDark } = useTheme();
  
  return (
    <View style={[styles.chatItem, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.3)' }]}>
      <SkeletonLoader width={50} height={50} borderRadius={25} />
      <View style={styles.chatMeta}>
        <SkeletonLoader width="50%" height={16} />
        <SkeletonLoader width="80%" height={14} style={{ marginTop: 8 }} />
      </View>
      <SkeletonLoader width={40} height={12} />
    </View>
  );
};

export const ProfileSkeleton = () => {
  const { isDark } = useTheme();
  
  return (
    <View style={[styles.profileCard, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.3)' }]}>
      <SkeletonLoader width={80} height={80} borderRadius={40} />
      <SkeletonLoader width={150} height={20} style={{ marginTop: 16 }} />
      <SkeletonLoader width={200} height={14} style={{ marginTop: 8 }} />
    </View>
  );
};

const styles = StyleSheet.create({
  groupCard: {
    borderRadius: 24,
    padding: 16,
    marginBottom: 12,
    marginHorizontal: 4,
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
    padding: 16,
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
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    marginBottom: 8,
    borderRadius: 16,
  },
  chatMeta: {
    flex: 1,
    marginLeft: 12,
  },
  profileCard: {
    alignItems: 'center',
    padding: 24,
    borderRadius: 24,
  },
});
