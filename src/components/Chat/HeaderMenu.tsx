import { useTheme } from '@/context/ThemeContext';
import { lightHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect } from 'react';
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

  const fade = useSharedValue(0);
  const translate = useSharedValue(-6);

  useEffect(() => {
    if (visible) {
      fade.value = withTiming(1, { duration: 120, easing: Easing.out(Easing.quad) });
      translate.value = withTiming(0, { duration: 140, easing: Easing.out(Easing.quad) });
    } else {
      fade.value = withTiming(0, { duration: 100 });
      translate.value = withTiming(-6, { duration: 100 });
    }
  }, [visible, fade, translate]);

  const handleClose = () => {
    fade.value = withTiming(0, { duration: 100 }, (finished) => {
      if (finished) runOnJS(onClose)();
    });
    translate.value = withTiming(-6, { duration: 100 });
  };

  const sheetStyle = useAnimatedStyle(() => ({
    opacity: fade.value,
    transform: [{ translateY: translate.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: fade.value * 0.4 }));

  const surface = isDark ? '#1c1c20' : '#ffffff';
  const divider = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="none" onRequestClose={handleClose}>
      <View style={StyleSheet.absoluteFill}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose}>
          <Animated.View style={[styles.backdrop, backdropStyle]} />
        </Pressable>
        <Animated.View
          style={[
            styles.menu,
            { top: topInset + 56, backgroundColor: surface },
            sheetStyle,
          ]}
        >
          {items.map((item, idx) => (
            <TouchableOpacity
              key={item.key}
              activeOpacity={0.7}
              onPress={() => {
                lightHaptic();
                item.onPress();
                handleClose();
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
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  menu: {
    position: 'absolute',
    right: 12,
    minWidth: 200,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
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
