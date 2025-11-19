import { colors } from '@/constants';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { StyleSheet } from 'react-native';
import { Banner } from 'react-native-paper';

export const OfflineBanner = () => {
  const { isOnline } = useOfflineSync();
  if (isOnline) {
    return null;
  }
  return <Banner visible={!isOnline} icon="wifi-off" style={styles.banner}>Working offline. Changes will sync when reconnected.</Banner>;
};

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.secondary,
  },
});
