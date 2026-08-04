import { useTheme } from '@/context/ThemeContext';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { GlassCard, UserAvatar } from './ui';

interface IncomingCallModalProps {
  visible: boolean;
  callerName: string;
  callerPhotoURL?: string;
  callType: 'audio' | 'video';
  onAccept: () => void;
  onDecline: () => void;
}

export const IncomingCallModal = ({
  visible,
  callerName,
  callerPhotoURL,
  callType,
  onAccept,
  onDecline,
}: IncomingCallModalProps) => {
  const { theme } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onDecline}>
      <View style={styles.overlay}>
        <GlassCard style={styles.container} contentStyle={styles.content} radius="xl">
          <View style={[styles.avatarHalo, { borderColor: theme.colors.primary }]}>
            <UserAvatar photoURL={callerPhotoURL} displayName={callerName} size={104} />
          </View>
          <Text variant="labelLarge" style={[styles.eyebrow, { color: theme.colors.primary }]}>
            ManaSplit call
          </Text>
          <Text variant="headlineMedium" style={[styles.caller, { color: theme.colors.onSurface }]}>
            {callerName}
          </Text>
          <View style={[styles.callTypePill, { backgroundColor: theme.colors.surfaceVariant }]}>
            <MaterialCommunityIcons
              name={callType === 'video' ? 'video-outline' : 'phone-outline'}
              size={17}
              color={theme.colors.onSurfaceVariant}
            />
            <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>
              Incoming {callType === 'video' ? 'video' : 'audio'} call
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable
              onPress={onDecline}
              accessibilityRole="button"
              accessibilityLabel="Decline call"
              style={[styles.actionButton, { backgroundColor: theme.colors.error }]}
            >
              <Icon source="phone-hangup" size={26} color={theme.colors.onError} />
            </Pressable>
            <Pressable
              onPress={onAccept}
              accessibilityRole="button"
              accessibilityLabel={`Accept ${callType} call`}
              style={[styles.actionButton, { backgroundColor: theme.colors.primary }]}
            >
              <Icon source={callType === 'video' ? 'video' : 'phone'} size={26} color={theme.colors.onPrimary} />
            </Pressable>
          </View>
          <View style={styles.actionLabels}>
            <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>Decline</Text>
            <Text variant="labelLarge" style={{ color: theme.colors.onSurfaceVariant }}>Accept</Text>
          </View>
        </GlassCard>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    padding: 24,
  },
  container: {
    width: '100%',
    maxWidth: 380,
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 28,
    paddingVertical: 32,
  },
  avatarHalo: {
    width: 124,
    height: 124,
    borderRadius: 62,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  eyebrow: {
    letterSpacing: 0.5,
  },
  caller: {
    marginTop: 6,
    fontWeight: '700',
    textAlign: 'center',
  },
  callTypePill: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '76%',
    marginTop: 34,
  },
  actionButton: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '78%',
    marginTop: 9,
  },
});
