import { GlassView } from '@/components/GlassView';
import { colors } from '@/constants';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useEffect, useState } from 'react';
import { Dimensions, LayoutChangeEvent, StyleSheet, TouchableOpacity, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export const GlassTabBar = ({ state, descriptors, navigation }: BottomTabBarProps) => {
  const insets = useSafeAreaInsets();
  const focusedOptions = descriptors[state.routes[state.index].key].options;

  // Animation values
  const indicatorPosition = useSharedValue(0);
  const indicatorWidth = useSharedValue(0);
  const [layout, setLayout] = useState<{ x: number; width: number }[]>([]);

  // @ts-ignore - tabBarStyle might not be fully typed in some versions or custom types
  if (focusedOptions.tabBarStyle?.display === 'none') {
    return null;
  }

  useEffect(() => {
    if (layout[state.index]) {
      indicatorPosition.value = withSpring(layout[state.index].x, {
        damping: 15,
        stiffness: 100,
      });
      indicatorWidth.value = withSpring(layout[state.index].width, {
        damping: 15,
        stiffness: 100,
      });
    }
  }, [state.index, layout]);

  const animatedIndicatorStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateX: indicatorPosition.value }],
      width: indicatorWidth.value,
    };
  });

  const handleLayout = (event: LayoutChangeEvent, index: number) => {
    const { x, width } = event.nativeEvent.layout;
    setLayout((prev) => {
      const newLayout = [...prev];
      newLayout[index] = { x, width };
      return newLayout;
    });
  };

  return (
    <View style={[styles.container, { bottom: -18 + insets.bottom }]}>
      <GlassView style={styles.glass} intensity={20}>
        <View style={styles.tabRow}>
          {/* Animated Liquid Indicator */}
          <Animated.View style={[styles.indicator, animatedIndicatorStyle]}>
            <View style={styles.indicatorBlob} />
          </Animated.View>

          {state.routes.map((route, index) => {
            const { options } = descriptors[route.key];
            const label =
              options.tabBarLabel !== undefined
                ? options.tabBarLabel
                : options.title !== undefined
                  ? options.title
                  : route.name;

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

            const color = isFocused ? colors.primary : '#666';
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
                    IconComponent({ focused: isFocused, color: isFocused ? '#fff' : color, size: 24 })
                  ) : (
                    <MaterialCommunityIcons name="circle-outline" size={24} color={isFocused ? '#fff' : color} />
                  )}
                </View>

                {/* Optional: Hide label on focus for cleaner look, or keep it. Keeping it for now but styling it. */}
                {/* <Text
                  variant="labelSmall"
                  style={{ color, marginTop: 4, fontWeight: isFocused ? 'bold' : 'normal', opacity: isFocused ? 0 : 1, height: isFocused ? 0 : 'auto' }}
                >
                  {label as string}
                </Text> */}
              </TouchableOpacity>
            );
          })}
        </View>
      </GlassView>
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
  },
  indicator: {
    position: 'absolute',
    height: '80%',
    top: '10%',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: -1, // Behind the icons
  },
  indicatorBlob: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: colors.primary,
    opacity: 0.8,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 5,
  },
  iconContainer: {
    padding: 8,
    borderRadius: 20,
  },
  iconContainerFocused: {
    // transform: [{ translateY: -5 }], // Optional bounce effect
  }
});
