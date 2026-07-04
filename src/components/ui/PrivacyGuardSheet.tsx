// Hidden privacy-guard settings — reachable ONLY by tapping the Settings
// version footer 7 times and entering the secret code (first visit sets it).
//
// Deep customization: what a shake hides (per-surface or everything), HOW it
// hides (scramble style for text/amounts, or vanish), which names/photos/
// previews to disguise, and precise scopes — All / Only-selected / All-except
// — for expense groups and conversations independently. Plus sensitivity,
// lock-on-exit, manual activation, and code rotation. Reuses the plain sheet
// idiom so nothing looks special if glimpsed.

import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { formatCurrency } from '@/utils/currency';
import {
  decoyAmount,
  hashCode,
  maskTextValue,
  updateGuard,
  type GuardScope,
  type GuardTargets,
} from '@/services/privacyGuardService';
import { authenticate, biometricLabel, isBiometricAvailable } from '@/services/biometrics';
import { lightHaptic, selectionHaptic, successHaptic } from '@/utils/haptics';
import React, { useMemo } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { SegmentedButtons, Switch, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const TARGET_ROWS: Array<{ key: keyof GuardTargets; label: string; hint: string }> = [
  { key: 'everything', label: 'Everything', hint: 'Locks the whole app behind a blank screen' },
  { key: 'expenses', label: 'Expenses & balances', hint: 'Amounts in expense groups' },
  { key: 'charts', label: 'Charts', hint: 'Spending charts' },
  { key: 'calls', label: 'Calls', hint: 'Call history' },
  { key: 'friends', label: 'Friends', hint: 'Friends list' },
  { key: 'chats', label: 'Chats', hint: 'Conversation list' },
];

interface ScopeEditorProps {
  scope: GuardScope;
  items: Array<{ id: string; label: string }>;
  onChange: (scope: GuardScope) => void;
  onSurface: string;
  onSurfaceVariant: string;
  primary: string;
  chipBg: string;
}

/** All / Only-selected / All-except editor with a chip multi-select. */
const ScopeEditor = ({ scope, items, onChange, onSurface, onSurfaceVariant, primary, chipBg }: ScopeEditorProps) => {
  const toggleId = (id: string) => {
    selectionHaptic();
    const has = scope.ids.includes(id);
    onChange({ ...scope, ids: has ? scope.ids.filter((x) => x !== id) : [...scope.ids, id] });
  };

  return (
    <View>
      <SegmentedButtons
        value={scope.mode}
        onValueChange={(v) => {
          selectionHaptic();
          onChange({ ...scope, mode: v as GuardScope['mode'] });
        }}
        buttons={[
          { value: 'all', label: 'All' },
          { value: 'only', label: 'Only these' },
          { value: 'except', label: 'All except' },
        ]}
      />
      {scope.mode !== 'all' && (
        <View style={styles.chips}>
          {items.length === 0 ? (
            <Text variant="labelSmall" style={{ color: onSurfaceVariant }}>
              Nothing to choose yet.
            </Text>
          ) : (
            items.map(({ id, label }) => {
              const selected = scope.ids.includes(id);
              return (
                <TouchableOpacity
                  key={id}
                  onPress={() => toggleId(id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  style={[
                    styles.chip,
                    { backgroundColor: selected ? primary : chipBg },
                  ]}
                >
                  <Text
                    variant="labelMedium"
                    numberOfLines={1}
                    style={{ color: selected ? '#fff' : onSurface, maxWidth: 150 }}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })
          )}
        </View>
      )}
    </View>
  );
};

interface PrivacyGuardSheetProps {
  visible: boolean;
  onClose: () => void;
}

export const PrivacyGuardSheet = ({ visible, onClose }: PrivacyGuardSheetProps) => {
  const { theme, isDark } = useTheme();
  const { settings } = usePrivacyGuard();
  const { groups } = useGroups();
  const { threads } = useChat();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [bioAvailable, setBioAvailable] = React.useState(false);
  const [bioLabel, setBioLabel] = React.useState('Face ID');
  React.useEffect(() => {
    void isBiometricAvailable().then(setBioAvailable);
    void biometricLabel().then(setBioLabel);
  }, []);

  const surface = isDark ? '#1c1c20' : '#ffffff';
  const divider = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
  const chipBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';

  const groupItems = useMemo(
    () => groups.map((g) => ({ id: g.groupId, label: g.name })),
    [groups],
  );
  const chatItems = useMemo(
    () =>
      threads.map((t) => {
        let label = 'Chat';
        if (t.type === 'group') {
          label = groups.find((g) => g.groupId === t.groupId)?.name ?? 'Group';
        } else {
          const other = t.participants.find((p) => p.userId !== user?.userId) ?? t.participants[0];
          label = other?.displayName ?? 'Direct';
        }
        return { id: t.chatId, label };
      }),
    [threads, groups, user?.userId],
  );

  // Live preview of the current scramble style.
  const preview = useMemo(() => {
    if (settings.action === 'vanish') return null;
    const text = maskTextValue('Weekend Trip', settings.textStyle);
    const amount =
      settings.amountStyle === 'zeros'
        ? formatCurrency(0, 'USD')
        : settings.amountStyle === 'decoy'
          ? formatCurrency(decoyAmount(184.5), 'USD')
          : '••••';
    return `${text} · ${amount}`;
  }, [settings.action, settings.textStyle, settings.amountStyle]);

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

  const changeDuressCode = () => {
    Alert.prompt(
      settings.duressCodeHash ? 'Change duress code' : 'Set a duress code',
      'A second code that fakes an unlock but keeps everything hidden — for when someone makes you open it. Must differ from your real code.',
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
              if (digest === settings.codeHash) {
                Alert.alert('Pick a different code', 'The duress code must not match your real code.');
                return;
              }
              void updateGuard({ duressCodeHash: digest });
              successHaptic();
            });
          },
        },
      ],
      'secure-text',
    );
  };

  const clearDuressCode = () => {
    Alert.alert('Remove duress code?', 'The fake-unlock code will stop working.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void updateGuard({ duressCodeHash: null }) },
    ]);
  };

  const sectionLabel = (text: string) => (
    <Text variant="labelMedium" style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
      {text}
    </Text>
  );

  const toggleRow = (
    label: string,
    hint: string,
    value: boolean,
    onValueChange: (v: boolean) => void,
  ) => (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
          {label}
        </Text>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {hint}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={(v) => {
          selectionHaptic();
          onValueChange(v);
        }}
      />
    </View>
  );

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { backgroundColor: surface, paddingBottom: insets.bottom + 10 }]}>
        <View style={[styles.grabber, { backgroundColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)' }]} />
        <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
          Shake to hide
        </Text>
        <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
          Shake the phone and the chosen parts of the app disguise or disappear until you enter the code.
        </Text>

        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          {toggleRow(
            'Armed',
            'Master switch — nothing happens while off',
            settings.enabled,
            (v) => void updateGuard({ enabled: v, active: false }),
          )}

          <View style={[styles.divider, { backgroundColor: divider }]} />

          {sectionLabel('WHEN SHAKEN')}
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

          {settings.action === 'scramble' && (
            <>
              {sectionLabel('TEXT STYLE')}
              <SegmentedButtons
                value={settings.textStyle}
                onValueChange={(v) => {
                  selectionHaptic();
                  void updateGuard({ textStyle: v as typeof settings.textStyle });
                }}
                buttons={[
                  { value: 'dots', label: '••••' },
                  { value: 'blocks', label: '████' },
                  { value: 'garble', label: 'Garble' },
                ]}
              />
              {sectionLabel('AMOUNT STYLE')}
              <SegmentedButtons
                value={settings.amountStyle}
                onValueChange={(v) => {
                  selectionHaptic();
                  void updateGuard({ amountStyle: v as typeof settings.amountStyle });
                }}
                buttons={[
                  { value: 'dots', label: '••••' },
                  { value: 'zeros', label: 'Zeros' },
                  { value: 'decoy', label: 'Decoy' },
                ]}
              />
              {preview && (
                <View style={[styles.previewBox, { backgroundColor: chipBg }]}>
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Preview
                  </Text>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                    {preview}
                  </Text>
                </View>
              )}

              {sectionLabel('ALSO DISGUISE')}
              {toggleRow('Names', 'Group names, chat titles & people', settings.hideNames, (v) =>
                void updateGuard({ hideNames: v }),
              )}
              {toggleRow('Photos', 'Replace avatars with silhouettes', settings.hidePhotos, (v) =>
                void updateGuard({ hidePhotos: v }),
              )}
              {toggleRow('Message previews', 'Hide last-message text in the chat list', settings.hidePreviews, (v) =>
                void updateGuard({ hidePreviews: v }),
              )}
            </>
          )}

          {sectionLabel('ALSO HIDE')}
          {toggleRow('Wallpapers & backgrounds', 'Revert custom photos to the default background', settings.hideWallpaper, (v) =>
            void updateGuard({ hideWallpaper: v }),
          )}
          {toggleRow('My profile & email', 'Hide your own photo and email in Settings', settings.hideProfile, (v) =>
            void updateGuard({ hideProfile: v }),
          )}

          {sectionLabel('WHAT HIDES')}
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

          {(settings.targets.expenses || settings.targets.charts) && !settings.targets.everything && (
            <>
              {sectionLabel('WHICH EXPENSE GROUPS')}
              <ScopeEditor
                scope={settings.groupScope}
                items={groupItems}
                onChange={(s) => void updateGuard({ groupScope: s })}
                onSurface={theme.colors.onSurface}
                onSurfaceVariant={theme.colors.onSurfaceVariant}
                primary={theme.colors.primary}
                chipBg={chipBg}
              />
            </>
          )}

          {settings.targets.chats && !settings.targets.everything && (
            <>
              {sectionLabel('WHICH CHATS')}
              <ScopeEditor
                scope={settings.chatScope}
                items={chatItems}
                onChange={(s) => void updateGuard({ chatScope: s })}
                onSurface={theme.colors.onSurface}
                onSurfaceVariant={theme.colors.onSurfaceVariant}
                primary={theme.colors.primary}
                chipBg={chipBg}
              />
            </>
          )}

          {sectionLabel('SHAKE SENSITIVITY')}
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

          <View style={[styles.divider, { backgroundColor: divider, marginTop: 14 }]} />
          {toggleRow(
            'Lock when I leave the app',
            'Trip automatically when the app goes to the background',
            settings.rearmOnBackground,
            (v) => void updateGuard({ rearmOnBackground: v }),
          )}
          {toggleRow(
            `Unlock with ${bioLabel}`,
            bioAvailable ? 'Use biometrics instead of the code to reveal & open' : `Set up ${bioLabel} in iOS Settings first`,
            settings.biometricUnlock,
            (v) => {
              if (!v) { void updateGuard({ biometricUnlock: false }); return; }
              void (async () => {
                if (!(await isBiometricAvailable())) return;
                const ok = await authenticate(`Enable ${bioLabel} unlock`);
                if (ok) void updateGuard({ biometricUnlock: true });
              })();
            },
          )}

          {sectionLabel('SCREEN CAPTURE')}
          {toggleRow(
            'Hide on screenshot',
            'Trip automatically when a screenshot is taken',
            settings.hideOnScreenshot,
            (v) => void updateGuard({ hideOnScreenshot: v }),
          )}
          {toggleRow(
            'Blur in screen recordings',
            'Blank the app in recordings & the app switcher while hidden',
            settings.blockScreenRecording,
            (v) => void updateGuard({ blockScreenRecording: v }),
          )}

          {sectionLabel('PANIC TAP')}
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
            Triple-tap this corner of the screen to hide — silent, no shaking.
          </Text>
          <SegmentedButtons
            value={settings.panicCorner}
            onValueChange={(v) => {
              selectionHaptic();
              void updateGuard({ panicCorner: v as typeof settings.panicCorner });
            }}
            buttons={[
              { value: 'off', label: 'Off' },
              { value: 'top-left', label: 'Top-left' },
              { value: 'top-right', label: 'Top-right' },
            ]}
          />

          {sectionLabel('DURESS CODE')}
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 4 }}>
            {settings.duressCodeHash
              ? 'Set. Entering it looks like a normal unlock but reveals nothing.'
              : 'Optional. A code you can give under pressure that fakes an unlock.'}
          </Text>
          <Pressable onPress={changeDuressCode} accessibilityRole="button" style={styles.actionRow}>
            <Text style={{ color: theme.colors.primary, fontWeight: '600' }}>
              {settings.duressCodeHash ? 'Change duress code' : 'Set duress code'}
            </Text>
          </Pressable>
          {settings.duressCodeHash && (
            <Pressable onPress={clearDuressCode} accessibilityRole="button" style={styles.actionRow}>
              <Text style={{ color: theme.colors.error, fontWeight: '600' }}>Remove duress code</Text>
            </Pressable>
          )}

          <View style={[styles.divider, { backgroundColor: divider, marginTop: 6 }]} />

          {/* Status + explicit hide/reveal. Revealing sets `active` false but
              leaves the shake detection armed — the app can be tripped again
              without re-enabling anything. */}
          <View style={styles.statusRow}>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
              Status
            </Text>
            <Text variant="bodyMedium" style={{ color: settings.active ? theme.colors.error : theme.colors.primary, fontWeight: '600' }}>
              {settings.active ? 'Hidden' : 'Visible'}
            </Text>
          </View>
          <Pressable
            onPress={() => {
              lightHaptic();
              void updateGuard({ active: !settings.active });
              if (!settings.active) onClose();
            }}
            accessibilityRole="button"
            style={styles.actionRow}
          >
            <Text style={{ color: theme.colors.primary, fontWeight: '600' }}>
              {settings.active ? 'Reveal now (stays armed)' : 'Hide now'}
            </Text>
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
    maxHeight: '90%',
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
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
  },
  previewBox: {
    marginTop: 12,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 2,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
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
