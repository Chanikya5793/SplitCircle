import { colors } from '@/constants';
import { StyleSheet } from 'react-native';
import { ActivityIndicator, Modal, Portal, Text } from 'react-native-paper';

interface LoadingOverlayProps {
  visible: boolean;
  message?: string;
}

export const LoadingOverlay = ({ visible, message = 'Loading…' }: LoadingOverlayProps) => (
  <Portal>
    <Modal visible={visible} dismissable={false} contentContainerStyle={styles.container}>
      <ActivityIndicator animating size="large" color={colors.primary} />
      <Text style={styles.text}>{message}</Text>
    </Modal>
  </Portal>
);

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    padding: 24,
    margin: 32,
    borderRadius: 16,
    alignItems: 'center',
    gap: 12,
  },
  text: {
    marginTop: 8,
  },
});
