import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeBottomTabNavigator } from '@react-navigation/bottom-tabs/unstable';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from 'react-native';

export const AuthStack = createNativeStackNavigator();
export const AppStack = createNativeStackNavigator();
// Native bottom tabs only exist on iOS/Android — the unstable factory throws
// on web, so fall back to the JS tab navigator there (dev preview only).
export const NativeTab: ReturnType<typeof createNativeBottomTabNavigator> =
  Platform.OS === 'web'
    ? (createBottomTabNavigator() as unknown as ReturnType<typeof createNativeBottomTabNavigator>)
    : createNativeBottomTabNavigator();
