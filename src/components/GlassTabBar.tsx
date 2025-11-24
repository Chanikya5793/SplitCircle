import { GlassView } from '@/components/GlassView';
import { colors } from '@/constants';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const GlassTabBar = ({ state, descriptors, navigation }: BottomTabBarProps) => {
  const insets = useSafeAreaInsets();
  const focusedOptions = descriptors[state.routes[state.index].key].options;

  // @ts-ignore - tabBarStyle might not be fully typed in some versions or custom types
  if (focusedOptions.tabBarStyle?.display === 'none') {
    return null;
  }

  return (
    <View style={[styles.container, { bottom: -18 + insets.bottom }]}>
      <GlassView style={styles.glass} intensity={20}>
        <View style={styles.tabRow}>
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

            // Get the icon from the options or default
            // Note: In AppNavigator we defined tabBarIcon in screenOptions
            // We can't easily access the render function passed to screenOptions here without invoking it.
            // But we can replicate the icon logic or pass it differently.
            // A better way is to let the navigator handle the icon rendering if possible, 
            // but for custom tab bar we often need to reconstruct it.
            // Let's look at how AppNavigator defines icons.
            
            const color = isFocused ? colors.primary : '#666';

            // Use the tabBarIcon from options if available
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
              >
                {IconComponent ? (
                  IconComponent({ focused: isFocused, color, size: 24 })
                ) : (
                  <MaterialCommunityIcons name="circle-outline" size={24} color={color} />
                )}
                <Text
                  variant="labelSmall"
                  style={{ color, marginTop: 4, fontWeight: isFocused ? 'bold' : 'normal' }}
                >
                  {label as string}
                </Text>
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
    zIndex: 1000, // Ensure tab bar is always on top
  },
  glass: {
    borderRadius: 30,
    width: '100%',
    overflow: 'hidden',
  },
  tabRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: 12,
  },
  tab: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
});
