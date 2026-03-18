/**
 * ScanningAnimation — Visual feedback during receipt scanning
 *
 * Shows a receipt image with a sweeping laser-scan line animation.
 * Items "appear" sequentially with subtle fade-in effects.
 * Progress indicator shows current scan stage.
 */

import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTheme } from '@/context/ThemeContext';
import { GlassView } from '@/components/GlassView';

interface ScanningAnimationProps {
  /** Current scan phase */
  phase: 'scanning' | 'processing' | 'parsing' | 'complete';
  /** Status message to display */
  message: string;
  /** Number of items found so far */
  itemCount?: number;
  /** URI of the scanned receipt image */
  imageUri?: string;
}

export const ScanningAnimation = ({
  phase,
  message,
  itemCount = 0,
}: ScanningAnimationProps) => {
  const { theme } = useTheme();
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0.6)).current;
  const itemCountAnim = useRef(new Animated.Value(0)).current;
  const checkAnim = useRef(new Animated.Value(0)).current;

  // Sweeping scan line animation
  useEffect(() => {
    if (phase === 'scanning' || phase === 'processing') {
      const loop = Animated.loop(
        Animated.timing(scanLineAnim, {
          toValue: 1,
          duration: 1800,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      );
      loop.start();
      return () => loop.stop();
    }
  }, [phase, scanLineAnim]);

  // Pulsing glow effect
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.6,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  // Item count bounce
  useEffect(() => {
    if (itemCount > 0) {
      Animated.spring(itemCountAnim, {
        toValue: 1,
        friction: 5,
        tension: 80,
        useNativeDriver: true,
      }).start();
    }
  }, [itemCount, itemCountAnim]);

  // Completion check animation
  useEffect(() => {
    if (phase === 'complete') {
      Animated.spring(checkAnim, {
        toValue: 1,
        friction: 4,
        tension: 60,
        useNativeDriver: true,
      }).start();
    }
  }, [phase, checkAnim]);

  const scanLineTranslateY = scanLineAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 160],
  });

  const isActive = phase === 'scanning' || phase === 'processing' || phase === 'parsing';
  const isComplete = phase === 'complete';

  const accentColor = isComplete ? '#34C759' : '#007AFF';

  return (
    <View style={styles.container}>
      <GlassView style={styles.card}>
        {/* Scan visualization area */}
        <View style={[styles.scanArea, { borderColor: `${accentColor}30` }]}>
          {/* Scan line */}
          {isActive && (
            <Animated.View
              style={[
                styles.scanLine,
                {
                  backgroundColor: accentColor,
                  transform: [{ translateY: scanLineTranslateY }],
                  opacity: pulseAnim,
                },
              ]}
            />
          )}

          {/* Center icon */}
          <Animated.View
            style={[
              styles.iconContainer,
              {
                opacity: pulseAnim,
                transform: isComplete
                  ? [{ scale: checkAnim }]
                  : [{ scale: pulseAnim.interpolate({
                      inputRange: [0.6, 1],
                      outputRange: [0.95, 1.05],
                    })}],
              },
            ]}
          >
            <View style={[styles.iconCircle, { backgroundColor: `${accentColor}15` }]}>
              <Icon
                source={isComplete ? 'check-circle' : 'receipt'}
                size={48}
                color={accentColor}
              />
            </View>
          </Animated.View>

          {/* Corner guides */}
          <View style={[styles.cornerTL, { borderColor: accentColor }]} />
          <View style={[styles.cornerTR, { borderColor: accentColor }]} />
          <View style={[styles.cornerBL, { borderColor: accentColor }]} />
          <View style={[styles.cornerBR, { borderColor: accentColor }]} />
        </View>

        {/* Status text */}
        <Text
          variant="titleMedium"
          style={[styles.statusText, { color: theme.colors.onSurface }]}
        >
          {message}
        </Text>

        {/* Item count badge */}
        {itemCount > 0 && (
          <Animated.View
            style={[
              styles.itemBadge,
              {
                backgroundColor: `${accentColor}15`,
                borderColor: `${accentColor}30`,
                transform: [{ scale: itemCountAnim }],
              },
            ]}
          >
            <Icon source="format-list-checks" size={18} color={accentColor} />
            <Text
              variant="labelMedium"
              style={{ color: accentColor, fontWeight: '700' }}
            >
              {itemCount} {itemCount === 1 ? 'item' : 'items'} found
            </Text>
          </Animated.View>
        )}

        {/* Progress dots */}
        {isActive && (
          <View style={styles.progressDots}>
            {[0, 1, 2].map((i) => (
              <Animated.View
                key={i}
                style={[
                  styles.dot,
                  {
                    backgroundColor: accentColor,
                    opacity: pulseAnim.interpolate({
                      inputRange: [0.6, 1],
                      outputRange: [i === 1 ? 1 : 0.3, i === 1 ? 0.3 : 1],
                    }),
                  },
                ]}
              />
            ))}
          </View>
        )}
      </GlassView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  card: {
    padding: 24,
    borderRadius: 24,
    alignItems: 'center',
    width: '100%',
    gap: 16,
  },
  scanArea: {
    width: 200,
    height: 180,
    borderWidth: 1,
    borderRadius: 16,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  scanLine: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: 2,
    borderRadius: 1,
    top: 8,
  },
  iconContainer: {
    zIndex: 1,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cornerTL: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 20,
    height: 20,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 8,
  },
  cornerTR: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 20,
    height: 20,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 8,
  },
  cornerBL: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 20,
    height: 20,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 8,
  },
  cornerBR: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 20,
    height: 20,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 8,
  },
  statusText: {
    textAlign: 'center',
    fontWeight: '600',
  },
  itemBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
  },
  progressDots: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
