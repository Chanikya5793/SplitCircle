// Generic glass toast — an undo/confirmation strip that floats above the
// content, auto-dismissing after `duration`. Replaces react-native-paper's
// Snackbar (opaque Material chrome, never glass; see DESIGN.md "Liquid glass
// DNA > Self-audit") with the same non-blocking-strip pattern
// MediaPipelineBanner already uses: a plain View (not a Modal, so it never
// intercepts touches outside its own row) wrapping GlassCard.
//
// Reveals via TRANSFORM only (translateY), never opacity — DESIGN.md's
// native-material kill list: fractional opacity on an ancestor stops the
// iOS 26 glass material from rendering.

import { useTheme } from '@/context/ThemeContext';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { GlassCard } from './GlassCard';

export interface GlassToastAction {
  label: string;
  onPress: () => void;
}

export interface GlassToastProps {
  visible: boolean;
  message: string;
  onDismiss: () => void;
  /** Auto-dismiss after this many ms. 0 disables auto-dismiss. */
  duration?: number;
  action?: GlassToastAction;
  /** Bottom offset (safe-area inset + composer height, etc). */
  bottomOffset: number;
}

export const GlassToast = ({
  visible,
  message,
  onDismiss,
  duration = 4000,
  action,
  bottomOffset,
}: GlassToastProps) => {
  const { theme } = useTheme();
  const translate = useRef(new Animated.Value(24)).current;
  const [mounted, setMounted] = useState(visible);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      translate.setValue(24);
      Animated.timing(translate, {
        toValue: 0,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();

      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      if (duration > 0) {
        dismissTimerRef.current = setTimeout(() => {
          dismissTimerRef.current = null;
          onDismiss();
        }, duration);
      }
    } else if (mounted) {
      Animated.timing(translate, {
        toValue: 24,
        duration: 160,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, duration]);

  if (!mounted) return null;

  return (
    <View pointerEvents="box-none" style={[styles.wrapper, { bottom: bottomOffset }]}>
      <Animated.View style={{ transform: [{ translateY: translate }] }}>
        <GlassCard style={styles.toast} contentStyle={styles.toastContent} radius={16}>
          <Text numberOfLines={2} style={[styles.message, { color: theme.colors.onSurface }]}>
            {message}
          </Text>
          {action ? (
            <Pressable
              onPress={() => {
                if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
                action.onPress();
              }}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              hitSlop={8}
            >
              <Text style={[styles.actionLabel, { color: theme.colors.primary }]}>{action.label}</Text>
            </Pressable>
          ) : null}
        </GlassCard>
      </Animated.View>
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
  toast: {
    maxWidth: '100%',
  },
  toastContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    paddingVertical: 10,
    paddingHorizontal: 16,
    minHeight: 40,
  },
  message: {
    fontSize: 14,
    fontWeight: '500',
    flexShrink: 1,
  },
  actionLabel: {
    fontSize: 14,
    fontWeight: '700',
  },
});
