// Settings — iOS-style grouped sections on glass cards. Profile hero up top,
// then Appearance / Receipts & AI / General, a destructive sign-out card, and
// the version footer. Every row is a ListRow so spacing, icon chips, and
// chevrons stay consistent; wallpaper rows preview the current photo.

import { LiquidBackground } from '@/components/LiquidBackground';
import { ProfilePhotoUploader } from '@/components/ProfilePhotoUploader';
import { GlassCard, ListRow, SectionLabel, StickyHeaderPill, WallpaperPickerSheet } from '@/components/ui';
import { getFloatingTabBarContentPadding } from '@/components/tabbar/tabBarMetrics';
import { APP_NAME, APP_VERSION } from '@/constants/appInfo';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { useWallpaperSlot } from '@/hooks/useWallpaper';
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
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Animated, Image, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, SegmentedButtons, Switch, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const SettingsScreen = () => {
  const navigation = useNavigation();
  const { user, signOutUser } = useAuth();
  const { isDark, theme, mode, setMode, accent, setAccent } = useTheme();
  const appWallpaper = useWallpaperSlot('app');
  const chatDefaultWallpaper = useWallpaperSlot('chat-default');
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const bottomPadding = getFloatingTabBarContentPadding(insets.bottom, 56);

  const [wallpaperSlot, setWallpaperSlot] = useState<WallpaperSlot | null>(null);
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
    Alert.alert(
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
  }, []);

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
    Alert.alert('Reset Receipt Learning', `Clear local scan-learning memory for ${merchant.label}?`, [
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
    Alert.alert('Sign out', `Sign out of ${APP_NAME} on this device?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOutUser() },
    ]);
  };

  /** 34px rounded preview of the slot's photo (wallpaper rows). */
  const wallpaperPreview = (uri: string | undefined) =>
    uri ? (
      <Image source={{ uri }} style={styles.wallpaperThumb} accessibilityIgnoresInvertColors />
    ) : undefined;

  const divider = (
    <View
      style={[styles.divider, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}
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
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 24, paddingBottom: bottomPadding }]}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: true,
        })}
        scrollEventThrottle={16}
      >
        <Text variant="displaySmall" style={[styles.pageTitle, { color: theme.colors.onSurface }]}>
          Settings
        </Text>

        {/* Profile hero — identity only; sign-out lives at the bottom. */}
        <GlassCard style={styles.card} contentStyle={styles.profileContent}>
          <ProfilePhotoUploader size={64} editable />
          <View style={styles.profileText}>
            <Text
              variant="titleMedium"
              numberOfLines={1}
              style={{ fontWeight: '700', color: theme.colors.onSurface }}
            >
              {user?.displayName || 'Your profile'}
            </Text>
            <Text variant="bodySmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
              {user?.email}
            </Text>
          </View>
        </GlassCard>

        <SectionLabel style={styles.sectionLabel}>Appearance</SectionLabel>
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <View style={styles.appearanceBlock}>
            <SegmentedButtons
              value={mode}
              onValueChange={(next) => {
                selectionHaptic();
                setMode(next as typeof mode);
              }}
              buttons={[
                { value: 'system', label: 'System', icon: 'theme-light-dark' },
                { value: 'light', label: 'Light', icon: 'white-balance-sunny' },
                { value: 'dark', label: 'Dark', icon: 'weather-night' },
              ]}
            />
            <View style={styles.accentRow}>
              {ACCENT_IDS.map((id) => {
                const swatch = ACCENTS[id][isDark ? 'dark' : 'light'];
                const selected = accent === id;
                return (
                  <TouchableOpacity
                    key={id}
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
          {divider}
          <ListRow
            title="App background"
            subtitle={appWallpaper ? 'Custom photo' : 'Liquid colors'}
            icon="image-outline"
            trailing={wallpaperPreview(appWallpaper?.uri)}
            onPress={() => openWallpaper('app')}
          />
          {divider}
          <ListRow
            title="Chat wallpaper"
            subtitle={chatDefaultWallpaper ? 'Custom photo for all chats' : 'Default for chats & groups'}
            icon="forum-outline"
            trailing={wallpaperPreview(chatDefaultWallpaper?.uri)}
            onPress={() => openWallpaper('chat-default')}
          />
        </GlassCard>

        <SectionLabel style={styles.sectionLabel}>Receipts & AI</SectionLabel>
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <ListRow
            title="AI receipt parsing"
            subtitle="Cloud AI sharpens OCR accuracy"
            icon="creation"
            trailing={<Switch value={useAIForReceipts} onValueChange={handleToggleUseAI} />}
          />
          {divider}
          <ListRow
            title="Strict receipt review"
            subtitle="Review low-confidence rows before saving"
            icon="shield-check-outline"
            trailing={<Switch value={strictReviewMode} onValueChange={handleToggleStrictReviewMode} />}
          />
          {divider}
          <ListRow
            title="On-device AI"
            subtitle="What's indexed on this device"
            icon="chip"
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate('AiIndex', { backTitle: ROOT_SCREEN_TITLES.settings });
            }}
          />
          {merchantLearning.length > 0 && (
            <>
              {divider}
              <View style={styles.learningBlock}>
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

        <SectionLabel style={styles.sectionLabel}>General</SectionLabel>
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <ListRow
            title="Notifications"
            subtitle="Messages, expenses, sounds & more"
            icon="bell-outline"
            onPress={() => {
              lightHaptic();
              (navigation as any).navigate('NotificationSettings', { backTitle: ROOT_SCREEN_TITLES.settings });
            }}
          />
          {divider}
          <ListRow
            title="Offline sync"
            subtitle="Changes save locally and sync when online"
            icon="cloud-check-outline"
            trailing={<Ionicons name="checkmark-circle" size={20} color={theme.colors.success} />}
          />
        </GlassCard>

        <GlassCard style={[styles.card, styles.signOutCard]} contentStyle={styles.cardContent}>
          <ListRow
            title="Sign out"
            icon="logout"
            iconColor={theme.colors.error}
            chevron={false}
            onPress={handleSignOut}
          />
        </GlassCard>

        <Text variant="labelSmall" style={[styles.versionText, { color: theme.colors.onSurfaceVariant }]}>
          {APP_NAME} {APP_VERSION ? `v${APP_VERSION}` : ''}
        </Text>
      </Animated.ScrollView>

      <WallpaperPickerSheet
        visible={wallpaperSlot !== null}
        slot={wallpaperSlot}
        title={wallpaperSlot === 'app' ? 'App background' : 'Chat wallpaper'}
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
    paddingHorizontal: 16,
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
  sectionLabel: {
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  appearanceBlock: {
    paddingHorizontal: 12,
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
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 56,
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
  versionText: {
    textAlign: 'center',
    marginTop: 14,
  },
});
