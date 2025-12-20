import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ProfilePhotoUploader } from '@/components/ProfilePhotoUploader';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Button, Divider, List, Switch, Text } from 'react-native-paper';

export const SettingsScreen = () => {
  const navigation = useNavigation();
  const { user, signOutUser } = useAuth();
  const { isDark, toggleTheme, theme } = useTheme();
  const scrollY = useRef(new Animated.Value(0)).current;

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

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>Settings</Text>
        </GlassView>
      </Animated.View>

      <Animated.ScrollView
        contentContainerStyle={styles.container}
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
            <List.Item title="Push notifications" description="Managed automatically via device settings" left={() => <List.Icon icon="bell" />} />
            <Divider />
            <List.Item title="Offline sync" description="Enabled" left={() => <List.Icon icon="cloud-sync" />} />
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
    paddingBottom: 100,
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
  },
});
