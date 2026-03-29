import { GlassView } from '@/components/GlassView';
import { colors } from '@/constants';
import { Modal, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';

interface LoadingOverlayProps {
  visible: boolean;
  message?: string;
}

export const LoadingOverlay = ({ visible, message = 'Loading…' }: LoadingOverlayProps) => {
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={styles.backdrop}>
        <GlassView style={styles.container}>
          <ActivityIndicator animating size="large" color={colors.primary} />
          <Text style={styles.text}>{message}</Text>
        </GlassView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: 'rgba(8, 12, 20, 0.32)',
  },
  container: {
    width: '100%',
    maxWidth: 320,
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
    gap: 12,
  },
  text: {
    marginTop: 8,
  },
});
