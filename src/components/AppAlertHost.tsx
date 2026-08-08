// Renders appAlert() requests as a glass ACTION SHEET.
//
// Not web-only any more (2026-08-07): appAlert also routes here on ANDROID
// when a menu has more than three buttons, because Android's AlertDialog has
// only three button slots and RN silently drops the rest — which is how the
// long-press quick-action menus ended up with no visible Cancel. See
// utils/appAlert.ts. Everything else still goes to the native Alert.
//
// PRESENTATION (rebuilt 2026-08-08). This was a react-native-paper `Dialog`
// with the buttons in `Dialog.Actions`, and it looked exactly like what it was:
// Paper lays those out in a single horizontal ROW, so a five-action long-press
// menu became "Voice call  Video call  Call info  Delete from history  Cancel"
// squeezed onto one line in a lavender MD3 pill floating in the middle of the
// screen — unreadable, untappable, and stock Material chrome in an app whose
// DESIGN.md forbids exactly that (see "Liquid glass DNA > Self-audit"; the same
// mistake as the old AddExpenseScreen Paper pickers).
//
// It is now the same shape as every other sheet in the app (GlassPickerSheet is
// the reference): RN core Modal — NOT Paper's, whose Surface animates `opacity`
// and kills the native glass material — a dark scrim, and a bottom-anchored
// GlassCard sliding up on a native-driver translateY. One action per row, full
// width, so each is a real 52pt touch target and reads top to bottom.
//
// Cancel is lifted out into its own card below the others, iOS action-sheet
// style: it is the "get me out of here" affordance, and separating it makes it
// findable without reading the list.

import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import { registerAppAlertHost, type AppAlertRequest } from '@/utils/appAlert';
import { lightHaptic } from '@/utils/haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AlertButton } from 'react-native';

const SHEET_IN_MS = 280;
const SHEET_OUT_MS = 180;

export function AppAlertHost() {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const [pending, setPending] = useState<AppAlertRequest[]>([]);

  useEffect(() => {
    // Subscribe on every platform — appAlert decides what reaches here.
    return registerAppAlertHost((request) => {
      setPending((previous) => [...previous, request]);
    });
  }, []);

  const current = pending[0];

  const slide = useRef(new Animated.Value(0)).current;
  const [sheetH, setSheetH] = useState(320);
  const reduceMotion = theme?.reduceMotion === true;

  // Re-run the entrance for EVERY request, not just the first: the queue can
  // hand us a second alert while the host stays mounted, and a shared value
  // left at 1 would make it appear with no transition at all.
  const shownId = useRef<number | null>(null);
  useEffect(() => {
    if (!current) {
      shownId.current = null;
      return;
    }
    if (shownId.current === current.id) return;
    shownId.current = current.id;
    if (reduceMotion) {
      slide.setValue(1);
      return;
    }
    slide.setValue(0);
    Animated.timing(slide, {
      toValue: 1,
      duration: SHEET_IN_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [current, reduceMotion, slide]);

  const close = useCallback(
    (after?: () => void) => {
      const finish = () => {
        setPending((previous) => previous.slice(1));
        after?.();
      };
      if (reduceMotion) {
        finish();
        return;
      }
      Animated.timing(slide, {
        toValue: 0,
        duration: SHEET_OUT_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        // Always settle, even if the animation was interrupted — otherwise the
        // request would be stuck at the head of the queue forever.
        finish();
        if (!finished) slide.setValue(0);
      });
    },
    [reduceMotion, slide],
  );

  const handlePress = useCallback(
    (button: AlertButton) => {
      lightHaptic();
      close(() => button.onPress?.());
    },
    [close],
  );

  const handleDismiss = useCallback(() => {
    if (!current) return;
    const cancelable = current.options?.cancelable ?? true;
    if (!cancelable) return;
    close(() => current.options?.onDismiss?.());
  }, [close, current]);

  if (!current) return null;

  const hairline = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)';
  const danger = theme?.colors?.danger ?? theme?.colors?.error ?? '#D02A1F';
  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [sheetH + 80, 0] });

  // Cancel is presented separately below, so it must not also appear in the
  // main list. Only the FIRST cancel-styled button is treated this way — a
  // malformed caller passing two would otherwise silently lose one.
  const cancelIndex = current.buttons.findIndex((b) => b.style === 'cancel');
  const cancelButton = cancelIndex >= 0 ? current.buttons[cancelIndex] : undefined;
  const actions = current.buttons.filter((_, i) => i !== cancelIndex);
  const hasHeader = Boolean(current.title || current.message);

  const renderAction = (button: AlertButton, index: number, total: number) => (
    <Pressable
      key={`${current.id}-${index}`}
      onPress={() => handlePress(button)}
      accessibilityRole="button"
      accessibilityLabel={button.text ?? 'OK'}
      style={({ pressed }) => [
        styles.action,
        index < total - 1 && { borderBottomColor: hairline, borderBottomWidth: StyleSheet.hairlineWidth },
        pressed && { backgroundColor: theme?.colors?.pressHighlight ?? 'rgba(0,0,0,0.10)' },
      ]}
    >
      <Text
        variant="bodyLarge"
        style={[
          styles.actionText,
          { color: button.style === 'destructive' ? danger : theme.colors.onSurface },
        ]}
      >
        {button.text ?? 'OK'}
      </Text>
    </Pressable>
  );

  return (
    <Modal
      visible
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={handleDismiss}
    >
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={handleDismiss}
          accessibilityRole="button"
          accessibilityLabel={`Close ${current.title || 'menu'}`}
        />
        <Animated.View
          onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}
          style={[styles.sheetWrap, { paddingBottom: insets.bottom + 10 }, { transform: [{ translateY }] }]}
        >
          <GlassCard role="floating" style={styles.sheet} intensity={70}>
            {hasHeader && (
              <View style={[styles.header, { borderBottomColor: hairline }]}>
                {current.title ? (
                  <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
                    {current.title}
                  </Text>
                ) : null}
                {current.message ? (
                  <Text
                    variant="bodySmall"
                    style={[styles.message, { color: theme.colors.onSurfaceVariant }]}
                  >
                    {current.message}
                  </Text>
                ) : null}
              </View>
            )}
            {/* Scrolls rather than growing past the screen: a long menu at a
                large OS text size would otherwise push its own actions off the
                bottom, out of reach. */}
            <ScrollView style={styles.list} bounces={false}>
              {actions.map((button, index) => renderAction(button, index, actions.length))}
            </ScrollView>
          </GlassCard>

          {cancelButton && (
            <GlassCard role="floating" style={styles.cancelCard} intensity={70}>
              <Pressable
                onPress={() => handlePress(cancelButton)}
                accessibilityRole="button"
                accessibilityLabel={cancelButton.text ?? 'Cancel'}
                style={({ pressed }) => [
                  styles.action,
                  pressed && { backgroundColor: theme?.colors?.pressHighlight ?? 'rgba(0,0,0,0.10)' },
                ]}
              >
                <Text
                  variant="bodyLarge"
                  style={[styles.actionText, styles.cancelText, { color: theme.colors.onSurface }]}
                >
                  {cancelButton.text ?? 'Cancel'}
                </Text>
              </Pressable>
            </GlassCard>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheetWrap: {
    paddingHorizontal: 10,
    gap: 8,
  },
  sheet: {
    borderRadius: 18,
    overflow: 'hidden',
  },
  cancelCard: {
    borderRadius: 18,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 12,
    gap: 3,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontWeight: '700',
    textAlign: 'center',
  },
  message: {
    textAlign: 'center',
  },
  list: {
    // Bounded so the sheet can never grow taller than the screen; ScrollView
    // takes over past this.
    maxHeight: 420,
  },
  action: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  actionText: {
    textAlign: 'center',
  },
  cancelText: {
    fontWeight: '700',
  },
});
