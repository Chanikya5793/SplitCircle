import { createNativeBottomTabNavigator } from '@react-navigation/bottom-tabs/unstable';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

export const AuthStack = createNativeStackNavigator();
export const AppStack = createNativeStackNavigator();
export const NativeTab = createNativeBottomTabNavigator();
