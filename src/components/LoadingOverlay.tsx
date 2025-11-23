import { GlassView } from '@/components/GlassView';
import { colors } from '@/constants';
import { StyleSheet } from 'react-native';
import { ActivityIndicator, Modal, Portal, Text } from 'react-native-paper';

interface LoadingOverlayProps {
  visible: boolean;
  message?: string;
}

export const LoadingOverlay = ({ visible, message = 'Loading…' }: LoadingOverlayProps) => (
  <Portal>
    <Modal visible={visible} dismissable={false} contentContainerStyle={styles.modalContent}>
      <GlassView style={styles.container}>
        <ActivityIndicator animating size="large" color={colors.primary} />
        <Text style={styles.text}>{message}</Text>
      </GlassView>
    </Modal>
  </Portal>
);

const styles = StyleSheet.create({
  modalContent: {
    margin: 32,
  },
  container: {
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
    gap: 12,
  },
  text: {
    marginTop: 8,
  },
});
