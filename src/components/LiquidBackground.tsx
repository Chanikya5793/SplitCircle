// Ambient animated blob background — the app's signature backdrop. Blob
// palettes now come from the design system: the neutral "balanced" state is
// tinted by the user's chosen accent, while settled/debts keep their
// semantic green/red trios. Colors crossfade with themeProgress as before.
//
// Users can replace the blobs with their own photo (Settings ▸ Appearance, or
// per-conversation from the chat header menu). When a wallpaper resolves for
// this screen, the photo renders under a theme-adaptive scrim instead of the
// blobs; the scrim keeps foreground text legible over arbitrary photos.

import { useTheme } from '@/context/ThemeContext';
import { useWallpaper, useWallpaperChain } from '@/hooks/useWallpaper';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { ACCENTS, NEUTRALS } from '@/theme/palette';
import React, { useEffect, useMemo, useState } from 'react';
import { Image, InteractionManager, StyleSheet, useWindowDimensions, View, ViewStyle } from 'react-native';
import Animated, {
    Easing,
    interpolateColor,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSequence,
    withTiming
} from 'react-native-reanimated';

export type HealthStatus = 'settled' | 'balanced' | 'debts';

interface LiquidBackgroundProps {
  children: React.ReactNode;
  style?: ViewStyle;
  healthStatus?: HealthStatus;
  /**
   * Conversation id — resolves that chat's wallpaper (per-chat → chat
   * default). Omit for regular screens, which use the app-wide wallpaper.
   */
  wallpaperChatId?: string;
  /** Explicit slot chain (first set wins) — e.g. ['group:<id>', 'app']. */
  wallpaperSlots?: import('@/services/wallpaperService').WallpaperSlot[];
}

interface BlobProps {
  lightColor: string;
  darkColor: string;
  themeProgress: { value: number };
  size: number;
  initialX: number;
  initialY: number;
  animate: boolean;
}

const Blob = ({ lightColor, darkColor, themeProgress, size, initialX, initialY, animate }: BlobProps) => {
  const scaleSv = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  // Random motion parameters must be stable across re-renders — regenerating
  // them (the old bug) restarted animation phases whenever the tree updated.
  const motion = useMemo(
    () => ({
      durationX: 12000 + Math.random() * 6000,
      durationY: 10000 + Math.random() * 8000,
      durationScale: 9000 + Math.random() * 6000,
      rangeX: 60 + Math.random() * 60,
      rangeY: 60 + Math.random() * 60,
    }),
    [],
  );

  useEffect(() => {
    // Don't start animations until the transition is complete.
    // This prevents 9+ concurrent reanimated animations from competing
    // with the navigation slide-in animation for GPU/CPU time.
    if (!animate) return;

    scaleSv.value = withRepeat(
      withSequence(
        withTiming(1.3, { duration: motion.durationScale, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.8, { duration: motion.durationScale, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: motion.durationScale, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );

    translateX.value = withRepeat(
      withSequence(
        withTiming(motion.rangeX, { duration: motion.durationX, easing: Easing.inOut(Easing.quad) }),
        withTiming(-motion.rangeX, { duration: motion.durationX * 1.2, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      true
    );

    translateY.value = withRepeat(
      withSequence(
        withTiming(-motion.rangeY, { duration: motion.durationY, easing: Easing.inOut(Easing.quad) }),
        withTiming(motion.rangeY, { duration: motion.durationY * 1.1, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      true
    );
  }, [animate]);

  const animatedStyle = useAnimatedStyle(() => {
    const backgroundColor = interpolateColor(
      themeProgress.value,
      [0, 1],
      [lightColor, darkColor]
    );

    return {
      backgroundColor,
      left: initialX,
      top: initialY,
      transform: [
        { scale: scaleSv.value },
        { translateX: translateX.value },
        { translateY: translateY.value }
      ],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.blob,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
        },
        animatedStyle,
      ]}
    />
  );
};

export const LiquidBackground = ({
  children,
  style,
  healthStatus = 'balanced',
  wallpaperChatId,
  wallpaperSlots,
}: LiquidBackgroundProps) => {
  const { themeProgress, theme, isDark } = useTheme();
  const { width, height } = useWindowDimensions();
  const [animate, setAnimate] = useState(false);
  const chatWallpaper = useWallpaper(wallpaperChatId);
  const chainWallpaper = useWallpaperChain(wallpaperSlots ?? []);
  const resolvedWallpaper = wallpaperSlots ? chainWallpaper : chatWallpaper;
  // Privacy guard: optionally revert custom photo backgrounds to the neutral
  // liquid blobs while the shields are up, so the wallpaper itself can't hint
  // at context (e.g. a partner's photo behind a chat).
  const { active: guardActive, settings: guardSettings } = usePrivacyGuard();
  const wallpaper = guardActive && guardSettings.hideWallpaper ? null : resolvedWallpaper;

  // Defer blob animations until the navigation transition finishes.
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setAnimate(true);
    });
    return () => task.cancel();
  }, []);

  // The crossfade needs BOTH schemes' trios, so resolve them from the palette
  // by accent — this component is a design-system primitive like GlassCard.
  const { lightBlobColors, darkBlobColors } = useMemo(() => {
    // A selected BLOB wallpaper overrides the accent/health palette so the
    // signature animated backdrop can be any colour the user picked — UNLESS
    // it's the "Adaptive" preset, which falls through to follow the live accent.
    if (wallpaper?.kind === 'blob' && !wallpaper.adaptive) {
      return { lightBlobColors: wallpaper.light, darkBlobColors: wallpaper.dark };
    }
    const accent = ACCENTS[theme.accentId];
    const pick = (scheme: 'light' | 'dark'): [string, string, string] => {
      if (healthStatus === 'settled') return NEUTRALS[scheme].blobSettled;
      if (healthStatus === 'debts') return NEUTRALS[scheme].blobDebts;
      return accent[scheme].blobBalanced;
    };
    return { lightBlobColors: pick('light'), darkBlobColors: pick('dark') };
  }, [healthStatus, theme.accentId, wallpaper]);

  const containerStyle = useAnimatedStyle(() => {
    const backgroundColor = interpolateColor(
      themeProgress.value,
      [0, 1],
      [NEUTRALS.light.appBackground, NEUTRALS.dark.appBackground]
    );
    return { backgroundColor };
  });

  if (wallpaper?.kind === 'photo') {
    // Photo background: no blobs, no theme crossfade — the photo IS the
    // backdrop. The scrim adapts to the scheme so text stays readable in
    // dark mode without making light mode look washed out. (A 'blob'
    // wallpaper falls through to the animated blob render below, recoloured.)
    return (
      <Animated.View style={[styles.container, containerStyle, style]}>
        <Image
          key={wallpaper.setAt}
          source={{ uri: wallpaper.uri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: isDark ? 'rgba(0,0,0,0.42)' : 'rgba(255,255,255,0.18)' },
          ]}
        />
        <View style={styles.content}>{children}</View>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[styles.container, containerStyle, style]}>
      <Blob
        lightColor={lightBlobColors[0]}
        darkColor={darkBlobColors[0]}
        themeProgress={themeProgress}
        size={300}
        initialX={-50}
        initialY={-50}
        animate={animate}
      />
      <Blob
        lightColor={lightBlobColors[1]}
        darkColor={darkBlobColors[1]}
        themeProgress={themeProgress}
        size={350}
        initialX={width - 200}
        initialY={height - 200}
        animate={animate}
      />
      <Blob
        lightColor={lightBlobColors[2]}
        darkColor={darkBlobColors[2]}
        themeProgress={themeProgress}
        size={250}
        initialX={-50}
        initialY={height / 2}
        animate={animate}
      />

      <View style={styles.content}>
        {children}
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    zIndex: 1,
  },
  blob: {
    position: 'absolute',
    opacity: 0.5,
  },
});
