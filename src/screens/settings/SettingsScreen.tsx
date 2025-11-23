import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { ScrollView, StyleSheet } from 'react-native';
import { Avatar, Button, Divider, List, Text } from 'react-native-paper';

export const SettingsScreen = () => {
  const { user, signOutUser } = useAuth();

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={styles.container}>
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
