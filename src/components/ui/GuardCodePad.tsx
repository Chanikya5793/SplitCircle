// GuardCodePad — the ONE code-entry surface for the privacy guard.
//
// Replaces every appPrompt() alert (shake-reveal, 7-tap Settings entry, the
// LockedOverlay, and setting/changing the secret & duress codes) with a
// proper themed keypad: PIN-style dots, digit grid, shake-on-error, lockout
// countdown, and an alphanumeric fallback for legacy text codes.
//
// Deliberately boring: no branding, no lock imagery beyond the copy the
// caller passes — glimpsed over a shoulder it reads like any passcode sheet.
// Validation stays with the CALLER via onSubmit so duress handling (silent
// fake success) never leaks into this component.

import { useTheme } from '@/context/ThemeContext';
import { lockoutRemainingMs } from '@/services/privacyGuardService';
import { errorHaptic, lightHaptic, successHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type CodePadOutcome =
  | { status: 'ok' }
  | { status: 'wrong' }
  | { status: 'locked'; lockedForMs: number }
  | { status: 'invalid'; message: string };

export interface GuardCodePadProps {
  visible: boolean;
  /** e.g. "Enter code" / "Set a secret code" */
  title: string;
  subtitle?: string;
  /** 'unlock' = single entry; 'set' = enter then confirm. */
  mode: 'unlock' | 'set';
  onClose: () => void;
  /**
   * Called with the finished code. Return the outcome:
   * 'ok' closes the pad (duress callers ALSO return 'ok' — the pad must not
   * know), 'wrong' shakes and clears, 'locked' starts the countdown,
   * 'invalid' (set mode) shows the message.
   */
  onSubmit: (code: string) => Promise<CodePadOutcome>;
}

const KEYS: Array<Array<string>> = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['abc', '0', 'del'],
];

const MIN_LEN = 4;
const MAX_LEN = 8;

// Dense-editor solid palette (DESIGN.md).
const canvas = (isDark: boolean) => (isDark ? 'rgba(13,15,20,0.96)' : 'rgba(250,250,252,0.97)');
const keyBg = (isDark: boolean) => (isDark ? 'rgba(28,31,38,0.96)' : 'rgba(255,255,255,0.97)');
const hairline = (isDark: boolean) => (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)');
const inputBorder = (isDark: boolean) => (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)');

export const GuardCodePad = ({ visible, title, subtitle, mode, onClose, onSubmit }: GuardCodePadProps) => {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'enter' | 'confirm'>('enter');
  const [firstCode, setFirstCode] = useState('');
  const [textMode, setTextMode] = useState(false);
  const [textValue, setTextValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lockedMs, setLockedMs] = useState(0);

  const shakeX = useRef(new Animated.Value(0)).current;

  // Reset per open; unlock mode pre-checks the persisted brute-force lockout.
  useEffect(() => {
    if (!visible) return;
    setCode('');
    setStage('enter');
    setFirstCode('');
    setTextMode(false);
    setTextValue('');
    setNotice(null);
    setBusy(false);
    setLockedMs(0);
    if (mode === 'unlock') {
      void lockoutRemainingMs().then((ms) => {
        if (ms > 0) setLockedMs(ms);
      });
    }
  }, [visible, mode]);

  // Lockout countdown tick.
  useEffect(() => {
    if (lockedMs <= 0) return;
    const t = setInterval(() => setLockedMs((ms) => Math.max(0, ms - 1000)), 1000);
    return () => clearInterval(t);
  }, [lockedMs > 0]);

  const shake = useCallback(() => {
    shakeX.setValue(0);
    Animated.sequence(
      [12, -10, 8, -6, 3, 0].map((v) =>
        Animated.timing(shakeX, {
          toValue: v,
          duration: 55,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ),
    ).start();
  }, [shakeX]);

  const submit = useCallback(
    async (value: string) => {
      if (busy) return;
      const trimmed = value.trim();
      if (trimmed.length < MIN_LEN) {
        setNotice(`Use at least ${MIN_LEN} characters.`);
        errorHaptic();
        shake();
        return;
      }

      if (mode === 'set' && stage === 'enter') {
        lightHaptic();
        setFirstCode(trimmed);
        setStage('confirm');
        setCode('');
        setTextValue('');
        setNotice(null);
        return;
      }
      if (mode === 'set' && stage === 'confirm' && trimmed !== firstCode) {
        errorHaptic();
        shake();
        setStage('enter');
        setFirstCode('');
        setCode('');
        setTextValue('');
        setNotice("Codes didn't match — start again.");
        return;
      }

      setBusy(true);
      const outcome = await onSubmit(trimmed);
      setBusy(false);
      switch (outcome.status) {
        case 'ok':
          successHaptic();
          onClose();
          return;
        case 'wrong':
          errorHaptic();
          shake();
          setCode('');
          setTextValue('');
          setNotice(null);
          return;
        case 'locked':
          errorHaptic();
          setCode('');
          setTextValue('');
          setLockedMs(outcome.lockedForMs);
          return;
        case 'invalid':
          errorHaptic();
          shake();
          setStage('enter');
          setFirstCode('');
          setCode('');
          setTextValue('');
          setNotice(outcome.message);
          return;
      }
    },
    [busy, mode, stage, firstCode, onSubmit, onClose, shake],
  );

  const pressKey = (key: string) => {
    if (busy || lockedMs > 0) return;
    if (key === 'del') {
      lightHaptic();
      setCode((c) => c.slice(0, -1));
      return;
    }
    if (key === 'abc') {
      lightHaptic();
      setTextMode(true);
      setCode('');
      return;
    }
    if (code.length >= MAX_LEN) return;
    lightHaptic();
    const next = code + key;
    setCode(next);
  };

  const locked = lockedMs > 0;
  const stageTitle = mode === 'set' && stage === 'confirm' ? 'Re-enter to confirm' : title;
  const dots = Math.max(code.length, MIN_LEN);

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={[styles.overlay, { backgroundColor: canvas(isDark) }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          hitSlop={12}
          style={[styles.closeBtn, { top: insets.top + 10 }]}
        >
          <Ionicons name="close" size={26} color={theme.colors.onSurfaceVariant} />
        </Pressable>

        <Animated.View style={[styles.body, { transform: [{ translateX: shakeX }] }]}>
          <Text variant="titleLarge" style={[styles.title, { color: theme.colors.onSurface }]}>
            {stageTitle}
          </Text>
          {(notice || subtitle) && (
            <Text
              variant="bodySmall"
              style={[styles.subtitle, { color: notice ? theme.colors.error : theme.colors.onSurfaceVariant }]}
            >
              {locked ? '' : notice ?? subtitle}
            </Text>
          )}
          {locked && (
            <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.error }]}>
              Too many attempts — try again in {Math.ceil(lockedMs / 1000)}s.
            </Text>
          )}

          {textMode ? (
            <View style={styles.textBlock}>
              <TextInput
                value={textValue}
                onChangeText={setTextValue}
                secureTextEntry
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                editable={!locked && !busy}
                placeholder="Enter code"
                placeholderTextColor={theme.colors.onSurfaceVariant}
                onSubmitEditing={() => void submit(textValue)}
                returnKeyType="done"
                accessibilityLabel="Code"
                style={[
                  styles.textInput,
                  { borderColor: inputBorder(isDark), color: theme.colors.onSurface, backgroundColor: keyBg(isDark) },
                ]}
              />
              <Pressable
                onPress={() => void submit(textValue)}
                disabled={locked || busy || textValue.trim().length < MIN_LEN}
                accessibilityRole="button"
                accessibilityLabel="Submit code"
                style={[
                  styles.textSubmit,
                  {
                    backgroundColor: theme.colors.primary,
                    opacity: locked || busy || textValue.trim().length < MIN_LEN ? 0.4 : 1,
                  },
                ]}
              >
                <Text variant="labelLarge" style={{ color: theme.colors.onPrimary, fontWeight: '700' }}>
                  {mode === 'set' && stage === 'enter' ? 'Next' : 'Done'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  lightHaptic();
                  setTextMode(false);
                  setTextValue('');
                }}
                accessibilityRole="button"
                style={styles.switchBtn}
              >
                <Text variant="labelMedium" style={{ color: theme.colors.primary }}>
                  Use number pad
                </Text>
              </Pressable>
            </View>
          ) : (
            <>
              <View style={styles.dotsRow} accessibilityLabel={`${code.length} digits entered`}>
                {Array.from({ length: dots }).map((_, i) => (
                  <View
                    key={i}
                    style={[
                      styles.dot,
                      {
                        borderColor: inputBorder(isDark),
                        backgroundColor: i < code.length ? theme.colors.primary : 'transparent',
                      },
                    ]}
                  />
                ))}
              </View>

              <View style={styles.grid}>
                {KEYS.map((row, r) => (
                  <View key={r} style={styles.gridRow}>
                    {row.map((key) => {
                      const isDel = key === 'del';
                      const isAbc = key === 'abc';
                      return (
                        <Pressable
                          key={key}
                          onPress={() => pressKey(key)}
                          disabled={locked || busy}
                          accessibilityRole="button"
                          accessibilityLabel={isDel ? 'Delete' : isAbc ? 'Use letters' : key}
                          style={({ pressed }) => [
                            styles.key,
                            {
                              backgroundColor: isDel || isAbc ? 'transparent' : keyBg(isDark),
                              borderColor: isDel || isAbc ? 'transparent' : hairline(isDark),
                              opacity: locked ? 0.35 : pressed ? 0.6 : 1,
                            },
                          ]}
                        >
                          {isDel ? (
                            <Ionicons name="backspace-outline" size={24} color={theme.colors.onSurface} />
                          ) : isAbc ? (
                            <Text variant="labelMedium" style={{ color: theme.colors.primary }}>
                              ABC
                            </Text>
                          ) : (
                            <Text variant="headlineSmall" style={{ color: theme.colors.onSurface, fontWeight: '500' }}>
                              {key}
                            </Text>
                          )}
                        </Pressable>
                      );
                    })}
                  </View>
                ))}
              </View>

              <Pressable
                onPress={() => void submit(code)}
                disabled={locked || busy || code.length < MIN_LEN}
                accessibilityRole="button"
                accessibilityLabel={mode === 'set' && stage === 'enter' ? 'Next' : 'Unlock'}
                style={[
                  styles.submit,
                  {
                    backgroundColor: theme.colors.primary,
                    opacity: locked || busy || code.length < MIN_LEN ? 0.4 : 1,
                  },
                ]}
              >
                <Text variant="labelLarge" style={{ color: theme.colors.onPrimary, fontWeight: '700' }}>
                  {mode === 'set' && stage === 'enter' ? 'Next' : mode === 'set' ? 'Save' : 'Unlock'}
                </Text>
              </Pressable>
            </>
          )}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    position: 'absolute',
    right: 20,
    zIndex: 2,
    padding: 6,
  },
  body: {
    alignItems: 'center',
    paddingHorizontal: 32,
    width: '100%',
    maxWidth: 360,
  },
  title: {
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    textAlign: 'center',
    marginTop: 6,
    minHeight: 16,
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 26,
    marginBottom: 30,
    minHeight: 14,
  },
  dot: {
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 1.5,
  },
  grid: {
    gap: 12,
  },
  gridRow: {
    flexDirection: 'row',
    gap: 20,
    justifyContent: 'center',
  },
  key: {
    width: 74,
    height: 74,
    borderRadius: 37,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  submit: {
    marginTop: 26,
    paddingVertical: 12,
    paddingHorizontal: 44,
    borderRadius: 999,
  },
  textBlock: {
    width: '100%',
    alignItems: 'center',
    marginTop: 26,
  },
  textInput: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 17,
  },
  textSubmit: {
    marginTop: 18,
    paddingVertical: 12,
    paddingHorizontal: 44,
    borderRadius: 999,
  },
  switchBtn: {
    marginTop: 16,
    padding: 6,
  },
});
