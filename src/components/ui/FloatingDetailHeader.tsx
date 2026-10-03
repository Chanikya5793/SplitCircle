import { useTheme } from '@/context/ThemeContext';
import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassBackButton } from './GlassBackButton';
import { StickyHeaderPill } from './StickyHeaderPill';

const TOP_SPACING = 12;
const CONTROL_HEIGHT = 44;
const BOTTOM_SPACING = 12;

export const floatingDetailHeaderHeight = (topInset: number): number =>
  topInset + TOP_SPACING + CONTROL_HEIGHT + BOTTOM_SPACING;

export interface FloatingDetailHeaderProps {
  title: string;
  onBack?: () => void;
  style?: StyleProp<ViewStyle>;
}

export const FloatingDetailHeader = ({ title, onBack, style }: FloatingDetailHeaderProps) => {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { paddingTop: insets.top + TOP_SPACING }, style]} pointerEvents="box-none">
      <View style={styles.side}>
        <GlassBackButton onPress={onBack} size={44} />
      </View>
      <View style={styles.titleWrap} pointerEvents="none">
        <StickyHeaderPill style={styles.titlePill}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.colors.onSurface }]}>
            {title}
          </Text>
        </StickyHeaderPill>
      </View>
      <View style={styles.side} />
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 12,
    right: 12,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: BOTTOM_SPACING,
  },
  side: {
    width: CONTROL_HEIGHT,
    height: CONTROL_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleWrap: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  titlePill: {
    minHeight: CONTROL_HEIGHT,
    maxWidth: '100%',
    paddingVertical: 8,
    paddingHorizontal: 18,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
});
