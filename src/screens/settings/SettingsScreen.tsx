import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ProfilePhotoUploader } from '@/components/ProfilePhotoUploader';
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
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Animated, StyleSheet, View } from 'react-native';
import { Button, Divider, List, Switch, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const SettingsScreen = () => {
  const navigation = useNavigation();
  const { user, signOutUser } = useAuth();
  const { isDark, toggleTheme, theme } = useTheme();
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

  const handleToggleTheme = () => {
    selectionHaptic();
    toggleTheme();
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
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>Settings</Text>
        </GlassView>
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
            <List.Item
              title="Dark Mode"
              left={() => <List.Icon icon="theme-light-dark" />}
              right={() => <Switch value={isDark} onValueChange={handleToggleTheme} />}
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
  },
});
