import { MugguLoader } from '@/components/brand';
import { GlassCard } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import { Modal, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

interface LoadingOverlayProps {
  visible: boolean;
  message?: string;
}

export const LoadingOverlay = ({ visible, message = 'Loading…' }: LoadingOverlayProps) => {
  const { isDark, theme } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]}>
        <GlassCard style={styles.container} contentStyle={styles.content}>
          <MugguLoader
            size={48}
            variant={isDark ? 'reversed' : 'primary'}
            showPen={false}
            accessibilityLabel={message}
          />
          <Text style={[styles.text, { color: theme.colors.onSurface }]}>{message}</Text>
        </GlassCard>
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
  },
  content: {
    padding: 24,
    alignItems: 'center',
    gap: 12,
  },
  text: {
    textAlign: 'center',
  },
});
