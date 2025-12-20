import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Trigger light haptic feedback (for button presses, selections)
 */
export const lightHaptic = () => {
  if (Platform.OS !== 'web') {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }
};

/**
 * Trigger medium haptic feedback (for confirmations, toggles)
 */
export const mediumHaptic = () => {
  if (Platform.OS !== 'web') {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }
};

/**
 * Trigger heavy haptic feedback (for destructive actions, important events)
 */
export const heavyHaptic = () => {
  if (Platform.OS !== 'web') {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  }
};

/**
 * Trigger success notification haptic
 */
export const successHaptic = () => {
  if (Platform.OS !== 'web') {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }
};

/**
 * Trigger warning notification haptic
 */
export const warningHaptic = () => {
  if (Platform.OS !== 'web') {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }
};

/**
 * Trigger error notification haptic
 */
export const errorHaptic = () => {
  if (Platform.OS !== 'web') {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  }
};

/**
 * Trigger selection change haptic (for tab switches, picker changes)
 */
export const selectionHaptic = () => {
  if (Platform.OS !== 'web') {
    Haptics.selectionAsync();
  }
};
