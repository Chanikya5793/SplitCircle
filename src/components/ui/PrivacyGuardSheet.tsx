// Hidden privacy-guard settings — reachable ONLY by tapping the Settings
// version footer 7 times and entering the secret code (first visit sets it).
// Configures what a shake hides (per-surface or everything), how (scramble
// vs vanish), how hard the shake must be, plus manual activation and code
// rotation. Deliberately reuses the plain sheet idiom so nothing about the
// screen looks special if glimpsed.

import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { useTheme } from '@/context/ThemeContext';
import {
  hashCode,
  updateGuard,
  type GuardTargets,
} from '@/services/privacyGuardService';
import { lightHaptic, selectionHaptic, successHaptic } from '@/utils/haptics';
import React from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SegmentedButtons, Switch, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const TARGET_ROWS: Array<{ key: keyof GuardTargets; label: string; hint: string }> = [
  { key: 'everything', label: 'Everything', hint: 'Locks the whole app behind a blank screen' },
  { key: 'expenses', label: 'Expenses & balances', hint: 'All amounts scramble to ••••' },
  { key: 'charts', label: 'Charts', hint: 'Spending charts hide' },
  { key: 'calls', label: 'Calls', hint: 'Call history hides' },
  { key: 'friends', label: 'Friends', hint: 'Friends list hides' },
  { key: 'chats', label: 'Chats', hint: 'Conversation list hides' },
];

interface PrivacyGuardSheetProps {
  visible: boolean;
  onClose: () => void;
}

export const PrivacyGuardSheet = ({ visible, onClose }: PrivacyGuardSheetProps) => {
  const { theme, isDark } = useTheme();
  const { settings } = usePrivacyGuard();
  const insets = useSafeAreaInsets();

  const surface = isDark ? '#1c1c20' : '#ffffff';
  const divider = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';

  const changeCode = () => {
    Alert.prompt(
      'New secret code',
      'Used to open these settings and to unlock after a shake.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: (code?: string) => {
            const trimmed = code?.trim() ?? '';
            if (trimmed.length < 4) {
              Alert.alert('Too short', 'Use at least 4 characters.');
              return;
            }
            void hashCode(trimmed).then((digest) => {
              void updateGuard({ codeHash: digest });
              successHaptic();
            });
          },
        },
      ],
      'secure-text',
    );
  };

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { backgroundColor: surface, paddingBottom: insets.bottom + 10 }]}>
        <View style={[styles.grabber, { backgroundColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)' }]} />
        <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
          Shake to hide
        </Text>
        <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
          Shake the phone and the chosen parts of {`the app`} disappear until you enter the code.
        </Text>

        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                Armed
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Master switch — nothing happens while off
              </Text>
            </View>
            <Switch
              value={settings.enabled}
              onValueChange={(v) => {
                selectionHaptic();
                void updateGuard({ enabled: v, active: false });
              }}
            />
          </View>

          <View style={[styles.divider, { backgroundColor: divider }]} />

          <Text variant="labelMedium" style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
            WHEN SHAKEN
          </Text>
          <SegmentedButtons
            value={settings.action}
            onValueChange={(v) => {
              selectionHaptic();
              void updateGuard({ action: v as typeof settings.action });
            }}
            buttons={[
              { value: 'scramble', label: 'Scramble', icon: 'blur' },
              { value: 'vanish', label: 'Vanish', icon: 'eye-off-outline' },
            ]}
          />

          <Text variant="labelMedium" style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
            WHAT HIDES
          </Text>
          {TARGET_ROWS.map(({ key, label, hint }) => (
            <View key={key} style={styles.row}>
              <View style={styles.rowText}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                  {label}
                </Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {hint}
                </Text>
              </View>
              <Switch
                value={settings.targets[key]}
                onValueChange={(v) => {
                  selectionHaptic();
                  void updateGuard({ targets: { ...settings.targets, [key]: v } });
                }}
              />
            </View>
          ))}

          <Text variant="labelMedium" style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
            SHAKE SENSITIVITY
          </Text>
          <SegmentedButtons
            value={settings.sensitivity}
            onValueChange={(v) => {
              selectionHaptic();
              void updateGuard({ sensitivity: v as typeof settings.sensitivity });
            }}
            buttons={[
              { value: 'gentle', label: 'Gentle' },
              { value: 'normal', label: 'Normal' },
              { value: 'vigorous', label: 'Firm' },
            ]}
          />

          <View style={[styles.divider, { backgroundColor: divider, marginTop: 16 }]} />

          <Pressable
            onPress={() => {
              lightHaptic();
              void updateGuard({ active: true });
              onClose();
            }}
            accessibilityRole="button"
            style={styles.actionRow}
          >
            <Text style={{ color: theme.colors.primary, fontWeight: '600' }}>Activate now</Text>
          </Pressable>
          <Pressable onPress={changeCode} accessibilityRole="button" style={styles.actionRow}>
            <Text style={{ color: theme.colors.primary, fontWeight: '600' }}>Change secret code</Text>
          </Pressable>

          <Text variant="labelSmall" style={[styles.footnote, { color: theme.colors.onSurfaceVariant }]}>
            To unlock: tap the version line in Settings 7 times and enter the code. When everything is
            locked, triple-tap the app name on the blank screen instead. Settings live only on this device.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',  // modal scrim — intentionally scheme-independent
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    maxHeight: '88%',
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
  },
  subtitle: {
    textAlign: 'center',
    marginTop: 2,
    marginBottom: 6,
    paddingHorizontal: 24,
  },
  body: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 9,
  },
  rowText: {
    flex: 1,
    gap: 1,
  },
  groupLabel: {
    marginTop: 16,
    marginBottom: 8,
    letterSpacing: 0.6,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 6,
  },
  actionRow: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  footnote: {
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 16,
  },
});
