import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ProfilePhotoUploader } from '@/components/ProfilePhotoUploader';
import { getFloatingTabBarContentPadding } from '@/components/tabbar/tabBarMetrics';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import {
  getStrictReviewMode,
  listLearningMerchants,
  resetLearningForMerchant,
  setStrictReviewMode,
  type LearningMerchantSummary,
} from '@/services/receiptLearningService';
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Divider, List, Switch, Text } from 'react-native-paper';

export const SettingsScreen = () => {
  const navigation = useNavigation();
  const { user, signOutUser } = useAuth();
  const { isDark, toggleTheme, theme } = useTheme();
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const bottomPadding = getFloatingTabBarContentPadding(insets.bottom, 20);
  const [strictReviewMode, setStrictReviewModeState] = useState(false);
  const [merchantLearning, setMerchantLearning] = useState<LearningMerchantSummary[]>([]);

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
    const [strictMode, merchants] = await Promise.all([
      getStrictReviewMode(),
      listLearningMerchants(),
    ]);
    setStrictReviewModeState(strictMode);
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
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>Settings</Text>
        </GlassView>
      </Animated.View>

      <Animated.ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: bottomPadding }]}
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

        <GlassView style={styles.settingsList}>
          <List.Section>
            <List.Item
              title="Dark Mode"
              left={() => <List.Icon icon="theme-light-dark" />}
              right={() => <Switch value={isDark} onValueChange={handleToggleTheme} />}
            />
            <Divider />
            <List.Item
              title="Strict Receipt Review"
              description="Block confirmation until low-confidence rows are reviewed"
              left={() => <List.Icon icon="shield-lock-outline" />}
              right={() => <Switch value={strictReviewMode} onValueChange={handleToggleStrictReviewMode} />}
            />
            <Divider />
            <List.Item title="Push notifications" description="Managed automatically via device settings" left={() => <List.Icon icon="bell" />} />
            <Divider />
            <List.Item title="Offline sync" description="Enabled" left={() => <List.Icon icon="cloud-sync" />} />
          </List.Section>
        </GlassView>

        <GlassView style={styles.settingsList}>
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
    padding: 16,
    paddingTop: 60,
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingTop: 50,
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
    paddingHorizontal: 8,
    paddingBottom: 16,
  },
  profileCard: {
    alignItems: 'center',
    gap: 8,
    marginBottom: 24,
    padding: 24,
    borderRadius: 24,
  },
  settingsList: {
    borderRadius: 24,
    overflow: 'hidden',
    marginBottom: 16,
  },
});
