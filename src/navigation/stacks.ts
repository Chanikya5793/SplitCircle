import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

export const AuthStack = createNativeStackNavigator();
export const GroupStack = createNativeStackNavigator();
export const ChatStack = createNativeStackNavigator();
export const CallStack = createNativeStackNavigator();
export const Tab = createBottomTabNavigator();
