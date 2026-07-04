import { GlassView } from '@/components/GlassView';
import { StickyHeaderPill } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ProfilePhotoUploader } from '@/components/ProfilePhotoUploader';
import { useWallpaperSlot } from '@/hooks/useWallpaper';
import {
  clearAllChatOverrides,
  clearWallpaper,
  listChatOverrideSlots,
  pickAndSetWallpaper,
  type WallpaperSlot,
} from '@/services/wallpaperService';
import { getFloatingTabBarContentPadding } from '@/components/tabbar/tabBarMetrics';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
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
import { ACCENT_IDS, ACCENTS } from '@/theme';
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Animated, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, Divider, Icon, List, SegmentedButtons, Switch, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const SettingsScreen = () => {
  const navigation = useNavigation();
  const { user, signOutUser } = useAuth();
  const { isDark, theme, mode, setMode, accent, setAccent } = useTheme();
  const appWallpaper = useWallpaperSlot('app');
  const chatDefaultWallpaper = useWallpaperSlot('chat-default');

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

  const pickForSlot = (slot: WallpaperSlot) =>
    pickAndSetWallpaper(slot)
      .then((entry) => {
        if (entry && slot === 'chat-default') offerOverrideReset();
      })
      .catch((error) =>
        Alert.alert('Background', error instanceof Error ? error.message : 'Could not set the photo.'),
      );

  const handleWallpaper = (slot: WallpaperSlot, hasValue: boolean) => {
    lightHaptic();
    if (!hasValue) {
      void pickForSlot(slot);
      return;
    }
    Alert.alert(
      slot === 'app' ? 'App background' : 'Chat wallpaper',
      undefined,
      [
        {
          text: 'Choose new photo',
          onPress: () => void pickForSlot(slot),
        },
        { text: 'Remove photo', style: 'destructive', onPress: () => void clearWallpaper(slot) },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const bottomPadding = getFloatingTabBarContentPadding(insets.bottom, 56);
  const [strictReviewMode, setStrictReviewModeState] = useState(false);
  const [useAIForReceipts, setUseAIForReceiptsState] = useState(true);
  const [merchantLearning, setMerchantLearning] = useState<LearningMerchantSummary[]>([]);
  useSyncRootStackTitle(ROOT_SCREEN_TITLES.settings);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
    });
  }, [navigation]);

  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 40],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const handleSetMode = (next: string) => {
    selectionHaptic();
    setMode(next as typeof mode);
  };

  const handleSetAccent = (next: (typeof ACCENT_IDS)[number]) => {
    selectionHaptic();
    setAccent(next);
  };

  const handleSignOut = () => {
    lightHaptic();
    signOutUser();
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
    Alert.alert(
      'Reset Receipt Learning',
      `Clear local scan-learning memory for ${merchant.label}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await resetLearningForMerchant(merchant.key);
            await loadReceiptLearningSettings();
          },
        },
      ],
    );
  };

  return (
    <LiquidBackground>
      <Animated.View
        style={[
          styles.stickyHeader,
          { opacity: headerOpacity, paddingTop: insets.top + 8 },
        ]}
      >
        <StickyHeaderPill style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>Settings</Text>
        </StickyHeaderPill>
      </Animated.View>

      <Animated.ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingTop: insets.top + 24, paddingBottom: bottomPadding },
        ]}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
        scrollEventThrottle={16}
      >
        <View style={styles.headerContainer}>
          <Text variant="displaySmall" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>Settings</Text>
        </View>

        <GlassView style={styles.profileCard}>
          <ProfilePhotoUploader size={80} editable />
          <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface, marginTop: 12 }}>{user?.displayName}</Text>
          <Text style={{ color: theme.colors.secondary }}>{user?.email}</Text>
          <Button mode="outlined" onPress={handleSignOut} style={{ marginTop: 12 }}>
            Sign out
          </Button>
        </GlassView>

        <GlassView style={styles.settingsList} contentStyle={styles.settingsListContent}>
          <List.Section>
            <List.Subheader>Appearance</List.Subheader>
            <View style={styles.appearanceBlock}>
              <SegmentedButtons
                value={mode}
                onValueChange={handleSetMode}
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
                      onPress={() => handleSetAccent(id)}
                      style={[
                        styles.accentSwatch,
                        { backgroundColor: swatch.primary },
                        selected && { borderColor: theme.colors.onSurface, borderWidth: 2 },
                      ]}
                    >
                      {selected ? <Icon source="check" size={18} color={swatch.onPrimary} /> : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text variant="labelSmall" style={{ color: theme.colors.muted, textAlign: 'center' }}>
                {ACCENTS[accent].label} · saved on this device, works offline
              </Text>
            </View>
            <Divider />
            <List.Item
              title="App background"
              description={appWallpaper ? 'Custom photo · tap to change or remove' : 'Use your own photo behind every screen'}
              left={() => <List.Icon icon="image-outline" />}
              right={() => <List.Icon icon="chevron-right" />}
              onPress={() => handleWallpaper('app', Boolean(appWallpaper))}
            />
            <Divider />
            <List.Item
              title="Chat wallpaper"
              description={chatDefaultWallpaper ? 'Custom photo for all chats · tap to change' : 'Default photo for all chats & groups'}
              left={() => <List.Icon icon="message-image-outline" />}
              right={() => <List.Icon icon="chevron-right" />}
              onPress={() => handleWallpaper('chat-default', Boolean(chatDefaultWallpaper))}
            />
            <Divider />
            <List.Item
              title="AI Receipt Parsing"
              description="Use AI APIs to drastically improve OCR accuracy."
              left={() => <List.Icon icon="robot-outline" />}
              right={() => <Switch value={useAIForReceipts} onValueChange={handleToggleUseAI} />}
            />
            <Divider />
            <List.Item
              title="Strict Receipt Review"
              description="Block confirmation until low-confidence rows are reviewed"
              left={() => <List.Icon icon="shield-lock-outline" />}
              right={() => <Switch value={strictReviewMode} onValueChange={handleToggleStrictReviewMode} />}
            />
            <Divider />
            <List.Item
              title="Notifications"
              description="Messages, expenses, sounds & more"
              left={() => <List.Icon icon="bell" />}
              right={() => <List.Icon icon="chevron-right" />}
              onPress={() => {
                lightHaptic();
                (navigation as any).navigate('NotificationSettings', { backTitle: ROOT_SCREEN_TITLES.settings });
              }}
            />
            <Divider />
            <List.Item
              title="On-Device AI"
              description="What's indexed on this device · privacy"
              left={() => <List.Icon icon="brain" />}
              right={() => <List.Icon icon="chevron-right" />}
              onPress={() => {
                lightHaptic();
                (navigation as any).navigate('AiIndex', { backTitle: ROOT_SCREEN_TITLES.settings });
              }}
            />
            <Divider />
            <List.Item title="Offline sync" description="Enabled" left={() => <List.Icon icon="cloud-sync" />} />
          </List.Section>
        </GlassView>

        <GlassView style={styles.settingsList} contentStyle={styles.settingsListContent}>
          <List.Section>
            <List.Subheader>Receipt Learning (On Device)</List.Subheader>
            {merchantLearning.length === 0 ? (
              <List.Item
                title="No learned merchants yet"
                description="As you correct scanned receipts, local memory will appear here"
                left={() => <List.Icon icon="brain" />}
              />
            ) : (
              merchantLearning.map((merchant, index) => (
                <View key={merchant.key}>
                  {index > 0 ? <Divider /> : null}
                  <List.Item
                    title={merchant.label}
                    description={`Corrections: ${merchant.correctionCount} • Drops: ${merchant.droppedCount}`}
                    left={() => <List.Icon icon="store-cog-outline" />}
                    right={() => (
                      <Button mode="text" onPress={() => handleResetMerchantLearning(merchant)}>
                        Reset
                      </Button>
                    )}
                  />
                </View>
              ))
            )}
          </List.Section>
        </GlassView>
      </Animated.ScrollView>
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
  stickyHeaderGlass: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
  },
  headerContainer: {
    paddingBottom: 20,
  },
  profileCard: {
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
    padding: 24,
    borderRadius: 24,
    overflow: 'hidden',
  },
  settingsList: {
    borderRadius: 24,
    overflow: 'hidden',
    marginBottom: 16,
  },
  settingsListContent: {
    borderRadius: 24,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  appearanceBlock: {
    paddingHorizontal: 12,
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
});
