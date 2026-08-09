// Shared screen shell: large title that collapses into a sticky glass header
// on scroll. Replaces the four hand-rolled copies of this pattern
// (GroupList, GroupDetails, GroupInfo, Friends) that each used different
// fade thresholds. ScrollView screens use <ScreenScaffold>; FlatList screens
// compose useHeaderScroll() + <StickyGlassHeader>/<LargeTitle> directly.

import { useTheme } from '@/context/ThemeContext';
import React, { useRef } from 'react';
import {
  Animated,
  RefreshControlProps,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StickyHeaderPill } from './StickyHeaderPill';

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
  /** Scroll range over which the header slides into view. */
  fadeRange?: [number, number];
  right?: React.ReactNode;
}

/**
 * Centered glass pill, pinned to the top, that slides into view on scroll.
 *
 * DESIGN.md: "ALL glass goes through GlassCard... Never hand-roll BlurView +
 * rgba tints for a surface that should be glass" and "the title/subtitle
 * block is a glass pill (StickyHeaderPill DNA)" — this now routes through
 * StickyHeaderPill instead of a hand-rolled BlurView/tinted-View strip.
 *
 * Reveal is a TRANSFORM (translateY), never opacity: the native-material
 * kill list in DESIGN.md is explicit that any ancestor with fractional
 * opacity stops the iOS 26 glass material from rendering at all, and
 * StickyHeaderPill's own contract says the same — this is exactly the
 * hand-rolled-BlurView-with-opacity pattern that drifted the Calls tab.
 */
export const StickyGlassHeader = ({
  title,
  scrollY,
  fadeRange = [0, 40],
  right,
}: StickyGlassHeaderProps) => {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  // Slides down from fully clipped above the header's own box (well past its
  // ~44px content height) to its resting position — never fades in.
  const translateY = scrollY.interpolate({
    inputRange: fadeRange,
    outputRange: [-60, 0],
    extrapolate: 'clamp',
  });

  return (
    <View pointerEvents="box-none" style={[styles.stickyHeader, { paddingTop: insets.top }]}>
      <Animated.View
        pointerEvents="box-none"
        style={[styles.stickyInner, { paddingHorizontal: theme.spacing.md, transform: [{ translateY }] }]}
      >
        <StickyHeaderPill>
          <Text
            numberOfLines={1}
            style={[
              styles.stickyTitle,
              {
                color: theme.colors.onSurface,
                fontSize: theme.typography.subtitle.fontSize,
                lineHeight: theme.typography.subtitle.lineHeight,
                fontWeight: theme.typography.subtitle.fontWeight,
              },
            ]}
          >
            {title}
          </Text>
        </StickyHeaderPill>
        {right ? <View style={styles.stickyRight}>{right}</View> : null}
      </Animated.View>
    </View>
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
              lineHeight: theme.typography.body.lineHeight,
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
