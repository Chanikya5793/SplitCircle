import { useTheme } from '@/context/ThemeContext';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { Dimensions, LayoutChangeEvent, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export const GlassTabBar = ({ state, descriptors, navigation }: BottomTabBarProps) => {
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useTheme();
  const focusedOptions = descriptors[state.routes[state.index].key].options;

  // @ts-ignore - tabBarStyle might not be fully typed in some versions or custom types
  // CRITICAL: This check must be at the top, before any hooks
  if (focusedOptions.tabBarStyle?.display === 'none') {
    return null;
  }

  // ... (keep existing hooks) ...
  // Animation values
  const indicatorPosition = useSharedValue(0);
  const indicatorWidth = useSharedValue(0);
  const [layout, setLayout] = useState<{ x: number; width: number }[]>([]);
  const isDragging = useSharedValue(false);

  // Derived values for squash and stretch
  // We track the previous position to calculate "velocity" (change in position)
  const prevPosition = useSharedValue(0);

  // Wobble effect shared value
  const wobble = useSharedValue(0);

  // Scale effect shared value
  const activeScale = useSharedValue(1);

  const movementScale = useDerivedValue(() => {
    const delta = Math.abs(indicatorPosition.value - prevPosition.value);
    prevPosition.value = indicatorPosition.value;
    // Stronger stretch for "liquid" feel
    // Map delta to a scale factor. 
    return interpolate(delta, [0, 10, 40], [1, 1.2, 1.5], Extrapolation.CLAMP);
  });

  useEffect(() => {
    // Only animate if we have layout data for the current index
    if (layout[state.index] && !isDragging.value) {
      const targetX = layout[state.index].x;
      const targetWidth = layout[state.index].width;

      // Trigger wobble on arrival
      wobble.value = withSequence(
        withTiming(0, { duration: 0 }), // Reset
        withSpring(1, { damping: 10, stiffness: 200 }) // Initial impact
      );

      // Trigger scale pulse on arrival/tap
      activeScale.value = withSequence(
        withTiming(1.15, { duration: 150 }),
        withSpring(1, { damping: 12, stiffness: 150 })
      );

      indicatorPosition.value = withSpring(targetX, {
        damping: 14,
        stiffness: 150,
        mass: 1,
      });
      indicatorWidth.value = withSpring(targetWidth, {
        damping: 15,
        stiffness: 100,
      });
    }
  }, [state.index, layout]);

  const animatedIndicatorStyle = useAnimatedStyle(() => {
    // If we don't have a valid width yet, hide the indicator to prevent it appearing in wrong place
    if (indicatorWidth.value === 0) {
      return { opacity: 0 };
    }

    const scaleX = movementScale.value;
    // Add wobble effect: when wobble is high, oscillate scale slightly
    // This is a simplified wobble; for true fluid sim we'd need more complex math.
    // Here we just add a bit of extra "squash" when settling.
    const wobbleFactor = Math.sin(wobble.value * Math.PI * 4) * 0.1 * (1 - wobble.value);

    // Combine movement stretch with active scale (tap/drag size increase)
    const finalScaleX = (scaleX + wobbleFactor) * activeScale.value;
    const finalScaleY = ((1 / scaleX) - wobbleFactor) * activeScale.value;

    return {
      transform: [
        { translateX: indicatorPosition.value },
        { scaleX: finalScaleX },
        { scaleY: finalScaleY },
      ],
      width: indicatorWidth.value,
      opacity: 1,
    };
  });

  const handleLayout = (event: LayoutChangeEvent, index: number) => {
    const { x, width } = event.nativeEvent.layout;
    setLayout((prev) => {
      const newLayout = [...prev];
      // Only update if changed to avoid loops, though React state handles this mostly
      if (!prev[index] || prev[index].x !== x || prev[index].width !== width) {
        newLayout[index] = { x, width };
      }
      return newLayout;
    });
  };

  const navigateToTab = (index: number) => {
    const route = state.routes[index];
    const event = navigation.emit({
      type: 'tabPress',
      target: route.key,
      canPreventDefault: true,
    });

    if (state.index !== index && !event.defaultPrevented) {
      navigation.navigate(route.name, route.params);
    }
  };

  const pan = Gesture.Pan()
    .onStart(() => {
      isDragging.value = true;
      // Scale up when dragging starts
      activeScale.value = withSpring(1.15, { damping: 12, stiffness: 150 });
    })
    .onUpdate((e) => {
      // e.x is relative to the view the gesture is attached to (the container)
      indicatorPosition.value = e.x - (indicatorWidth.value / 2);
    })
    .onFinalize((e) => {
      isDragging.value = false;
      // Scale back down when dragging ends
      activeScale.value = withSpring(1, { damping: 12, stiffness: 150 });

      // Find closest tab
      let closestIndex = state.index;
      let minDistance = Number.MAX_VALUE;

      // We use the center of the indicator as the reference point
      const indicatorCenter = indicatorPosition.value + (indicatorWidth.value / 2);

      layout.forEach((tab, index) => {
        const tabCenter = tab.x + (tab.width / 2);
        const distance = Math.abs(indicatorCenter - tabCenter);
        if (distance < minDistance) {
          minDistance = distance;
          closestIndex = index;
        }
      });

      runOnJS(navigateToTab)(closestIndex);

      // If we stay on same tab, spring back manually
      if (closestIndex === state.index && layout[closestIndex]) {
        indicatorPosition.value = withSpring(layout[closestIndex].x, {
          damping: 14,
          stiffness: 150,
          mass: 1,
        });
      }
    });

  return (
    <View style={[styles.container, { bottom: -18 + insets.bottom }]}>
      <GestureDetector gesture={pan}>
        <BlurView style={styles.glass} intensity={20} tint={isDark ? "dark" : "light"}>
          <View style={styles.tabRow}>
            {/* Animated Liquid Indicator */}
            {/* We render the indicator only if we have at least one layout measurement to avoid jumping */}
            {layout.length > 0 && (
              <Animated.View style={[styles.indicator, animatedIndicatorStyle]}>
                <LinearGradient
                  colors={[theme.colors.primary, '#8A2BE2']} // Gradient from primary to a purple-ish hue
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={[styles.indicatorBlob, { shadowColor: theme.colors.primary }]}
                >
                  <View style={styles.glare} />
                </LinearGradient>
              </Animated.View>
            )}

            {state.routes.map((route, index) => {
              const { options } = descriptors[route.key];
              const isFocused = state.index === index;

              const onPress = () => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });

                if (!isFocused && !event.defaultPrevented) {
                  navigation.navigate(route.name, route.params);
                }
              };

              const onLongPress = () => {
                navigation.emit({
                  type: 'tabLongPress',
                  target: route.key,
                });
              };

              const color = isFocused ? '#fff' : (isDark ? '#aaa' : '#666');
              const IconComponent = options.tabBarIcon;

              return (
                <TouchableOpacity
                  key={route.key}
                  accessibilityRole="button"
                  accessibilityState={isFocused ? { selected: true } : {}}
                  accessibilityLabel={options.tabBarAccessibilityLabel}
                  onPress={onPress}
                  onLongPress={onLongPress}
                  style={styles.tab}
                  onLayout={(e) => handleLayout(e, index)}
                >
                  <View style={[styles.iconContainer, isFocused && styles.iconContainerFocused]}>
                    {IconComponent ? (
                      IconComponent({ focused: isFocused, color: color, size: 24 })
                    ) : (
                      <MaterialCommunityIcons name="circle-outline" size={24} color={color} />
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </BlurView>
      </GestureDetector>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 20,
    right: 20,
    alignItems: 'center',
    zIndex: 1000,
  },
  glass: {
    borderRadius: 30,
    width: '100%',
    overflow: 'hidden',
    height: 70, // Fixed height for consistency
    justifyContent: 'center',
  },
  tabRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    height: '100%',
  },
  tab: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    height: '100%',
    zIndex: 1, // Ensure icons are above the indicator
  },
  indicator: {
    position: 'absolute',
    height: '100%', // Full height of container to allow centering
    top: 0,
    left: 0, // Fix alignment issue
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 0, // Behind the icons but visible
  },
  indicatorBlob: {
    width: 70, // Increased size
    height: 45, // Increased size
    borderRadius: 22.5, // Half of height for pill shape
    // backgroundColor: removed (handled by gradient)
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)', // Glass border
    opacity: 0.9,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
    overflow: 'hidden', // Ensure gradient respects border radius
  },
  glare: {
    position: 'absolute',
    top: 5,
    left: 10,
    width: 20,
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.4)',
    transform: [{ rotate: '-20deg' }],
  },
  iconContainer: {
    padding: 8,
    borderRadius: 20,
  },
  iconContainerFocused: {
    // transform: [{ translateY: -5 }], // Optional bounce effect
  }
});
