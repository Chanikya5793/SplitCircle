// Generic glass bottom-sheet picker — a single-select or action list presented
// as a proper glass sheet instead of a react-native-paper Dialog/Menu (those
// render opaque Material chrome, never glass; see DESIGN.md "Liquid glass DNA
// > Self-audit"). Tapping a row commits immediately and closes, so this has
// no footer — for a staged multi-field picker with a Save step, build a
// dedicated sheet instead (DisplayCurrencySheet is that pattern).
//
// Sheet DNA (DESIGN.md): fade scrim via the Modal, GLASS sheet bottom-anchored
// sliding up on a native-driver translateY.

import { useTheme } from '@/context/ThemeContext';
import { lightHaptic } from '@/utils/haptics';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassCard } from './GlassCard';

export interface GlassPickerSheetOption {
  key: string;
  label: string;
  /** MaterialCommunityIcons name shown at the row's leading edge. */
  icon?: string;
  selected?: boolean;
  destructive?: boolean;
  onPress: () => void;
}

export interface GlassPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: GlassPickerSheetOption[];
  /** Cap the list height so a long option set scrolls instead of pushing off-screen. */
  maxListHeight?: number;
}

export const GlassPickerSheet = ({
  visible,
  onClose,
  title,
  options,
  maxListHeight = 360,
}: GlassPickerSheetProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  const slide = useRef(new Animated.Value(0)).current;
  const [sheetH, setSheetH] = useState(320);

  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      slide.setValue(0);
      Animated.timing(slide, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
    wasVisible.current = visible;
  }, [visible, slide]);

  const handleClose = () => {
    Animated.timing(slide, { toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(
      ({ finished }) => {
        if (finished) onClose();
      },
    );
  };

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [sheetH + 60, 0] });
  const hairline = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={handleClose} accessibilityLabel={`Close ${title}`} />
        <Animated.View
          onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}
          style={{ transform: [{ translateY }] }}
        >
          <GlassCard role="floating"
            style={styles.sheet}
            contentStyle={[styles.sheetContent, { paddingBottom: insets.bottom + 10 }]}
            intensity={70}
          >
            <View style={[styles.grabber, { backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)' }]} />
            <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
              {title}
            </Text>
            <ScrollView
              style={{ maxHeight: maxListHeight }}
              contentContainerStyle={styles.listContent}
              keyboardShouldPersistTaps="handled"
            >
              {options.map((opt, idx) => (
                <Pressable
                  key={opt.key}
                  onPress={() => {
                    lightHaptic();
                    opt.onPress();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={opt.label}
                  style={({ pressed }) => [
                    styles.row,
                    idx < options.length - 1 && { borderBottomColor: hairline, borderBottomWidth: StyleSheet.hairlineWidth },
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <View style={styles.rowLeft}>
                    {opt.icon ? (
                      <Icon
                        source={opt.icon}
                        size={20}
                        color={opt.destructive ? theme.colors.error : theme.colors.onSurfaceVariant}
                      />
                    ) : null}
                    <Text
                      variant="bodyLarge"
                      style={{ color: opt.destructive ? theme.colors.error : theme.colors.onSurface }}
                    >
                      {opt.label}
                    </Text>
                  </View>
                  {opt.selected ? <Icon source="check" size={20} color={theme.colors.primary} /> : null}
                </Pressable>
              ))}
            </ScrollView>
          </GlassCard>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  sheetContent: {
    paddingTop: 8,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 10,
  },
  title: {
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  listContent: {
    paddingBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: 20,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
});
