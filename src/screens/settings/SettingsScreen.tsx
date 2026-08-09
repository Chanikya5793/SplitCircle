// Settings — iOS-style grouped sections on glass cards. Profile hero up top,
// then Appearance / Receipts & AI / General, a destructive sign-out card, and
// the version footer. Every row is a ListRow so spacing, icon chips, and
// chevrons stay consistent; wallpaper rows preview the current photo.

import { LiquidBackground } from '@/components/LiquidBackground';
import { ProfilePhotoUploader } from '@/components/ProfilePhotoUploader';
import { MugguMark } from '@/components/brand';
import { fullBleed, GlassCard, GuardCodePad, ListRow, PrivacyGuardSheet, SCREEN_GUTTER, SectionLabel, SegmentedControl, StickyHeaderPill, WallpaperPickerSheet } from '@/components/ui';
import { attemptUnlock, getGuardSync, hashCode, updateGuard } from '@/services/privacyGuardService';
import { useAppLock } from '@/context/AppLockContext';
import { AUTO_LOCK_OPTIONS, updateAppLock } from '@/services/appLockService';
import { authenticate, biometricLabel, isBiometricAvailable } from '@/services/biometrics';
import { getFloatingTabBarContentPadding } from '@/components/tabbar/tabBarMetrics';
import { APP_NAME, APP_VERSION } from '@/constants/appInfo';
import { ROUTES } from '@/constants/routes';
import { SETTING_IDS } from '@/constants/settingsRegistry';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { useWallpaperSlot } from '@/hooks/useWallpaper';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ROOT_SCREEN_TITLES } from '@/navigation/screenTitles';
import { useSyncRootStackTitle } from '@/navigation/useSyncRootStackTitle';
import {
  getStrictReviewMode,
  getUseAIForReceipts,
  listLearningMerchants,
  resetLearningForMerchant,
  setStrictReviewMode,
  setUseAIForReceipts,
  type LearningMerchantSummary,
} from '@/services/receiptLearningService';
import {
  clearAllChatOverrides,
  listChatOverrideSlots,
  type WallpaperSlot,
} from '@/services/wallpaperService';
import { ACCENT_IDS, ACCENTS } from '@/theme';
import { errorHaptic, lightHaptic, selectionHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Image, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, Switch, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { appAlert, appPrompt } from '@/utils/appAlert';
import { checkDeletionBlockers } from '@/services/accountDeletionService';
import { formatCurrency } from '@/utils/currency';
import { needsDisplayName, resolveDisplayName } from '@/utils/identity';

const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
};

export const SettingsScreen = () => {
  const navigation = useNavigation();
  const { user, signOutUser, deleteAccountAndSignOut } = useAuth();
  const { isDark, theme, mode, setMode, accent, setAccent, surfaceStyle, setSurfaceStyle } =
    useTheme();
  const isFlat = surfaceStyle === 'flat';
  // Keeps row text on the SAME x in both surface styles. The section cards run
  // edge to edge in flat (cardFlat) and sit at the screen gutter in glass, so
  // the rows have to absorb that 16pt difference or the whole screen slides
  // sideways the moment the toggle is flipped — on the very screen the toggle
  // lives on. 24pt both ways, matching the group/chat/expense lists.
  const rowInset = isFlat ? 24 : 8;
  const appWallpaper = useWallpaperSlot('app');
  const chatDefaultWallpaper = useWallpaperSlot('chat-default');
  const { active: guardActive, duress: guardDuress, settings: guardSettings } = usePrivacyGuard();
  const { maskPersonName } = usePrivacyMask();
  // Not in duress: a blanked-out profile card would betray the fake unlock —
  // the coercer usually knows whose phone this is anyway.
  const hideOwnProfile = guardActive && !guardDuress && guardSettings.hideProfile;
  const insets = useSafeAreaInsets();
  const route = useRoute<any>();
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<any>(null);
  const bottomPadding = getFloatingTabBarContentPadding(insets.bottom, 56);

  // Deep-link highlight: search results into a specific setting arrive with a
  // `highlight` param (the registry id). We scroll that row into view and pulse
  // a tinted overlay so the user can see exactly which setting they landed on.
  const anchorRefs = useRef<Record<string, View | null>>({});
  const highlightOpacity = useRef(new Animated.Value(0)).current;
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const [wallpaperSlot, setWallpaperSlot] = useState<WallpaperSlot | null>(null);
  const [guardSheetOpen, setGuardSheetOpen] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const { settings: appLock } = useAppLock();
  const [bioLabel, setBioLabel] = useState('Face ID');
  const [bioAvailable, setBioAvailable] = useState(false);
  const versionTapsRef = useRef<number[]>([]);

  // Hidden entry: 7 quick taps on the version footer. First time sets the
  // secret code via the keypad; afterwards the code (or Face ID) is required
  // to open the sheet. 'set' | 'unlock' | null drives the GuardCodePad below.
  const [guardPad, setGuardPad] = useState<null | 'set' | 'unlock'>(null);

  const handleVersionTap = () => {
    const now = Date.now();
    versionTapsRef.current = [...versionTapsRef.current.filter((t) => now - t < 3000), now];
    if (versionTapsRef.current.length < 7) return;
    versionTapsRef.current = [];
    const guard = getGuardSync();
    // Face ID shortcut: if the user opted into biometric unlock and it's set
    // up, open the hidden settings on a successful scan (code stays as the
    // fallback below if biometrics fail or aren't enrolled).
    if (guard.codeHash && guard.biometricUnlock) {
      void (async () => {
        if (await isBiometricAvailable()) {
          const ok = await authenticate('Open privacy settings');
          if (ok) {
            void updateGuard({ active: false, duressActive: false });
            setGuardSheetOpen(true);
            return;
          }
        }
        setGuardPad('unlock');
      })();
      return;
    }
    setGuardPad(guard.codeHash ? 'unlock' : 'set');
  };

  const handleGuardPadSubmit = async (code: string) => {
    if (guardPad === 'set') {
      const digest = await hashCode(code);
      await updateGuard({ codeHash: digest });
      setGuardSheetOpen(true);
      return { status: 'ok' } as const;
    }
    const { ok, duress, lockedForMs } = await attemptUnlock(code);
    if (ok) {
      void updateGuard({ active: false, duressActive: false });
      setGuardSheetOpen(true);
      return { status: 'ok' } as const;
    }
    if (duress) {
      // Coerced open: dismiss like a success but never show the sheet; with
      // shields up this also drops into the decoy world.
      if (getGuardSync().active) void updateGuard({ duressActive: true });
      return { status: 'ok' } as const;
    }
    if (lockedForMs > 0) return { status: 'locked', lockedForMs } as const;
    return { status: 'wrong' } as const;
  };
  const [strictReviewMode, setStrictReviewModeState] = useState(false);
  const [useAIForReceipts, setUseAIForReceiptsState] = useState(true);
  const [merchantLearning, setMerchantLearning] = useState<LearningMerchantSummary[]>([]);
  useSyncRootStackTitle(ROOT_SCREEN_TITLES.settings);

  useLayoutEffect(() => {
    navigation.setOptions({ headerTitle: '', headerTransparent: true });
  }, [navigation]);

  // Transform slide-in, not opacity — fractional alpha on an ancestor kills
  // UIVisualEffectView glass materials (see StickyHeaderPill).
  const headerTranslate = scrollY.interpolate({
    inputRange: [0, 60],
    outputRange: [-160, 0],
    extrapolate: 'clamp',
  });

  // Changing the chat DEFAULT doesn't touch chats the user customized
  // individually — after a successful change, offer to reset those too.
  const offerOverrideReset = () => {
    const overrides = listChatOverrideSlots();
    if (overrides.length === 0) return;
    appAlert(
      'Apply to all chats?',
      `${overrides.length} ${overrides.length === 1 ? 'chat has' : 'chats have'} their own wallpaper. Replace ${overrides.length === 1 ? 'it' : 'them'} with the new default, or keep them as they are?`,
      [
        { text: 'Keep custom wallpapers', style: 'cancel' },
        { text: 'Apply to all', style: 'destructive', onPress: () => void clearAllChatOverrides() },
      ],
    );
  };

  const openWallpaper = (slot: WallpaperSlot) => {
    lightHaptic();
    setWallpaperSlot(slot);
  };

  const loadReceiptLearningSettings = async () => {
    const [strictMode, useAI, merchants] = await Promise.all([
      getStrictReviewMode(),
      getUseAIForReceipts(),
      listLearningMerchants(),
    ]);
    setStrictReviewModeState(strictMode);
    setUseAIForReceiptsState(useAI);
    setMerchantLearning(merchants);
  };

  useEffect(() => {
    void loadReceiptLearningSettings();
    void biometricLabel().then(setBioLabel);
    void isBiometricAvailable().then(setBioAvailable);
  }, []);

  // Scroll a registered anchor into view, measured relative to the scroll view
  // so nested cards/sections are handled correctly. Best-effort — if the row
  // isn't mounted (e.g. auto-lock while App Lock is off) it simply no-ops.
  const scrollToAnchor = (id: string) => {
    const node = anchorRefs.current[id];
    const scroll = scrollRef.current;
    if (!node || !scroll) return;
    const scrollNode =
      typeof scroll.getScrollableNode === 'function' ? scroll.getScrollableNode() : scroll;
    try {
      node.measureLayout(
        scrollNode,
        (_x: number, y: number) => scroll.scrollTo({ y: Math.max(0, y - 90), animated: true }),
        () => { /* measure failed — leave the scroll position as-is */ },
      );
    } catch { /* measureLayout unavailable — non-fatal */ }
  };

  // React to a `highlight` deep-link param: scroll to and pulse the target row.
  // The param is consumed *inside* the timeout (after the pulse starts) so the
  // resulting re-render doesn't cancel the pending timer via effect cleanup.
  useEffect(() => {
    const target = route.params?.highlight as string | undefined;
    if (!target) return;
    const timer = setTimeout(() => {
      setHighlightId(target);
      scrollToAnchor(target);
      highlightOpacity.setValue(0.18);
      Animated.timing(highlightOpacity, {
        toValue: 0,
        duration: 1600,
        delay: 400,
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (finished) setHighlightId(null);
      });
      (navigation as any).setParams({ highlight: undefined });
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.highlight]);

  // Wraps a row so it can be scrolled to and briefly tinted. Written as a plain
  // render helper (not a component) so wrapping never remounts the row's ListRow
  // / Switch subtree on re-render.
  const wrapAnchor = (id: string, node: ReactNode) => (
    <View
      ref={(r) => {
        anchorRefs.current[id] = r;
      }}
    >
      {node}
      {highlightId === id ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: theme.colors.primary, borderRadius: 12, opacity: highlightOpacity },
          ]}
        />
      ) : null}
    </View>
  );

  const toggleAppLock = (enable: boolean) => {
    lightHaptic();
    if (!enable) {
      void updateAppLock({ enabled: false });
      return;
    }
    void (async () => {
      if (!(await isBiometricAvailable())) {
        appAlert(`${bioLabel} unavailable`, `Set up ${bioLabel} in iOS Settings first.`);
        return;
      }
      const ok = await authenticate(`Enable App Lock with ${bioLabel}`, true);
      if (ok) void updateAppLock({ enabled: true });
    })();
  };

  const pickAutoLock = () => {
    lightHaptic();
    appAlert(
      'Auto-lock',
      'Require unlock after the app has been in the background for:',
      [
        ...AUTO_LOCK_OPTIONS.map((o) => ({
          text: o.label,
          onPress: () => void updateAppLock({ autoLockMs: o.value }),
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ],
    );
  };

  // Independent of the whole-app lock: gate finalizing a settlement behind a
  // biometric confirmation. Default OFF; only offer it when biometrics exist.
  const toggleConfirmSettlements = (enable: boolean) => {
    lightHaptic();
    void updateAppLock({ confirmSettlements: enable });
  };

  const handleToggleStrictReviewMode = async (enabled: boolean) => {
    selectionHaptic();
    setStrictReviewModeState(enabled);
    await setStrictReviewMode(enabled);
  };

  const handleToggleUseAI = async (enabled: boolean) => {
    selectionHaptic();
    setUseAIForReceiptsState(enabled);
    await setUseAIForReceipts(enabled);
  };

  const handleResetMerchantLearning = (merchant: LearningMerchantSummary) => {
    appAlert('Reset Receipt Learning', `Clear local scan-learning memory for ${merchant.label}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: async () => {
          await resetLearningForMerchant(merchant.key);
          await loadReceiptLearningSettings();
        },
      },
    ]);
  };

  const handleSignOut = () => {
    lightHaptic();
    appAlert('Sign out', `Sign out of ${APP_NAME} on this device?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOutUser() },
    ]);
  };

  const confirmDeleteAccount = () => {
    appAlert(
      'Delete account',
      `Permanently delete your ${APP_NAME} account? Your groups, expenses, and chats will be gone for good. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingAccount(true);
            try {
              await deleteAccountAndSignOut();
              successHaptic();
            } catch (error) {
              errorHaptic();
              setDeletingAccount(false);
              appAlert('Could not delete account', errorMessage(error, 'Please try again.'));
            }
          },
        },
      ],
    );
  };

  // Pre-check for blocking groups (unresolved ownership / unsettled balance)
  // before ever showing the irreversible confirm — re-checked server-side too
  // inside deleteAccount itself, this is purely so the user sees exactly what
  // to fix instead of a raw server error.
  const handleDeleteAccount = () => {
    lightHaptic();
    setDeletingAccount(true);
    void (async () => {
      try {
        const blockers = await checkDeletionBlockers();
        setDeletingAccount(false);
        if (blockers.length > 0) {
          appAlert(
            'Resolve these groups first',
            blockers
              .map((b) => `${b.groupName}\n${
                b.reason === 'transfer_ownership'
                  ? 'Transfer ownership or delete this group first'
                  : `Settle up ${formatCurrency(Math.abs(b.balance ?? 0), b.currency)} in this group first`
              }`)
              .join('\n\n'),
          );
          return;
        }
        confirmDeleteAccount();
      } catch (error) {
        setDeletingAccount(false);
        errorHaptic();
        appAlert('Could not check account', errorMessage(error, 'Please try again.'));
      }
    })();
  };

  /**
   * 34px rounded preview of the slot's photo (wallpaper rows). Suppressed
   * while the guard is hiding wallpapers — otherwise the thumbnail itself
   * would leak the exact photo the background reverted away from.
   */
  const wallpaperPreview = (entry: ReturnType<typeof useWallpaperSlot>) => {
    if (!entry || (guardActive && guardSettings.hideWallpaper)) return undefined;
    if (entry.kind === 'blob') {
      // Animated blob wallpaper — show its palette as a little gradient chip.
      return (
        <View style={[styles.wallpaperThumb, { backgroundColor: entry.light[1], overflow: 'hidden' }]}>
          <View style={{ position: 'absolute', left: -6, top: -6, width: 24, height: 24, borderRadius: 12, backgroundColor: entry.light[0] }} />
          <View style={{ position: 'absolute', right: -6, bottom: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: entry.light[2] }} />
        </View>
      );
    }
    if (entry.kind === 'solid') {
      return (
        <View
          style={[styles.wallpaperThumb, { backgroundColor: isDark ? entry.dark : entry.light }]}
        />
      );
    }
    return <Image source={{ uri: entry.uri }} style={styles.wallpaperThumb} accessibilityIgnoresInvertColors />;
  };

  const divider = (
    <View
      // theme.colors.divider, not a literal: in flat mode the card edge is gone
      // and this hairline IS the grouping, so it has to follow the theme rather
      // than a hardcoded alpha tuned for sitting inside a glass card.
      style={[styles.divider, { backgroundColor: theme.colors.divider }]}
    />
  );

  return (
    <LiquidBackground>
      <Animated.View
        style={[
          styles.stickyHeader,
          { transform: [{ translateY: headerTranslate }], paddingTop: insets.top + 8 },
        ]}
      >
        <StickyHeaderPill>
          <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
            Settings
          </Text>
        </StickyHeaderPill>
      </Animated.View>

      <Animated.ScrollView
        ref={scrollRef}
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 24, paddingBottom: bottomPadding }]}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: true,
        })}
        scrollEventThrottle={16}
      >
        <Text variant="displaySmall" style={[styles.pageTitle, { color: theme.colors.onSurface }]}>
          Settings
        </Text>

        {/* Profile hero — identity only; sign-out lives at the bottom. Doc 30:
            the own-name label uses resolveDisplayName (never a raw `||`) so
            an Apple-capture-race-left-empty name reads as the calm "Your
            profile" placeholder, dimmed/italic like GroupInfoScreen's
            archived-member rows — never a blank or the raw '' from Firestore.
            The "Add your name" chip is suppressed while the privacy guard is
            hiding this card — it would otherwise open a real-identity screen
            from behind an intentionally obscured profile. */}
        <GlassCard style={styles.card} contentStyle={styles.profileContent}>
          {hideOwnProfile ? (
            <View style={[styles.profileSilhouette, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }]}>
              <Ionicons name="person" size={30} color={theme.colors.onSurfaceVariant} />
            </View>
          ) : (
            <ProfilePhotoUploader size={64} editable />
          )}
          <View style={styles.profileText}>
            <View style={styles.profileNameRow}>
              <Text
                variant="titleMedium"
                numberOfLines={1}
                style={[
                  styles.profileNameText,
                  {
                    color: needsDisplayName(user) && !hideOwnProfile
                      ? theme.colors.onSurfaceVariant
                      : theme.colors.onSurface,
                    fontStyle: needsDisplayName(user) && !hideOwnProfile ? 'italic' : 'normal',
                  },
                ]}
              >
                {hideOwnProfile
                  ? maskPersonName(resolveDisplayName(user, 'Your profile'))
                  : resolveDisplayName(user, 'Your profile')}
              </Text>
              {needsDisplayName(user) && !hideOwnProfile ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Add your name"
                  activeOpacity={0.82}
                  onPress={() => {
                    lightHaptic();
                    (navigation as any).navigate(ROUTES.APP.EDIT_NAME);
                  }}
                  style={[styles.addNameChip, { backgroundColor: theme.colors.primary }]}
                >
                  <Text variant="labelSmall" style={{ color: theme.colors.onPrimary, fontWeight: '700' }}>
                    Add your name
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <Text variant="bodySmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
              {hideOwnProfile ? '••••••••••' : user?.email}
            </Text>
          </View>
        </GlassCard>

        <SectionLabel style={styles.sectionLabel}>Appearance</SectionLabel>
        <GlassCard style={[styles.card, isFlat && styles.cardFlat]} contentStyle={styles.cardContent}>
          {wrapAnchor(SETTING_IDS.appearance, (
          <View style={[styles.appearanceBlock, { paddingHorizontal: rowInset }]}>
            {/* Not Paper's SegmentedButtons — it sizes its own inner touchable,
                so the 44pt floor grew only the painted box and left the tappable
                area at 36dp sitting at the top of it. See ui/SegmentedControl. */}
            <SegmentedControl
              accessibilityLabel="Appearance"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'system', label: 'System', icon: 'theme-light-dark' },
                { value: 'light', label: 'Light', icon: 'white-balance-sunny' },
                { value: 'dark', label: 'Dark', icon: 'weather-night' },
              ]}
            />
            <SegmentedControl
              accessibilityLabel="Surface style"
              value={surfaceStyle}
              onChange={setSurfaceStyle}
              options={[
                { value: 'glass', label: 'Glass', icon: 'blur' },
                { value: 'flat', label: 'Flat', icon: 'square-outline' },
              ]}
            />
            <View style={styles.accentRow}>
              {ACCENT_IDS.map((id) => {
                const swatch = ACCENTS[id][isDark ? 'dark' : 'light'];
                const selected = accent === id;
                return (
                  <TouchableOpacity
                    key={id}
                    hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
                    accessibilityRole="button"
                    accessibilityLabel={`${ACCENTS[id].label} accent`}
                    accessibilityState={{ selected }}
                    onPress={() => {
                      selectionHaptic();
                      setAccent(id);
                    }}
                    style={[
                      styles.accentSwatch,
                      { backgroundColor: swatch.primary },
                      selected && { borderColor: theme.colors.onSurface, borderWidth: 2 },
                    ]}
                  >
                    {selected ? <Ionicons name="checkmark" size={16} color={swatch.onPrimary} /> : null}
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
              {ACCENTS[accent].label} accent · saved on this device, works offline
            </Text>
          </View>
          ))}
          {divider}
          {wrapAnchor(SETTING_IDS.wallpaperApp, (
          <ListRow inset={rowInset}
            title="App background"
            subtitle={
              guardActive && guardSettings.hideWallpaper
                ? 'Hidden'
                : appWallpaper
                  ? 'Custom photo'
                  : 'Liquid colors'
            }
            icon="image-outline"
            trailing={wallpaperPreview(appWallpaper)}
            onPress={() => openWallpaper('app')}
          />
          ))}
          {divider}
          {wrapAnchor(SETTING_IDS.wallpaperChat, (
          <ListRow inset={rowInset}
            title="Chat wallpaper"
            subtitle={
              guardActive && guardSettings.hideWallpaper
                ? 'Hidden'
                : chatDefaultWallpaper
                  ? 'Custom photo for all chats'
                  : 'Default for chats & groups'
            }
            icon="forum-outline"
            trailing={wallpaperPreview(chatDefaultWallpaper)}
            onPress={() => openWallpaper('chat-default')}
          />
          ))}
        </GlassCard>

        <SectionLabel style={styles.sectionLabel}>Receipts & AI</SectionLabel>
        <GlassCard style={[styles.card, isFlat && styles.cardFlat]} contentStyle={styles.cardContent}>
          {wrapAnchor(SETTING_IDS.aiReceipts, (
          <ListRow inset={rowInset}
            title="AI receipt parsing"
            subtitle="Cloud AI sharpens OCR accuracy"
            icon="creation"
            trailing={<Switch value={useAIForReceipts} onValueChange={handleToggleUseAI} />}
          />
          ))}
          {divider}
          {wrapAnchor(SETTING_IDS.receiptStrict, (
          <ListRow inset={rowInset}
            title="Strict receipt review"
            subtitle="Review low-confidence rows before saving"
            icon="shield-check-outline"
            trailing={<Switch value={strictReviewMode} onValueChange={handleToggleStrictReviewMode} />}
          />
          ))}
          {divider}
          {wrapAnchor(SETTING_IDS.onDeviceAi, (
          <ListRow inset={rowInset}
            title="On-device AI"
            subtitle="What's indexed on this device"
            icon="chip"
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate('AiIndex', { backTitle: ROOT_SCREEN_TITLES.settings });
            }}
          />
          ))}
          {merchantLearning.length > 0 && (
            <>
              {divider}
              <View style={[styles.learningBlock, { paddingHorizontal: rowInset }]}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Receipt learning · on device
                </Text>
                {merchantLearning.map((merchant) => (
                  <View key={merchant.key} style={styles.learningRow}>
                    <View style={{ flex: 1 }}>
                      <Text variant="bodyMedium" numberOfLines={1} style={{ color: theme.colors.onSurface }}>
                        {merchant.label}
                      </Text>
                      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {merchant.correctionCount} corrections · {merchant.droppedCount} drops
                      </Text>
                    </View>
                    <Button compact mode="text" onPress={() => handleResetMerchantLearning(merchant)}>
                      Reset
                    </Button>
                  </View>
                ))}
              </View>
            </>
          )}
        </GlassCard>

        <SectionLabel style={styles.sectionLabel}>Security</SectionLabel>
        <GlassCard style={[styles.card, isFlat && styles.cardFlat]} contentStyle={styles.cardContent}>
          {wrapAnchor(SETTING_IDS.appLock, (
          <ListRow inset={rowInset}
            title={`App Lock (${bioLabel})`}
            subtitle={
              !bioAvailable
                ? `Set up ${bioLabel} in iOS Settings to use this`
                : appLock.enabled
                  ? 'Unlock required to open the app'
                  : 'Require unlock to open the app'
            }
            icon="lock-outline"
            trailing={
              <Switch
                value={appLock.enabled}
                disabled={!bioAvailable}
                onValueChange={toggleAppLock}
              />
            }
          />
          ))}
          {appLock.enabled && (
            <>
              {divider}
              {wrapAnchor(SETTING_IDS.autoLock, (
              <ListRow inset={rowInset}
                title="Auto-lock"
                subtitle={AUTO_LOCK_OPTIONS.find((o) => o.value === appLock.autoLockMs)?.label ?? 'Immediately'}
                icon="timer-outline"
                onPress={pickAutoLock}
              />
              ))}
            </>
          )}
          {divider}
          {wrapAnchor(SETTING_IDS.confirmSettlements, (
          <ListRow inset={rowInset}
            title="Confirm settlements"
            subtitle={
              !bioAvailable
                ? `Set up ${bioLabel} in iOS Settings to use this`
                : `Require ${bioLabel} before recording a settlement`
            }
            icon="shield-check-outline"
            trailing={
              <Switch
                value={appLock.confirmSettlements}
                disabled={!bioAvailable}
                onValueChange={toggleConfirmSettlements}
              />
            }
          />
          ))}
          {divider}
          {wrapAnchor(SETTING_IDS.linkedDevices, (
          <ListRow inset={rowInset}
            title="Linked devices"
            subtitle="Manage devices linked to your account"
            icon="devices"
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate(ROUTES.APP.LINKED_DEVICES, {
                backTitle: ROOT_SCREEN_TITLES.settings,
              });
            }}
          />
          ))}
          {divider}
          {/* One entry point for the whole backup feature — passphrase and
              device retirement are reached from inside it, so Settings doesn't
              fan out three sibling rows for one concern. */}
          <ListRow inset={rowInset}
            title="iCloud backup"
            subtitle="Back up, restore, and schedule your chat history"
            icon="cloud-lock-outline"
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate(ROUTES.APP.BACKUP_SETTINGS, {
                backTitle: ROOT_SCREEN_TITLES.settings,
              });
            }}
          />
        </GlassCard>

        <SectionLabel style={styles.sectionLabel}>General</SectionLabel>
        <GlassCard style={[styles.card, isFlat && styles.cardFlat]} contentStyle={styles.cardContent}>
          <ListRow inset={rowInset}
            title="Your spending"
            subtitle="Cross-group stats, budgets & deep analysis"
            icon="chart-arc"
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate(ROUTES.APP.PERSONAL_STATS, {
                backTitle: ROOT_SCREEN_TITLES.settings,
              });
            }}
          />
          {divider}
          {wrapAnchor(SETTING_IDS.notifications, (
          <ListRow inset={rowInset}
            title="Notifications"
            subtitle="Messages, expenses, sounds & more"
            icon="bell-outline"
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate('NotificationSettings', { backTitle: ROOT_SCREEN_TITLES.settings });
            }}
          />
          ))}
          {divider}
          {wrapAnchor(SETTING_IDS.nearbyMesh, (
          <ListRow inset={rowInset}
            title="Nearby mesh"
            subtitle="Offline messaging and nearby devices"
            icon="access-point"
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate(ROUTES.APP.NEARBY_MESH, {
                backTitle: ROOT_SCREEN_TITLES.settings,
              });
            }}
          />
          ))}
          {divider}
          {wrapAnchor(SETTING_IDS.offlineSync, (
          <ListRow inset={rowInset}
            title="Offline sync"
            subtitle="Connectivity and pending changes"
            icon="cloud-check-outline"
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate(ROUTES.APP.OFFLINE_SYNC, {
                backTitle: ROOT_SCREEN_TITLES.settings,
              });
            }}
          />
          ))}
        </GlassCard>

        <GlassCard style={[styles.card, styles.signOutCard, isFlat && styles.cardFlat]} contentStyle={styles.cardContent}>
          <ListRow inset={rowInset}
            title="Sign out"
            icon="logout"
            iconColor={theme.colors.error}
            chevron={false}
            onPress={handleSignOut}
          />
          {divider}
          <ListRow inset={rowInset}
            title="Delete account"
            subtitle="Permanently erase your account and data"
            icon="trash-can-outline"
            destructive
            chevron={false}
            disabled={deletingAccount}
            trailing={deletingAccount ? <ActivityIndicator size="small" color={theme.colors.danger} /> : undefined}
            onPress={handleDeleteAccount}
          />
        </GlassCard>

        <TouchableOpacity
          onPress={handleVersionTap}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={`${APP_NAME} ${APP_VERSION ? `version ${APP_VERSION}` : 'version'}`}
          style={styles.brandFooter}
        >
          <MugguMark size={30} variant={isDark ? 'reversed' : 'primary'} />
          <Text
            variant="labelSmall"
            style={{ color: theme.colors.onSurfaceVariant }}
          >
            {APP_NAME} {APP_VERSION ? `v${APP_VERSION}` : ''}
          </Text>
        </TouchableOpacity>
      </Animated.ScrollView>

      <PrivacyGuardSheet visible={guardSheetOpen} onClose={() => setGuardSheetOpen(false)} />
      <GuardCodePad
        visible={guardPad !== null}
        mode={guardPad === 'set' ? 'set' : 'unlock'}
        title={guardPad === 'set' ? 'Set a secret code' : 'Enter code'}
        subtitle={
          guardPad === 'set'
            ? 'Opens these hidden settings and releases the guard after a shake.'
            : undefined
        }
        onClose={() => setGuardPad(null)}
        onSubmit={handleGuardPadSubmit}
      />
      <WallpaperPickerSheet
        visible={wallpaperSlot !== null}
        slot={wallpaperSlot}
        title={wallpaperSlot === 'app' ? 'App background' : 'Chat wallpaper'}
        mirrorSlot={wallpaperSlot === 'app' ? 'chat-default' : 'app'}
        mirrorLabel={wallpaperSlot === 'app' ? 'Use chat wallpaper' : 'Use app background'}
        onClose={() => setWallpaperSlot(null)}
        onChanged={(slot) => {
          if (slot === 'chat-default') offerOverrideReset();
        }}
      />
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: SCREEN_GUTTER,
  },
  /** Flat mode: only the ROW CARDS run edge to edge, via a negative margin
   *  that cancels the screen gutter (see components/ui/layout). The gutter
   *  itself STAYS — dropping it from the screen was the first attempt and it
   *  pinned the page title, the profile header, the section labels and the
   *  appearance controls to x=0 as collateral damage: "Settings" sat 1pt from
   *  the edge and the avatar was clipped by it. */
  cardFlat: {
    borderRadius: 0,
    ...fullBleed,
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageTitle: {
    fontWeight: 'bold',
    paddingBottom: 20,
  },
  card: {
    borderRadius: 20,
    overflow: 'hidden',
    marginBottom: 8,
  },
  cardContent: {
    paddingVertical: 4,
  },
  profileSilhouette: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
  },
  profileText: {
    flex: 1,
    gap: 2,
  },
  profileNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  profileNameText: {
    fontWeight: '700',
    flexShrink: 1,
  },
  addNameChip: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  sectionLabel: {
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  /** SCREEN_GUTTER, not less: this block sits inside a card that runs edge to
   *  edge in flat mode (cardFlat), so its own padding is the ONLY thing keeping
   *  the segmented controls and swatches off the screen edge — and they should
   *  line up with the page title and section label above them, not sit 3pt
   *  further out. */
  appearanceBlock: {
    paddingHorizontal: SCREEN_GUTTER,
    paddingTop: 12,
    paddingBottom: 14,
    gap: 14,
  },
  accentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },

  accentSwatch: {
    // 40pt circle is the intended visual; hitSlop lifts the TAPPABLE area to
    // 48 without changing the swatch. (Measured 40x40dp in the audit.)
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    // Leading inset clears the row icon so the line starts at the label;
    // trailing inset stops it short of the screen edge, because a hairline that
    // runs the full width reads as a crack rather than a separator. Matches
    // DIVIDER_INSET in components/ui/Divider.
    marginLeft: 56,
    marginRight: 16,
  },
  wallpaperThumb: {
    width: 34,
    height: 34,
    borderRadius: 8,
  },
  learningBlock: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  learningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  signOutCard: {
    marginTop: 16,
  },
  brandFooter: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 14,
    paddingVertical: 8,
  },
});
