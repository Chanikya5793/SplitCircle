import { Platform } from 'react-native';

// Shared sizing contract for the custom floating tab bar.
// Keep screen paddings and floating controls in sync with this file.
export const FLOATING_TAB_BAR_HEIGHT = Platform.OS === 'ios' ? 68 : 70;
export const FLOATING_TAB_BAR_HORIZONTAL_INSET = 20;
export const FLOATING_TAB_BAR_BOTTOM_GAP = Platform.OS === 'ios' ? -6 : 8;

export const getFloatingTabBarBottomOffset = (safeAreaBottom: number) => {
  return safeAreaBottom + FLOATING_TAB_BAR_BOTTOM_GAP;
};

export const getFloatingTabBarEnvelopeHeight = (safeAreaBottom: number) => {
  return FLOATING_TAB_BAR_HEIGHT + getFloatingTabBarBottomOffset(safeAreaBottom);
};

export const getFloatingTabBarContentPadding = (
  safeAreaBottom: number,
  extraSpacing: number = 20
) => {
  return getFloatingTabBarEnvelopeHeight(safeAreaBottom) + extraSpacing;
};
