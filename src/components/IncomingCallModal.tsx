import { colors } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Modal, StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';
import { GlassView } from './GlassView';

interface IncomingCallModalProps {
  visible: boolean;
  callerName: string;
  callType: 'audio' | 'video';
  onAccept: () => void;
  onDecline: () => void;
}

export const IncomingCallModal = ({
  visible,
  callerName,
  callType,
  onAccept,
  onDecline,
}: IncomingCallModalProps) => {
  const { theme } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.overlay}>
        <GlassView style={styles.container}>
          <MaterialCommunityIcons
            name={callType === 'video' ? 'video' : 'phone'}
            size={48}
            color={theme.colors.primary}
          />
          <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
            Incoming {callType === 'video' ? 'Video' : 'Audio'} Call
          </Text>
          <Text variant="titleMedium" style={[styles.caller, { color: theme.colors.onSurfaceVariant }]}>
            {callerName}
          </Text>
          <View style={styles.actions}>
            <Button
              mode="contained"
              onPress={onDecline}
              style={[styles.button, { backgroundColor: colors.danger }]}
              icon="phone-hangup"
            >
              Decline
            </Button>
            <Button
              mode="contained"
              onPress={onAccept}
              style={[styles.button, { backgroundColor: colors.success }]}
              icon={callType === 'video' ? 'video' : 'phone'}
            >
              Accept
            </Button>
          </View>
        </GlassView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    padding: 24,
  },
  container: {
    width: '100%',
    maxWidth: 340,
    padding: 32,
    borderRadius: 24,
    alignItems: 'center',
  },
  title: {
    marginTop: 16,
    fontWeight: 'bold',
  },
  caller: {
    marginTop: 8,
  },
  actions: {
    flexDirection: 'row',
    marginTop: 32,
    gap: 16,
  },
  button: {
    flex: 1,
  },
});
