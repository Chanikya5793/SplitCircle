// Hidden privacy-guard settings — reachable ONLY by tapping the Settings
// version footer 7 times and entering the secret code (first visit sets it).
//
// Sheet DNA (DESIGN.md): Modal fade carries the scrim, the sheet is a
// GlassCard (REAL liquid glass on iOS 26) sliding up on a native-driver
// translateY — transform only, so the native material never drops out.
// ONE scrollable sheet with real hierarchy: hero status card up top, then
// grouped translucent cards (Disguise / Coverage / Triggers / Security)
// separated by section labels, and a docked summary + Done footer.
//
// Settings are STAGED in a local draft and flushed once on Done/close —
// per-tap context writes would re-render the whole app behind the modal and
// read as lag. Arming and Hide/Reveal are true ACTIONS and apply immediately.

import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { appAlert } from '@/utils/appAlert';
import { formatCurrency } from '@/utils/currency';
import { resolveDisplayName } from '@/utils/identity';
import {
  decoyAmount,
  getFailedAttempts,
  hashCode,
  maskTextValue,
  updateGuard,
  type GuardScope,
  type GuardTargets,
  type PrivacyGuardSettings,
} from '@/services/privacyGuardService';
import { authenticate, biometricLabel, isBiometricAvailable } from '@/services/biometrics';
import { lightHaptic, mediumHaptic, selectionHaptic, successHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { Switch, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassCard } from './GlassCard';
import { GuardCodePad, type CodePadOutcome } from './GuardCodePad';

// ---------------------------------------------------------------------------
// Translucent chrome ON the glass — tints only, the material shows through.

const cardTint = (isDark: boolean) => (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.50)');
const hairline = (isDark: boolean) => (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)');
const trackBg = (isDark: boolean) => (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)');
const segSelectedBg = (isDark: boolean) => (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.92)');

// Editable draft keys — flushed as one updateGuard() diff.
const DRAFT_KEYS = [
  'enabled', 'action', 'textStyle', 'amountStyle', 'hideNames', 'hidePhotos',
  'hidePreviews', 'hideWallpaper', 'hideProfile', 'targets', 'groupScope',
  'chatScope', 'sensitivity', 'rearmOnBackground', 'biometricUnlock',
  'hideOnScreenshot', 'blockScreenRecording', 'panicCorner', 'flipToHide',
  'revealTimeoutMs',
] as const;
type DraftKey = (typeof DRAFT_KEYS)[number];
type Draft = Pick<PrivacyGuardSettings, DraftKey>;

const draftFrom = (s: PrivacyGuardSettings): Draft => ({
  enabled: s.enabled,
  action: s.action,
  textStyle: s.textStyle,
  amountStyle: s.amountStyle,
  hideNames: s.hideNames,
  hidePhotos: s.hidePhotos,
  hidePreviews: s.hidePreviews,
  hideWallpaper: s.hideWallpaper,
  hideProfile: s.hideProfile,
  targets: { ...s.targets },
  groupScope: { mode: s.groupScope.mode, ids: [...s.groupScope.ids] },
  chatScope: { mode: s.chatScope.mode, ids: [...s.chatScope.ids] },
  sensitivity: s.sensitivity,
  rearmOnBackground: s.rearmOnBackground,
  biometricUnlock: s.biometricUnlock,
  hideOnScreenshot: s.hideOnScreenshot,
  blockScreenRecording: s.blockScreenRecording,
  panicCorner: s.panicCorner,
  flipToHide: s.flipToHide,
  revealTimeoutMs: s.revealTimeoutMs,
});

const TARGET_ROWS: Array<{ key: keyof GuardTargets; label: string; hint: string }> = [
  { key: 'expenses', label: 'Expenses & balances', hint: 'Amounts in expense groups' },
  { key: 'charts', label: 'Charts & stats', hint: 'Spending charts and insights' },
  { key: 'chats', label: 'Chats', hint: 'Conversations and previews' },
  { key: 'calls', label: 'Calls', hint: 'Call history' },
  { key: 'friends', label: 'Friends', hint: 'Friends list and balances' },
];

// ---------------------------------------------------------------------------
// Small translucent building blocks.

interface SegmentProps<T extends string> {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}

const Segment = <T extends string>({ options, value, onChange }: SegmentProps<T>) => {
  const { theme, isDark } = useTheme();
  return (
    <View style={[styles.segmentTrack, { backgroundColor: trackBg(isDark) }]}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => {
              if (selected) return;
              selectionHaptic();
              onChange(o.value);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[
              styles.segmentItem,
              selected && {
                backgroundColor: segSelectedBg(isDark),
                borderColor: hairline(isDark),
                borderWidth: StyleSheet.hairlineWidth,
              },
            ]}
          >
            <Text
              variant="labelMedium"
              numberOfLines={1}
              style={{
                color: selected ? theme.colors.onSurface : theme.colors.onSurfaceVariant,
                fontWeight: selected ? '600' : '400',
              }}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
};

/**
 * Grouped rows in a translucent inset card (the glass shows through).
 *
 * These sit INSIDE the sheet's own `role="floating"` GlassCard, so in flat
 * mode they must go borderless: the sheet already supplies the opaque fill
 * that holds this content off the canvas, and a second tinted box inside it
 * reads as a card-in-a-card — exactly the nesting flat mode exists to remove.
 * Rows keep their own dividers, which is what carries the grouping.
 */
const Card = ({ children, style }: { children: React.ReactNode; style?: object }) => {
  const { isDark, theme } = useTheme();
  if (theme?.surfaceStyle === 'flat') {
    return <View style={[styles.cardFlat, style]}>{children}</View>;
  }
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: cardTint(isDark), borderColor: hairline(isDark) },
        style,
      ]}
    >
      {children}
    </View>
  );
};

const Row = ({
  label,
  hint,
  right,
  onPress,
  last,
}: {
  label: string;
  hint?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  last?: boolean;
}) => {
  const { theme, isDark } = useTheme();
  // Flat: the enclosing Card has no box any more, so the row's own 14pt inset
  // would sit content at 34pt while the section headings around it sit at the
  // body's 20pt gutter. Drop it and let one gutter govern the whole sheet.
  const flat = theme?.surfaceStyle === 'flat';
  const inner = (
    <View
      style={[
        styles.row,
        flat && styles.rowFlat,
        !last && { borderBottomColor: hairline(isDark), borderBottomWidth: StyleSheet.hairlineWidth },
      ]}
    >
      <View style={styles.rowText}>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
          {label}
        </Text>
        {hint ? (
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {hint}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
  if (!onPress) return inner;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.65} accessibilityRole="button">
      {inner}
    </TouchableOpacity>
  );
};

const ToggleRow = ({
  label,
  hint,
  value,
  onValueChange,
  last,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  last?: boolean;
}) => (
  <Row
    label={label}
    hint={hint}
    last={last}
    right={
      <Switch
        value={value}
        onValueChange={(v) => {
          selectionHaptic();
          onValueChange(v);
        }}
      />
    }
  />
);

const Label = ({ text }: { text: string }) => {
  const { theme } = useTheme();
  return (
    <Text variant="labelMedium" style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>
      {text}
    </Text>
  );
};

// ---------------------------------------------------------------------------
// Scope editor — proper rows with initial chips, counts, select all / clear.

interface ScopeEditorProps {
  scope: GuardScope;
  items: Array<{ id: string; label: string }>;
  onChange: (scope: GuardScope) => void;
}

const ScopeEditor = ({ scope, items, onChange }: ScopeEditorProps) => {
  const { theme, isDark } = useTheme();

  const toggleId = (id: string) => {
    selectionHaptic();
    const has = scope.ids.includes(id);
    onChange({ ...scope, ids: has ? scope.ids.filter((x) => x !== id) : [...scope.ids, id] });
  };

  const selectedCount = items.filter((i) => scope.ids.includes(i.id)).length;
  const summary =
    scope.mode === 'all'
      ? 'Everything is covered'
      : scope.mode === 'only'
        ? `${selectedCount} of ${items.length} selected`
        : `All except ${selectedCount}`;

  return (
    <View>
      <Segment
        options={[
          { value: 'all', label: 'All' },
          { value: 'only', label: 'Only these' },
          { value: 'except', label: 'All except' },
        ]}
        value={scope.mode}
        onChange={(v) => onChange({ ...scope, mode: v })}
      />
      {scope.mode !== 'all' && (
        <Card style={{ marginTop: 10 }}>
          <View
            style={[
              styles.scopeHeader,
              { borderBottomColor: hairline(isDark), borderBottomWidth: StyleSheet.hairlineWidth },
            ]}
          >
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1 }}>
              {summary}
            </Text>
            <TouchableOpacity
              onPress={() => {
                lightHaptic();
                onChange({
                  ...scope,
                  ids: scope.ids.length === items.length ? [] : items.map((i) => i.id),
                });
              }}
              accessibilityRole="button"
            >
              <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '600' }}>
                {scope.ids.length === items.length ? 'Clear' : 'Select all'}
              </Text>
            </TouchableOpacity>
          </View>
          {items.length === 0 ? (
            <View style={styles.scopeEmpty}>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Nothing to choose yet.
              </Text>
            </View>
          ) : (
            items.map(({ id, label }, idx) => {
              const selected = scope.ids.includes(id);
              const initials = label.trim().slice(0, 2).toUpperCase();
              return (
                <TouchableOpacity
                  key={id}
                  onPress={() => toggleId(id)}
                  activeOpacity={0.65}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <View
                    style={[
                      styles.scopeRow,
                      idx < items.length - 1 && {
                        borderBottomColor: hairline(isDark),
                        borderBottomWidth: StyleSheet.hairlineWidth,
                      },
                    ]}
                  >
                    <View style={[styles.initialChip, { backgroundColor: trackBg(isDark) }]}>
                      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, fontWeight: '700' }}>
                        {initials}
                      </Text>
                    </View>
                    <Text
                      variant="bodyMedium"
                      numberOfLines={1}
                      style={{ color: theme.colors.onSurface, flex: 1 }}
                    >
                      {label}
                    </Text>
                    <Ionicons
                      name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                      size={22}
                      color={selected ? theme.colors.primary : theme.colors.onSurfaceVariant}
                    />
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </Card>
      )}
    </View>
  );
};

// ---------------------------------------------------------------------------
// Live preview — a mock chat row + expense row that restyle as options change.

const DisguisePreview = ({ draft }: { draft: Draft }) => {
  const { theme, isDark } = useTheme();

  if (draft.action === 'vanish') {
    return (
      <Card style={{ marginTop: 12 }}>
        <View style={styles.previewVanish}>
          <Ionicons name="eye-off-outline" size={18} color={theme.colors.onSurfaceVariant} />
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Hidden surfaces show nothing at all.
          </Text>
        </View>
      </Card>
    );
  }

  const style = draft.textStyle;
  const groupName = draft.hideNames ? maskTextValue('Goa Trip 2026', style, 'group') : 'Goa Trip 2026';
  const personName = draft.hideNames ? maskTextValue('Alex Kim', style, 'person') : 'Alex Kim';
  const preview = draft.hidePreviews
    ? maskTextValue('Sent the hotel payment', style, 'preview')
    : 'Sent the hotel payment';
  const amount =
    draft.amountStyle === 'zeros'
      ? formatCurrency(0, 'USD')
      : draft.amountStyle === 'decoy'
        ? formatCurrency(decoyAmount(184.5, 'preview'), 'USD')
        : '••••';
  const initials = draft.hidePhotos ? '?' : personName.trim().slice(0, 2).toUpperCase();

  return (
    <Card style={{ marginTop: 12 }}>
      <View
        style={[
          styles.previewChatRow,
          { borderBottomColor: hairline(isDark), borderBottomWidth: StyleSheet.hairlineWidth },
        ]}
      >
        <View style={[styles.previewAvatar, { backgroundColor: trackBg(isDark) }]}>
          {draft.hidePhotos ? (
            <Ionicons name="person" size={16} color={theme.colors.onSurfaceVariant} />
          ) : (
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, fontWeight: '700' }}>
              {initials}
            </Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="bodyMedium" numberOfLines={1} style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
            {personName}
          </Text>
          <Text variant="labelSmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
            {preview}
          </Text>
        </View>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          9:41
        </Text>
      </View>
      <View style={styles.previewExpenseRow}>
        <View style={{ flex: 1 }}>
          <Text variant="bodyMedium" numberOfLines={1} style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
            {groupName}
          </Text>
          <Text variant="labelSmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
            Paid by {personName}
          </Text>
        </View>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
          {amount}
        </Text>
      </View>
    </Card>
  );
};

// ---------------------------------------------------------------------------

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

  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [codePad, setCodePad] = useState<null | 'secret' | 'duress'>(null);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioLabel, setBioLabel] = useState('Face ID');
  const [failedAttempts, setFailedAttempts] = useState<{ count: number; lastAt: number }>({ count: 0, lastAt: 0 });

  useEffect(() => {
    void isBiometricAvailable().then(setBioAvailable);
    void biometricLabel().then(setBioLabel);
  }, []);

  // Tamper indicator — refreshed each open (opening required the real code,
  // so showing the count here never leaks to a coercer).
  useEffect(() => {
    if (visible) void getFailedAttempts().then(setFailedAttempts);
  }, [visible]);

  // Entrance: fade scrim (Modal) + native-driver slide-up. Transform only —
  // an opacity animation here would kill the native glass material.
  const slide = useRef(new Animated.Value(0)).current;
  const [sheetH, setSheetH] = useState(680);

  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setDraft(draftFrom(settings));
      slide.setValue(0);
      Animated.timing(slide, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
    wasVisible.current = visible;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  /** Diff the draft against persisted settings and commit once. */
  const flush = (extra?: Partial<PrivacyGuardSettings>) => {
    const diff: Partial<PrivacyGuardSettings> = { ...extra };
    for (const key of DRAFT_KEYS) {
      if (JSON.stringify(draft[key]) !== JSON.stringify(settings[key])) {
        (diff as Record<string, unknown>)[key] = draft[key];
      }
    }
    if (Object.keys(diff).length > 0) void updateGuard(diff);
  };

  const close = () => {
    flush();
    onClose();
  };

  // Arming + Hide/Reveal are immediate actions (they change app behavior now).
  const setArmed = (v: boolean) => {
    patch({ enabled: v });
    void updateGuard({ enabled: v, active: false, duressActive: false });
  };
  const toggleHidden = () => {
    mediumHaptic();
    const next = !settings.active;
    flush({ active: next, duressActive: false });
    if (next) onClose();
  };

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
          label = resolveDisplayName(other, 'Direct');
        }
        return { id: t.chatId, label };
      }),
    [threads, groups, user?.userId],
  );

  const activeTargets = TARGET_ROWS.filter((t) => draft.targets[t.key]);
  const footerSummary = !draft.enabled
    ? 'Off — shaking does nothing'
    : settings.active
      ? 'Hidden now — shake or reveal to show'
      : `Armed · ${draft.action === 'vanish' ? 'vanish' : 'disguise'} · ${
          draft.targets.everything
            ? 'everything'
            : `${activeTargets.length || 'no'} surface${activeTargets.length === 1 ? '' : 's'}`
        }`;

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [sheetH + 80, 0] });

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay} pointerEvents="box-none">
        <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Close" />
        <Animated.View
          onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}
          style={[styles.sheetWrap, { transform: [{ translateY }] }]}
        >
          <GlassCard role="floating" style={styles.sheet} contentStyle={styles.sheetContent} intensity={70}>
            <View style={[styles.grabber, { backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)' }]} />
            <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
              Shake to hide
            </Text>
            <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
              A firm shake disguises or hides the chosen parts of the app until you enter the code.
            </Text>

            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.body}
              showsVerticalScrollIndicator={false}
            >
              {/* Hero status card */}
              <Card>
                <View style={styles.heroRow}>
                  <View style={[styles.heroIcon, { backgroundColor: trackBg(isDark) }]}>
                    <Ionicons
                      name={settings.active ? 'eye-off' : 'shield-half-outline'}
                      size={22}
                      color={settings.active ? theme.colors.error : theme.colors.primary}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                      {draft.enabled ? 'Armed' : 'Off'}
                    </Text>
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      {draft.enabled
                        ? settings.active
                          ? 'Shields are up — content is hidden'
                          : 'A firm shake hides the chosen surfaces'
                        : 'Nothing happens while off'}
                    </Text>
                  </View>
                  <Switch value={draft.enabled} onValueChange={(v) => { selectionHaptic(); setArmed(v); }} />
                </View>
                <View style={[styles.heroActions, { borderTopColor: hairline(isDark) }]}>
                  <TouchableOpacity
                    onPress={toggleHidden}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    style={[styles.heroButton, { backgroundColor: settings.active ? trackBg(isDark) : theme.colors.primary }]}
                  >
                    <Ionicons
                      name={settings.active ? 'eye-outline' : 'eye-off-outline'}
                      size={16}
                      color={settings.active ? theme.colors.onSurface : theme.colors.onPrimary}
                    />
                    <Text
                      variant="labelLarge"
                      style={{
                        color: settings.active ? theme.colors.onSurface : theme.colors.onPrimary,
                        fontWeight: '700',
                      }}
                    >
                      {settings.active ? 'Reveal (stays armed)' : 'Hide now'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </Card>

              {/* Disguise */}
              <Label text="WHEN SHAKEN" />
              <Segment
                options={[
                  { value: 'scramble', label: 'Disguise' },
                  { value: 'vanish', label: 'Vanish' },
                ]}
                value={draft.action}
                onChange={(v) => patch({ action: v })}
              />
              {draft.action === 'scramble' ? (
                <>
                  <Label text="TEXT" />
                  <Segment
                    options={[
                      { value: 'garble', label: 'Fake names' },
                      { value: 'dots', label: '••••' },
                      { value: 'blocks', label: '████' },
                    ]}
                    value={draft.textStyle}
                    onChange={(v) => patch({ textStyle: v })}
                  />
                  <Label text="AMOUNTS" />
                  <Segment
                    options={[
                      { value: 'decoy', label: 'Decoy ledger' },
                      { value: 'zeros', label: 'Zeros' },
                      { value: 'dots', label: '••••' },
                    ]}
                    value={draft.amountStyle}
                    onChange={(v) => patch({ amountStyle: v })}
                  />
                  <Text variant="labelSmall" style={[styles.hintLine, { color: theme.colors.onSurfaceVariant }]}>
                    Fake names and the decoy ledger are drawn from real words and scale every amount
                    consistently — balances still add up, so nothing looks redacted.
                  </Text>
                  <DisguisePreview draft={draft} />
                  <TouchableOpacity
                    onPress={() => {
                      // Immediate action: rotating the salt re-randomizes every
                      // fake name and decoy amount (the preview updates live).
                      lightHaptic();
                      void updateGuard({ disguiseSalt: Math.random().toString(36).slice(2, 10) });
                    }}
                    accessibilityRole="button"
                    style={styles.shuffleBtn}
                  >
                    <Ionicons name="dice-outline" size={16} color={theme.colors.primary} />
                    <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '600' }}>
                      Shuffle disguise
                    </Text>
                  </TouchableOpacity>
                  <Text variant="labelSmall" style={[styles.hintCentered, { color: theme.colors.onSurfaceVariant }]}>
                    New fake names & amounts — for when someone has already seen these.
                  </Text>

                  <Label text="ALSO DISGUISE" />
                  <Card>
                    <ToggleRow
                      label="Names"
                      hint="Group names, chat titles & people"
                      value={draft.hideNames}
                      onValueChange={(v) => patch({ hideNames: v })}
                    />
                    <ToggleRow
                      label="Photos"
                      hint="Replace avatars with silhouettes"
                      value={draft.hidePhotos}
                      onValueChange={(v) => patch({ hidePhotos: v })}
                    />
                    <ToggleRow
                      label="Message previews"
                      hint="Swap last-message text in the chat list"
                      value={draft.hidePreviews}
                      onValueChange={(v) => patch({ hidePreviews: v })}
                      last
                    />
                  </Card>
                </>
              ) : (
                <DisguisePreview draft={draft} />
              )}

              <Label text="ALSO HIDE" />
              <Card>
                <ToggleRow
                  label="Wallpapers & backgrounds"
                  hint="Revert custom photos to the default background"
                  value={draft.hideWallpaper}
                  onValueChange={(v) => patch({ hideWallpaper: v })}
                />
                <ToggleRow
                  label="My profile & email"
                  hint="Hide your own photo and email in Settings"
                  value={draft.hideProfile}
                  onValueChange={(v) => patch({ hideProfile: v })}
                  last
                />
              </Card>

              {/* Coverage */}
              <Label text="WHAT HIDES" />
              <Card>
                <ToggleRow
                  label="Everything"
                  hint="Locks the whole app behind a blank screen"
                  value={draft.targets.everything}
                  onValueChange={(v) => patch({ targets: { ...draft.targets, everything: v } })}
                  last={draft.targets.everything}
                />
                {!draft.targets.everything &&
                  TARGET_ROWS.map(({ key, label, hint }, idx) => (
                    <ToggleRow
                      key={key}
                      label={label}
                      hint={hint}
                      value={draft.targets[key]}
                      onValueChange={(v) => patch({ targets: { ...draft.targets, [key]: v } })}
                      last={idx === TARGET_ROWS.length - 1}
                    />
                  ))}
              </Card>

              {!draft.targets.everything && (draft.targets.expenses || draft.targets.charts) && (
                <>
                  <Label text="WHICH EXPENSE GROUPS" />
                  <ScopeEditor
                    scope={draft.groupScope}
                    items={groupItems}
                    onChange={(s) => patch({ groupScope: s })}
                  />
                  {draft.groupScope.mode !== 'all' && (
                    <Text variant="labelSmall" style={[styles.hintLine, { color: theme.colors.onSurfaceVariant }]}>
                      Covered groups disappear from lists entirely while hidden — no masked rows.
                    </Text>
                  )}
                </>
              )}

              {!draft.targets.everything && draft.targets.chats && (
                <>
                  <Label text="WHICH CHATS" />
                  <ScopeEditor
                    scope={draft.chatScope}
                    items={chatItems}
                    onChange={(s) => patch({ chatScope: s })}
                  />
                  {draft.chatScope.mode !== 'all' && (
                    <Text variant="labelSmall" style={[styles.hintLine, { color: theme.colors.onSurfaceVariant }]}>
                      Covered chats disappear from the chat list, calls, and search while hidden.
                    </Text>
                  )}
                </>
              )}

              {/* Triggers */}
              <Label text="SHAKE SENSITIVITY" />
              <Segment
                options={[
                  { value: 'gentle', label: 'Gentle' },
                  { value: 'normal', label: 'Normal' },
                  { value: 'vigorous', label: 'Firm' },
                ]}
                value={draft.sensitivity}
                onChange={(v) => patch({ sensitivity: v })}
              />

              <Label text="AUTOMATIC" />
              <Card>
                <ToggleRow
                  label="Lock when I leave the app"
                  hint="Trip whenever the app goes to the background"
                  value={draft.rearmOnBackground}
                  onValueChange={(v) => patch({ rearmOnBackground: v })}
                />
                <ToggleRow
                  label="Hide on screenshot"
                  hint="Trip the moment a screenshot is taken"
                  value={draft.hideOnScreenshot}
                  onValueChange={(v) => patch({ hideOnScreenshot: v })}
                />
                <ToggleRow
                  label="Hide when placed face-down"
                  hint="Resting the phone screen-down for a moment trips silently"
                  value={draft.flipToHide}
                  onValueChange={(v) => patch({ flipToHide: v })}
                  last
                />
              </Card>

              <Label text="AUTO RE-HIDE" />
              <Segment
                options={[
                  { value: '0', label: 'Off' },
                  { value: '60000', label: '1 min' },
                  { value: '300000', label: '5 min' },
                  { value: '900000', label: '15 min' },
                ]}
                value={String(draft.revealTimeoutMs) as '0' | '60000' | '300000' | '900000'}
                onChange={(v) => patch({ revealTimeoutMs: Number(v) })}
              />
              <Text variant="labelSmall" style={[styles.hintLine, { color: theme.colors.onSurfaceVariant }]}>
                After you reveal, the shields raise themselves again once this much time passes.
              </Text>

              <Label text="PANIC TAP" />
              <Segment
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'top-left', label: 'Top-left' },
                  { value: 'top-right', label: 'Top-right' },
                ]}
                value={draft.panicCorner}
                onChange={(v) => patch({ panicCorner: v })}
              />
              <Text variant="labelSmall" style={[styles.hintLine, { color: theme.colors.onSurfaceVariant }]}>
                Triple-tap that corner of the screen to hide — silent, no shaking.
              </Text>

              {/* Security */}
              <Label text="SECURITY" />
              <Card>
                {failedAttempts.count > 0 && (
                  <Row
                    label={`${failedAttempts.count} failed unlock attempt${failedAttempts.count === 1 ? '' : 's'}`}
                    hint={`Around your last unlock · latest at ${new Date(failedAttempts.lastAt).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}`}
                    right={<Ionicons name="alert-circle-outline" size={18} color={theme.colors.error} />}
                  />
                )}
                <Row
                  label="Change secret code"
                  hint="Opens these settings and reveals after a shake"
                  onPress={() => {
                    lightHaptic();
                    setCodePad('secret');
                  }}
                  right={<Ionicons name="chevron-forward" size={18} color={theme.colors.onSurfaceVariant} />}
                />
                <Row
                  label={settings.duressCodeHash ? 'Change duress code' : 'Set duress code'}
                  hint={
                    settings.duressCodeHash
                      ? 'Set — entering it fakes an unlock into a decoy app'
                      : 'A second code for when someone makes you open it'
                  }
                  onPress={() => {
                    lightHaptic();
                    setCodePad('duress');
                  }}
                  right={<Ionicons name="chevron-forward" size={18} color={theme.colors.onSurfaceVariant} />}
                />
                {settings.duressCodeHash ? (
                  <Row
                    label="Remove duress code"
                    onPress={() => {
                      lightHaptic();
                      appAlert('Remove duress code?', 'The fake-unlock code will stop working.', [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Remove',
                          style: 'destructive',
                          onPress: () => void updateGuard({ duressCodeHash: null }),
                        },
                      ]);
                    }}
                    right={<Ionicons name="trash-outline" size={18} color={theme.colors.error} />}
                  />
                ) : null}
                <ToggleRow
                  label={`Unlock with ${bioLabel}`}
                  hint={bioAvailable ? 'Biometrics instead of the code to reveal & open' : `Set up ${bioLabel} in iOS Settings first`}
                  value={draft.biometricUnlock}
                  onValueChange={(v) => {
                    if (!v) {
                      patch({ biometricUnlock: false });
                      void updateGuard({ biometricUnlock: false });
                      return;
                    }
                    void (async () => {
                      if (!(await isBiometricAvailable())) return;
                      const ok = await authenticate(`Enable ${bioLabel} unlock`);
                      if (ok) {
                        patch({ biometricUnlock: true });
                        void updateGuard({ biometricUnlock: true });
                      }
                    })();
                  }}
                />
                <ToggleRow
                  label="Blur in screen recordings"
                  hint="Blank the app in recordings & the app switcher while hidden"
                  value={draft.blockScreenRecording}
                  onValueChange={(v) => patch({ blockScreenRecording: v })}
                  last
                />
              </Card>
              <Text variant="labelSmall" style={[styles.hintLine, { color: theme.colors.onSurfaceVariant }]}>
                The duress code looks exactly like a real unlock — but sensitive chats and groups are
                silently absent and every remaining figure is a convincing fake. Backgrounding the
                app re-locks it.
              </Text>

              <Text variant="labelSmall" style={[styles.footnote, { color: theme.colors.onSurfaceVariant }]}>
                To get back here: tap the version line in Settings 7 times, then enter your code.
                When everything is locked, triple-tap the app name on the blank screen instead.
                These settings live only on this device.
              </Text>
            </ScrollView>

            {/* Docked commit bar: live summary left, one always-working Done. */}
            <View
              style={[
                styles.footer,
                { borderTopColor: hairline(isDark), paddingBottom: insets.bottom + 8 },
              ]}
            >
              <Text
                variant="labelSmall"
                numberOfLines={2}
                style={[styles.footerSummary, { color: theme.colors.onSurfaceVariant }]}
              >
                {footerSummary}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  successHaptic();
                  close();
                }}
                accessibilityRole="button"
                accessibilityLabel="Done"
                style={[styles.doneBtn, { backgroundColor: theme.colors.primary }]}
              >
                <Text variant="labelLarge" style={{ color: theme.colors.onPrimary, fontWeight: '700' }}>
                  Done
                </Text>
              </TouchableOpacity>
            </View>
          </GlassCard>
        </Animated.View>
      </View>

      {/* Code entry for changing the secret / duress codes. */}
      <GuardCodePad
        visible={codePad !== null}
        mode="set"
        title={codePad === 'duress' ? (settings.duressCodeHash ? 'Change duress code' : 'Set duress code') : 'New secret code'}
        subtitle={
          codePad === 'duress'
            ? 'Must differ from your real code.'
            : 'Used to open these settings and to unlock after a shake.'
        }
        onClose={() => setCodePad(null)}
        onSubmit={async (code): Promise<CodePadOutcome> => {
          const digest = await hashCode(code);
          if (codePad === 'duress') {
            if (digest === settings.codeHash) {
              return { status: 'invalid', message: 'The duress code must not match your real code.' };
            }
            await updateGuard({ duressCodeHash: digest });
            return { status: 'ok' };
          }
          if (settings.duressCodeHash && digest === settings.duressCodeHash) {
            return { status: 'invalid', message: 'That already is your duress code — pick another.' };
          }
          await updateGuard({ codeHash: digest });
          return { status: 'ok' };
        }}
      />
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
    backgroundColor: 'rgba(0,0,0,0.45)', // full-screen scrim — fades with the Modal
  },
  sheetWrap: {
    // FIXED height, not maxHeight: the GlassCard inside uses flex:1, and
    // flex inside a height-constrained-but-unsized parent collapses to zero
    // (the CLAUDE.md Reanimated/new-arch gotcha bit this exact sheet).
    height: '88%',
  },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    flex: 1,
  },
  sheetContent: {
    paddingTop: 8,
    flex: 1,
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
    marginBottom: 4,
    paddingHorizontal: 24,
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  body: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 16,
  },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  // Flat: no fill, no border, no radius — the row dividers do the grouping.
  cardFlat: {
    overflow: 'hidden',
  },
  rowFlat: {
    paddingHorizontal: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  rowText: {
    flex: 1,
    gap: 1,
  },
  sectionLabel: {
    marginTop: 18,
    marginBottom: 8,
    letterSpacing: 0.6,
  },
  hintLine: {
    marginTop: 8,
    lineHeight: 16,
  },
  hintCentered: {
    marginTop: 2,
    lineHeight: 16,
    textAlign: 'center',
  },
  shuffleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    marginTop: 4,
  },
  segmentTrack: {
    flexDirection: 'row',
    borderRadius: 11,
    padding: 3,
    gap: 3,
  },
  segmentItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 8,
  },
  scopeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  scopeEmpty: {
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  scopeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  initialChip: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  heroIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroActions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  heroButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 999,
    paddingVertical: 11,
  },
  previewVanish: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 16,
  },
  previewChatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  previewAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewExpenseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  footnote: {
    textAlign: 'center',
    marginTop: 18,
    lineHeight: 16,
    paddingHorizontal: 8,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  footerSummary: {
    flex: 1,
  },
  doneBtn: {
    paddingVertical: 10,
    paddingHorizontal: 26,
    borderRadius: 999,
  },
});
