import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatThread } from '@/models';
import type { CallHistoryEntry } from '@/services/localCallStorage';
import { deleteCallFromHistory, getChatCallHistory } from '@/services/localCallStorage';
import { formatCallDuration, formatCallTime, getCallDateSection } from '@/utils/format';
import { lightHaptic, mediumHaptic } from '@/utils/haptics';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
    Alert,
    Platform,
    ScrollView,
    StyleSheet,
    TouchableOpacity,
    View,
} from 'react-native';
import { Avatar, Text } from 'react-native-paper';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

interface CallInfoScreenProps {
  entry: CallHistoryEntry;
  onCallBack: (thread: ChatThread, type: 'audio' | 'video') => void;
}

export const CallInfoScreen = ({ entry, onCallBack }: CallInfoScreenProps) => {
  const navigation = useNavigation<any>();
  const { threads } = useChat();
  const { groups } = useGroups();
  const { theme, isDark } = useTheme();

  const [relatedCalls, setRelatedCalls] = useState<CallHistoryEntry[]>([]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: '',
      headerTransparent: true,
      headerTintColor: theme.colors.primary,
    });
  }, [navigation, theme.colors.primary]);

  // Load all calls with same participant
  useEffect(() => {
    const load = async () => {
      const chatCalls = await getChatCallHistory(entry.chatId);
      setRelatedCalls(chatCalls);
    };
    load();
  }, [entry.chatId]);

  const thread = useMemo(
    () => threads.find((t) => t.chatId === entry.chatId),
    [threads, entry.chatId]
  );

  const groupName = useMemo(() => {
    if (entry.groupId) {
      const group = groups.find((g) => g.groupId === entry.groupId);
      return group?.name;
    }
    return undefined;
  }, [entry.groupId, groups]);

  const isMissed = (e: CallHistoryEntry) =>
    e.status === 'missed' || e.status === 'declined';

  const getStatusLabel = (e: CallHistoryEntry): string => {
    switch (e.status) {
      case 'missed': return 'Missed Call';
      case 'declined': return 'Declined Call';
      case 'failed': return 'Failed Call';
      case 'completed': return e.direction === 'incoming' ? 'Incoming Call' : 'Outgoing Call';
      default: return 'Call';
    }
  };

  const getDirectionIcon = (e: CallHistoryEntry): IconName => {
    if (isMissed(e)) return 'phone-missed';
    return e.direction === 'incoming' ? 'phone-incoming' : 'phone-outgoing';
  };

  const initials = (entry.otherParticipant.displayName || 'U')
    .slice(0, 2)
    .toUpperCase();

  const handleDelete = () => {
    const performDelete = async () => {
      mediumHaptic();
      await deleteCallFromHistory(entry.callId);
      navigation.goBack();
    };

    if (Platform.OS === 'ios') {
      Alert.alert('Delete Call', 'Remove this call from history?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: performDelete },
      ]);
    } else {
      performDelete();
    }
  };

  const formatFullDate = (ts: number): string => {
    const date = new Date(ts);
    return date.toLocaleDateString([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatFullTime = (ts: number): string => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <LiquidBackground>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile Card */}
        <View style={styles.profileSection}>
          {entry.otherParticipant.photoURL ? (
            <Avatar.Image
              size={80}
              source={{ uri: entry.otherParticipant.photoURL }}
            />
          ) : (
            <Avatar.Text
              size={80}
              label={initials}
              style={{ backgroundColor: theme.colors.primary }}
              color={theme.colors.onPrimary}
            />
          )}
          <Text style={[styles.profileName, { color: theme.colors.onSurface }]}>
            {entry.otherParticipant.displayName || 'Unknown'}
          </Text>
          {groupName && (
            <Text style={[styles.groupLabel, { color: theme.colors.onSurfaceVariant }]}>
              {groupName}
            </Text>
          )}
        </View>

        {/* Action Buttons */}
        <View style={styles.actionRow}>
          <GlassView style={styles.actionCard}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => {
                lightHaptic();
                if (thread) onCallBack(thread, 'audio');
              }}
            >
              <MaterialCommunityIcons
                name="phone"
                size={24}
                color={theme.colors.primary}
              />
              <Text style={[styles.actionLabel, { color: theme.colors.primary }]}>
                Audio
              </Text>
            </TouchableOpacity>
          </GlassView>

          <GlassView style={styles.actionCard}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => {
                lightHaptic();
                if (thread) onCallBack(thread, 'video');
              }}
            >
              <MaterialCommunityIcons
                name="video"
                size={24}
                color={theme.colors.primary}
              />
              <Text style={[styles.actionLabel, { color: theme.colors.primary }]}>
                Video
              </Text>
            </TouchableOpacity>
          </GlassView>

          <GlassView style={styles.actionCard}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => {
                lightHaptic();
                if (thread) {
                  // Navigate to chat with this user
                  navigation.navigate(
                    'ChatTab',
                    { screen: 'GroupChat', params: { chatId: entry.chatId } }
                  );
                }
              }}
            >
              <MaterialCommunityIcons
                name="chat"
                size={24}
                color={theme.colors.primary}
              />
              <Text style={[styles.actionLabel, { color: theme.colors.primary }]}>
                Message
              </Text>
            </TouchableOpacity>
          </GlassView>
        </View>

        {/* Call Details Card */}
        <GlassView style={styles.detailCard}>
          <View style={styles.detailHeader}>
            <Text style={[styles.detailTitle, { color: theme.colors.onSurface }]}>
              Call Details
            </Text>
          </View>

          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: theme.colors.onSurfaceVariant }]}>
              Date
            </Text>
            <Text style={[styles.detailValue, { color: theme.colors.onSurface }]}>
              {formatFullDate(entry.startedAt)}
            </Text>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.colors.outlineVariant }]} />

          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: theme.colors.onSurfaceVariant }]}>
              Time
            </Text>
            <Text style={[styles.detailValue, { color: theme.colors.onSurface }]}>
              {formatFullTime(entry.startedAt)}
            </Text>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.colors.outlineVariant }]} />

          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: theme.colors.onSurfaceVariant }]}>
              Status
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <MaterialCommunityIcons
                name={getDirectionIcon(entry)}
                size={16}
                color={isMissed(entry) ? theme.colors.error : theme.colors.primary}
              />
              <Text
                style={[
                  styles.detailValue,
                  {
                    color: isMissed(entry)
                      ? theme.colors.error
                      : theme.colors.onSurface,
                  },
                ]}
              >
                {getStatusLabel(entry)}
              </Text>
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.colors.outlineVariant }]} />

          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: theme.colors.onSurfaceVariant }]}>
              Type
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <MaterialCommunityIcons
                name={entry.type === 'video' ? 'video' : 'phone'}
                size={16}
                color={theme.colors.onSurface}
              />
              <Text style={[styles.detailValue, { color: theme.colors.onSurface }]}>
                {entry.type === 'video' ? 'Video Call' : 'Audio Call'}
              </Text>
            </View>
          </View>

          {entry.status === 'completed' && entry.duration > 0 && (
            <>
              <View style={[styles.divider, { backgroundColor: theme.colors.outlineVariant }]} />
              <View style={styles.detailRow}>
                <Text style={[styles.detailLabel, { color: theme.colors.onSurfaceVariant }]}>
                  Duration
                </Text>
                <Text style={[styles.detailValue, { color: theme.colors.onSurface }]}>
                  {formatCallDuration(entry.duration)}
                </Text>
              </View>
            </>
          )}
        </GlassView>

        {/* Recent Calls with this Contact */}
        {relatedCalls.length > 1 && (
          <GlassView style={styles.detailCard}>
            <View style={styles.detailHeader}>
              <Text style={[styles.detailTitle, { color: theme.colors.onSurface }]}>
                Recent Calls
              </Text>
            </View>
            {relatedCalls.slice(0, 10).map((call, index) => (
              <View key={call.callId}>
                {index > 0 && (
                  <View
                    style={[
                      styles.divider,
                      { backgroundColor: theme.colors.outlineVariant },
                    ]}
                  />
                )}
                <View style={styles.recentCallRow}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <MaterialCommunityIcons
                        name={getDirectionIcon(call)}
                        size={14}
                        color={
                          isMissed(call)
                            ? theme.colors.error
                            : theme.colors.primary
                        }
                      />
                      <Text
                        style={[
                          styles.recentCallStatus,
                          {
                            color: isMissed(call)
                              ? theme.colors.error
                              : theme.colors.onSurface,
                          },
                        ]}
                      >
                        {getStatusLabel(call)}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.recentCallDate,
                        { color: theme.colors.onSurfaceVariant },
                      ]}
                    >
                      {getCallDateSection(call.startedAt)} {formatCallTime(call.startedAt)}
                    </Text>
                  </View>
                  {call.status === 'completed' && call.duration > 0 && (
                    <Text
                      style={[
                        styles.recentCallDuration,
                        { color: theme.colors.onSurfaceVariant },
                      ]}
                    >
                      {formatCallDuration(call.duration)}
                    </Text>
                  )}
                </View>
              </View>
            ))}
          </GlassView>
        )}

        {/* Delete Button */}
        <GlassView style={[styles.detailCard, { marginBottom: 40 }]}>
          <TouchableOpacity onPress={handleDelete} style={styles.deleteButton}>
            <MaterialCommunityIcons
              name="delete-outline"
              size={20}
              color={theme.colors.error}
            />
            <Text style={[styles.deleteButtonText, { color: theme.colors.error }]}>
              Remove from Call History
            </Text>
          </TouchableOpacity>
        </GlassView>
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 100,
    paddingBottom: 40,
  },
  // -- Profile --
  profileSection: {
    alignItems: 'center',
    marginBottom: 24,
    gap: 8,
  },
  profileName: {
    fontSize: 24,
    fontWeight: '700',
    marginTop: 4,
  },
  groupLabel: {
    fontSize: 14,
  },
  // -- Actions --
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  actionCard: {
    flex: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  actionButton: {
    alignItems: 'center',
    paddingVertical: 14,
    gap: 6,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  // -- Detail Card --
  detailCard: {
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 16,
    paddingHorizontal: 16,
  },
  detailHeader: {
    paddingVertical: 14,
  },
  detailTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  detailLabel: {
    fontSize: 15,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: '500',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 0,
  },
  // -- Recent Calls --
  recentCallRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  recentCallStatus: {
    fontSize: 15,
    fontWeight: '500',
  },
  recentCallDate: {
    fontSize: 13,
    marginTop: 2,
    marginLeft: 20,
  },
  recentCallDuration: {
    fontSize: 14,
  },
  // -- Delete --
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    gap: 8,
  },
  deleteButtonText: {
    fontSize: 16,
    fontWeight: '500',
  },
});
