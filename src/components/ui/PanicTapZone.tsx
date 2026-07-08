// PanicTapZone — a silent alternative to shaking. When the guard is armed and
// a panic corner is configured, a small invisible target sits in the status-bar
// corner (above the app's own headers, where there are no controls to steal
// taps from). Three quick taps trip the shields — discreet, no arm motion.

import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { warningHaptic } from '@/utils/haptics';
import { useRef } from 'react';
import { StyleSheet, TouchableWithoutFeedback, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const TAP_WINDOW_MS = 600;
const TAPS_TO_TRIP = 3;

export const PanicTapZone = () => {
  const { settings, active, trip } = usePrivacyGuard();
  const insets = useSafeAreaInsets();
  const tapsRef = useRef<number[]>([]);

  const armed = settings.enabled && Boolean(settings.codeHash);
  // Nothing to do once shields are already up (the reveal path owns that).
  if (!armed || active || settings.panicCorner === 'off') return null;

  const onTap = () => {
    const now = Date.now();
    tapsRef.current = [...tapsRef.current.filter((t) => now - t < TAP_WINDOW_MS), now];
    if (tapsRef.current.length < TAPS_TO_TRIP) return;
    tapsRef.current = [];
    warningHaptic();
    trip();
  };

  const height = Math.max(insets.top, 28);
  const sideStyle = settings.panicCorner === 'top-left' ? { left: 0 } : { right: 0 };

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <TouchableWithoutFeedback onPress={onTap} accessible={false}>
        <View style={[styles.zone, { height, width: 96 }, sideStyle]} />
      </TouchableWithoutFeedback>
    </View>
  );
};

const styles = StyleSheet.create({
  zone: {
    position: 'absolute',
    top: 0,
    backgroundColor: 'transparent',
  },
});
