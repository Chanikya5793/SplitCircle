// Full-screen unlock panel for the WhatsApp-style app lock. Mounted once,
// above the navigator. When locked it covers everything with an opaque
// neutral screen (so backgrounded content never shows) and auto-triggers the
// biometric prompt; a manual "Unlock" button re-prompts if the user cancels.

import { useAppLock } from '@/context/AppLockContext';
import { APP_NAME } from '@/constants/appInfo';
import { biometricLabel } from '@/services/biometrics';
import { MugguMark } from '@/components/brand';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';

export const AppLockGate = () => {
  const { locked, unlock } = useAppLock();
  const [label, setLabel] = useState('Face ID');
  const [busy, setBusy] = useState(false);
  const autoTriedRef = useRef(false);

  useEffect(() => {
    void biometricLabel().then(setLabel);
  }, []);

  const attempt = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await unlock();
    } finally {
      setBusy(false);
    }
  };

  // Auto-prompt once each time the app becomes locked.
  useEffect(() => {
    if (locked && !autoTriedRef.current) {
      autoTriedRef.current = true;
      void attempt();
    }
    if (!locked) autoTriedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  if (!locked) return null;

  return (
    <View style={styles.overlay} pointerEvents="auto">
      <View style={styles.markShell}>
        <MugguMark
          size={72}
          variant="reversed"
          accessibilityLabel={`${APP_NAME} logo`}
        />
        <View style={styles.lockBadge}>
          <Ionicons name="lock-closed" size={14} color="#fff" />
        </View>
      </View>
      <Text style={styles.title}>{APP_NAME} is locked</Text>
      <TouchableOpacity
        onPress={attempt}
        activeOpacity={0.8}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Unlock with ${label}`}
        style={styles.button}
      >
        <Ionicons name="scan-outline" size={20} color="#fff" />
        <Text style={styles.buttonText}>Unlock with {label}</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 6000,
    elevation: 6000,
    backgroundColor: '#0d0f14',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 32,
  },
  title: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 20,
    fontWeight: '700',
  },
  markShell: {
    position: 'relative',
    marginBottom: 2,
  },
  lockBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
