import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import { lightHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef } from 'react';
import { Modal, Pressable, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

export interface HeaderMenuItem {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  destructive?: boolean;
}

interface HeaderMenuProps {
  visible: boolean;
  topInset: number;
  items: HeaderMenuItem[];
  onClose: () => void;
}

export const HeaderMenu = ({ visible, topInset, items, onClose }: HeaderMenuProps) => {
  const { theme, isDark } = useTheme();

  // Backdrop fade is fine on opacity (it's a plain scrim, not glass). The menu
  // itself must reveal via TRANSFORM ONLY — DESIGN.md's native-material kill
  // list: any ancestor with fractional opacity stops the iOS 26 glass
  // material from rendering at all (same fix as ScreenScaffold's
  // StickyGlassHeader). scale+translateY gives the same "pop in" feel opacity
  // did without touching alpha.
  const fade = useSharedValue(0);
  const translate = useSharedValue(-6);
  const scale = useSharedValue(0.94);

  useEffect(() => {
    if (visible) {
      fade.value = withTiming(1, { duration: 120, easing: Easing.out(Easing.quad) });
      translate.value = withTiming(0, { duration: 140, easing: Easing.out(Easing.quad) });
      scale.value = withTiming(1, { duration: 140, easing: Easing.out(Easing.quad) });
    } else {
      fade.value = withTiming(0, { duration: 100 });
      translate.value = withTiming(-6, { duration: 100 });
      scale.value = withTiming(0.94, { duration: 100 });
    }
  }, [visible, fade, translate, scale]);

  // The item-press dispatch below is deliberately deferred (see its comment)
  // via a bare setTimeout with no owner — if the screen holding this menu
  // unmounts within that window (a swipe-back finishing before the 320ms is
  // up), it used to fire anyway, against stale closures. Track it so unmount
  // can cancel it.
  const dispatchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (dispatchTimeoutRef.current) {
        clearTimeout(dispatchTimeoutRef.current);
        dispatchTimeoutRef.current = null;
      }
    };
  }, []);

  const handleClose = () => {
    fade.value = withTiming(0, { duration: 100 }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
    translate.value = withTiming(-6, { duration: 100 });
    scale.value = withTiming(0.94, { duration: 100 });
  };

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translate.value }, { scale: scale.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: fade.value * 0.4 }));

  const divider = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="none" onRequestClose={handleClose}>
      <View style={StyleSheet.absoluteFill}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose}>
          <Animated.View style={[styles.backdrop, backdropStyle]} />
        </Pressable>
        <Animated.View style={[styles.menuWrap, { top: topInset + 56 }, sheetStyle]}>
          <GlassCard radius={14} contentStyle={styles.menuContent}>
            {items.map((item, idx) => (
              <TouchableOpacity
                key={item.key}
                activeOpacity={0.7}
                onPress={() => {
                  lightHaptic();
                  // Close FIRST, run the action after the Modal is fully gone:
                  // actions that present native UI (image picker, share sheet)
                  // silently fail if invoked while this Modal is dismissing.
                  handleClose();
                  if (dispatchTimeoutRef.current) clearTimeout(dispatchTimeoutRef.current);
                  dispatchTimeoutRef.current = setTimeout(() => {
                    dispatchTimeoutRef.current = null;
                    item.onPress();
                  }, 320);
                }}
                style={[
                  styles.row,
                  idx < items.length - 1 && {
                    borderBottomColor: divider,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <Ionicons
                  name={item.icon}
                  size={18}
                  color={item.destructive ? theme.colors.error : theme.colors.onSurface}
                  style={{ marginRight: 12 }}
                />
                <Text
                  style={[
                    styles.label,
                    { color: item.destructive ? theme.colors.error : theme.colors.onSurface },
                  ]}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            ))}
          </GlassCard>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  menuWrap: {
    position: 'absolute',
    right: 12,
    minWidth: 200,
  },
  menuContent: {
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  label: { fontSize: 15, fontWeight: '500' },
});

export default HeaderMenu;
