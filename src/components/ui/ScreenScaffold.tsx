// Shared screen shell: large title that collapses into a sticky glass header
// on scroll. Replaces the four hand-rolled copies of this pattern
// (GroupList, GroupDetails, GroupInfo, Friends) that each used different
// fade thresholds. ScrollView screens use <ScreenScaffold>; FlatList screens
// compose useHeaderScroll() + <StickyGlassHeader>/<LargeTitle> directly.

import { useTheme } from '@/context/ThemeContext';
import { BlurView } from 'expo-blur';
import React, { useRef } from 'react';
import {
  Animated,
  Platform,
  RefreshControlProps,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface HeaderScroll {
  scrollY: Animated.Value;
  onScroll: ReturnType<typeof Animated.event>;
}

export const useHeaderScroll = (): HeaderScroll => {
  const scrollY = useRef(new Animated.Value(0)).current;
  const onScroll = useRef(
    Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
      useNativeDriver: true,
    }),
  ).current;
  return { scrollY, onScroll };
};

interface StickyGlassHeaderProps {
  title: string;
  scrollY: Animated.Value;
  /** Scroll range over which the header fades in. */
  fadeRange?: [number, number];
  right?: React.ReactNode;
}

/** Full-width translucent strip pinned to the top that fades in on scroll. */
export const StickyGlassHeader = ({
  title,
  scrollY,
  fadeRange = [0, 40],
  right,
}: StickyGlassHeaderProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  const opacity = scrollY.interpolate({
    inputRange: fadeRange,
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.stickyHeader, { paddingTop: insets.top, opacity }]}
    >
      {Platform.OS === 'ios' ? (
        <BlurView
          intensity={40}
          tint={isDark ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ) : (
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.glassFallback }]}
          pointerEvents="none"
        />
      )}
      <View style={[styles.stickyInner, { paddingHorizontal: theme.spacing.md }]}>
        <Text
          numberOfLines={1}
          style={[
            styles.stickyTitle,
            {
              color: theme.colors.onSurface,
              fontSize: theme.typography.subtitle.fontSize,
              fontWeight: theme.typography.subtitle.fontWeight,
            },
          ]}
        >
          {title}
        </Text>
        {right ? <View style={styles.stickyRight}>{right}</View> : null}
      </View>
    </Animated.View>
  );
};

interface LargeTitleProps {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}

/** Big screen title block rendered at the top of the scroll content. */
export const LargeTitle = ({ title, subtitle, right }: LargeTitleProps) => {
  const { theme } = useTheme();
  return (
    <View
      style={[
        styles.largeTitleRow,
        { paddingHorizontal: theme.spacing.md, marginBottom: theme.spacing.md },
      ]}
    >
      <View style={styles.largeTitleCopy}>
        <Text
          style={{
            color: theme.colors.onSurface,
            fontSize: theme.typography.display.fontSize,
            lineHeight: theme.typography.display.lineHeight,
            fontWeight: theme.typography.display.fontWeight,
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={{
              color: theme.colors.muted,
              fontSize: theme.typography.body.fontSize,
              marginTop: theme.spacing.xs,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View>{right}</View> : null}
    </View>
  );
};

export interface ScreenScaffoldProps {
  title: string;
  subtitle?: string;
  /** Rendered next to the large title (e.g. filter button). */
  titleRight?: React.ReactNode;
  /** Rendered in the sticky header when collapsed. */
  headerRight?: React.ReactNode;
  children: React.ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  fadeRange?: [number, number];
}

export const ScreenScaffold = ({
  title,
  subtitle,
  titleRight,
  headerRight,
  children,
  contentContainerStyle,
  refreshControl,
  fadeRange,
}: ScreenScaffoldProps) => {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { scrollY, onScroll } = useHeaderScroll();

  return (
    <View style={styles.flex}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={refreshControl}
        contentContainerStyle={[
          { paddingTop: insets.top + theme.spacing.md, paddingBottom: insets.bottom + theme.spacing.xl },
          contentContainerStyle,
        ]}
        showsVerticalScrollIndicator={false}
      >
        <LargeTitle title={title} subtitle={subtitle} right={titleRight} />
        {children}
      </Animated.ScrollView>
      <StickyGlassHeader title={title} scrollY={scrollY} fadeRange={fadeRange} right={headerRight} />
    </View>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
    zIndex: 10,
  },
  stickyInner: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyTitle: {
    textAlign: 'center',
    maxWidth: '70%',
  },
  stickyRight: {
    position: 'absolute',
    right: 12,
  },
  largeTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  largeTitleCopy: { flexShrink: 1 },
});
