import { colors } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Avatar, Button, Divider, List, Text } from 'react-native-paper';

export const SettingsScreen = () => {
  const { user, signOutUser } = useAuth();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.profileCard}>
        <Avatar.Text size={64} label={user?.displayName?.slice(0, 2).toUpperCase() ?? 'SC'} />
        <Text variant="titleMedium">{user?.displayName}</Text>
        <Text style={styles.email}>{user?.email}</Text>
        <Button mode="outlined" onPress={signOutUser}>
          Sign out
        </Button>
      </View>
      <Divider />
      <List.Section>
        <List.Item title="Push notifications" description="Managed automatically via device settings" left={() => <List.Icon icon="bell" />} />
        <List.Item title="Offline sync" description="Enabled" left={() => <List.Icon icon="cloud-sync" />} />
      </List.Section>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: colors.background,
  },
  profileCard: {
    alignItems: 'center',
    gap: 8,
    marginBottom: 24,
  },
  email: {
    color: colors.muted,
  },
});
