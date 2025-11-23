import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useRef } from 'react';
import { Animated, ScrollView, StyleSheet, View } from 'react-native';
import { Avatar, Button, Divider, List, Text } from 'react-native-paper';

export const SettingsScreen = () => {
  const navigation = useNavigation();
  const { user, signOutUser } = useAuth();
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

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={styles.stickyHeaderTitle}>Settings</Text>
        </GlassView>
      </Animated.View>

      <ScrollView 
        contentContainerStyle={styles.container}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: false }
        )}
        scrollEventThrottle={16}
      >
        <View style={styles.headerContainer}>
          <Text variant="displaySmall" style={styles.headerTitle}>Settings</Text>
        </View>

        <GlassView style={styles.profileCard}>
          <Avatar.Text size={64} label={user?.displayName?.slice(0, 2).toUpperCase() ?? 'SC'} style={{ backgroundColor: 'rgba(103, 80, 164, 0.1)' }} color="#6750A4" />
          <Text variant="titleMedium" style={{ fontWeight: 'bold' }}>{user?.displayName}</Text>
          <Text style={styles.email}>{user?.email}</Text>
          <Button mode="outlined" onPress={signOutUser} style={{ marginTop: 8 }}>
            Sign out
          </Button>
        </GlassView>
        
        <GlassView style={styles.settingsList}>
          <List.Section>
            <List.Item title="Push notifications" description="Managed automatically via device settings" left={() => <List.Icon icon="bell" />} />
            <Divider style={{ backgroundColor: 'rgba(0,0,0,0.05)' }} />
            <List.Item title="Offline sync" description="Enabled" left={() => <List.Icon icon="cloud-sync" />} />
          </List.Section>
        </GlassView>
      </ScrollView>
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
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
    color: '#333',
  },
  headerContainer: {
    paddingHorizontal: 8,
    paddingBottom: 16,
  },
  headerTitle: {
    fontWeight: 'bold',
    color: '#333',
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
  email: {
    color: colors.muted,
  },
});
