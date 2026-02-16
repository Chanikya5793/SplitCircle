import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ChatListSkeleton } from '@/components/SkeletonLoader';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import type { CallSession, CallType } from '@/models';
import { subscribeToUserCallHistory } from '@/services/callService';
import { lightHaptic } from '@/utils/haptics';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Avatar,
  Button,
  Chip,
  FAB,
  IconButton,
  Portal,
  Searchbar,
  SegmentedButtons,
  Text,
} from 'react-native-paper';

type CallFilter = 'all' | 'missed' | 'incoming' | 'outgoing';

interface GroupedCalls {
  title: string;
  data: CallSession[];
}

const formatCallTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (days === 0) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } else if (days === 1) {
    return 'Yesterday';
  } else if (days < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
};

const formatDuration = (seconds?: number): string => {
  if (!seconds || seconds === 0) return 'Not connected';
  
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  
  if (mins === 0) return `${secs}s`;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const isMissedCall = (call: CallSession, currentUserId: string): boolean => {
  const isOutgoing = call.initiatorId === currentUserId;
  return call.status === 'missed' || (call.status === 'ended' && !call.connectedAt && !isOutgoing);
};

const getCallStatusIcon = (call: CallSession, currentUserId: string): { icon: string; color: string } => {
  const isOutgoing = call.initiatorId === currentUserId;
  
  if (isMissedCall(call, currentUserId)) {
    return { icon: 'phone-missed', color: '#E03C31' };
  }
  
  if (call.status === 'rejected') {
    return { icon: 'phone-hangup', color: '#E03C31' };
  }
  
  if (isOutgoing) {
    return { icon: 'phone-outgoing', color: '#2BB673' };
  }
  
  return { icon: 'phone-incoming', color: '#58A6FF' };
};

export const CallHistoryScreen = () => {
  const navigation = useNavigation();
  const { user } = useAuth();
  const { theme, isDark } = useTheme();
  const scrollY = useRef(new Animated.Value(0)).current;
  
  const [calls, setCalls] = useState<CallSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<CallFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [menuVisible, setMenuVisible] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
    });
  }, [navigation, theme]);

  // Subscribe to call history
  useEffect(() => {
    if (!user) return;

    const unsubscribe = subscribeToUserCallHistory(user.userId, (updatedCalls) => {
      setCalls(updatedCalls);
      setLoading(false);
      setRefreshing(false);
    });

    return () => unsubscribe();
  }, [user]);

  const handleRefresh = () => {
    setRefreshing(true);
    // The subscription will update the calls automatically
    setTimeout(() => setRefreshing(false), 1000);
  };

  // Filter calls based on selected filter
  const filteredCalls = useMemo(() => {
    if (!user) return [];
    
    let result = [...calls];

    // Apply filter
    if (filter !== 'all') {
      result = result.filter(call => {
        const isOutgoing = call.initiatorId === user.userId;
        
        switch (filter) {
          case 'missed':
            return isMissedCall(call, user.userId);
          case 'incoming':
            return !isOutgoing;
          case 'outgoing':
            return isOutgoing;
          default:
            return true;
        }
      });
    }

    // Apply search filter
    if (searchQuery.trim()) {
      result = result.filter(call => {
        const otherParticipant = call.participants.find(p => p.userId !== user.userId);
        return otherParticipant?.displayName.toLowerCase().includes(searchQuery.toLowerCase());
      });
    }

    return result;
  }, [calls, filter, searchQuery, user]);

  // Group calls by date
  const groupedCalls = useMemo(() => {
    const groups: GroupedCalls[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const thisWeekStart = new Date(today);
    thisWeekStart.setDate(thisWeekStart.getDate() - 7);

    const todayCalls: CallSession[] = [];
    const yesterdayCalls: CallSession[] = [];
    const thisWeekCalls: CallSession[] = [];
    const olderCalls: CallSession[] = [];

    filteredCalls.forEach(call => {
      const callDate = new Date(call.startedAt);
      callDate.setHours(0, 0, 0, 0);

      if (callDate.getTime() === today.getTime()) {
        todayCalls.push(call);
      } else if (callDate.getTime() === yesterday.getTime()) {
        yesterdayCalls.push(call);
      } else if (callDate >= thisWeekStart) {
        thisWeekCalls.push(call);
      } else {
        olderCalls.push(call);
      }
    });

    if (todayCalls.length > 0) groups.push({ title: 'Today', data: todayCalls });
    if (yesterdayCalls.length > 0) groups.push({ title: 'Yesterday', data: yesterdayCalls });
    if (thisWeekCalls.length > 0) groups.push({ title: 'This Week', data: thisWeekCalls });
    if (olderCalls.length > 0) groups.push({ title: 'Older', data: olderCalls });

    return groups;
  }, [filteredCalls]);

  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 40],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const handleCallBack = (call: CallSession) => {
    lightHaptic();
    // Navigate to call session screen with the same chat and call type
    (navigation as any).navigate('CallDetail', {
      chatId: call.chatId,
      groupId: call.groupId,
      type: call.type,
    });
  };

  const renderCallItem = (call: CallSession) => {
    if (!user) return null;
    
    const otherParticipant = call.participants.find(p => p.userId !== user.userId);
    const { icon, color } = getCallStatusIcon(call, user.userId);
    
    return (
      <TouchableOpacity
        key={call.callId}
        onPress={() => {
          lightHaptic();
          // Navigate to chat with this person/group
          (navigation as any).navigate('ChatTab', {
            screen: 'GroupChat',
            params: { chatId: call.chatId },
          });
        }}
      >
        <GlassView style={styles.callItem}>
          <View style={styles.callItemContent}>
            <Avatar.Image
              size={48}
              source={
                otherParticipant?.photoURL
                  ? { uri: otherParticipant.photoURL }
                  : require('../../../assets/icon.png')
              }
            />
            
            <View style={styles.callInfo}>
              <View style={styles.callHeader}>
                <Text
                  variant="bodyLarge"
                  style={[styles.callName, { color: theme.colors.onSurface }]}
                  numberOfLines={1}
                >
                  {otherParticipant?.displayName || 'Unknown'}
                </Text>
                {call.groupId && (
                  <Chip
                    compact
                    style={styles.groupChip}
                    textStyle={{ fontSize: 10 }}
                  >
                    Group
                  </Chip>
                )}
              </View>
              
              <View style={styles.callMeta}>
                <MaterialCommunityIcons
                  name={icon as any}
                  size={16}
                  color={color}
                  style={styles.statusIcon}
                />
                <MaterialCommunityIcons
                  name={call.type === 'video' ? 'video' : 'phone'}
                  size={14}
                  color={theme.colors.onSurfaceVariant}
                  style={styles.typeIcon}
                />
                <Text
                  variant="bodySmall"
                  style={{ color: theme.colors.onSurfaceVariant }}
                >
                  {formatCallTime(call.startedAt)}
                </Text>
                {call.duration !== undefined && (
                  <>
                    <Text style={{ color: theme.colors.onSurfaceVariant }}> • </Text>
                    <Text
                      variant="bodySmall"
                      style={{ color: theme.colors.onSurfaceVariant }}
                    >
                      {formatDuration(call.duration)}
                    </Text>
                  </>
                )}
              </View>
            </View>

            <IconButton
              icon={call.type === 'video' ? 'video' : 'phone'}
              size={24}
              iconColor={theme.colors.primary}
              onPress={() => handleCallBack(call)}
            />
          </View>
        </GlassView>
      </TouchableOpacity>
    );
  };

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text
            variant="titleMedium"
            style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}
          >
            Call History
          </Text>
        </GlassView>
      </Animated.View>

      <View style={styles.container}>
        <Animated.ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
        >
          {/* Header */}
          <View style={styles.headerContainer}>
            <Text
              variant="displaySmall"
              style={[styles.headerTitle, { color: theme.colors.onSurface }]}
            >
              Call History
            </Text>
          </View>

          {/* Search Bar */}
          <View style={styles.searchContainer}>
            <Searchbar
              placeholder="Search calls..."
              onChangeText={setSearchQuery}
              value={searchQuery}
              style={[
                styles.searchBar,
                {
                  backgroundColor: isDark
                    ? 'rgba(255,255,255,0.1)'
                    : 'rgba(0,0,0,0.05)',
                },
              ]}
              inputStyle={{ color: theme.colors.onSurface }}
              iconColor={theme.colors.onSurfaceVariant}
            />
          </View>

          {/* Filter Buttons */}
          <View style={styles.filterContainer}>
            <SegmentedButtons
              value={filter}
              onValueChange={(value) => {
                lightHaptic();
                setFilter(value as CallFilter);
              }}
              buttons={[
                { value: 'all', label: 'All' },
                { value: 'missed', label: 'Missed' },
                { value: 'incoming', label: 'Incoming' },
                { value: 'outgoing', label: 'Outgoing' },
              ]}
              style={styles.segmentedButtons}
            />
          </View>

          {/* Statistics */}
          {calls.length > 0 && (
            <GlassView style={styles.statsCard}>
              <View style={styles.statsRow}>
                <View style={styles.statItem}>
                  <Text
                    variant="headlineSmall"
                    style={{ color: theme.colors.primary, fontWeight: 'bold' }}
                  >
                    {calls.length}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Total Calls
                  </Text>
                </View>
                
                <View style={styles.statDivider} />
                
                <View style={styles.statItem}>
                  <Text
                    variant="headlineSmall"
                    style={{ color: theme.colors.primary, fontWeight: 'bold' }}
                  >
                    {calls.filter(c => c.duration && c.duration > 0).length}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Answered
                  </Text>
                </View>
                
                <View style={styles.statDivider} />
                
                <View style={styles.statItem}>
                  <Text
                    variant="headlineSmall"
                    style={{ color: '#E03C31', fontWeight: 'bold' }}
                  >
                    {calls.filter(c => isMissedCall(c, user.userId)).length}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    Missed
                  </Text>
                </View>
              </View>
            </GlassView>
          )}

          {/* Call List */}
          {loading ? (
            // Show skeleton loaders while loading
            <>
              <ChatListSkeleton />
              <ChatListSkeleton />
              <ChatListSkeleton />
              <ChatListSkeleton />
              <ChatListSkeleton />
            </>
          ) : groupedCalls.length === 0 ? (
            <View style={styles.emptyState}>
              <MaterialCommunityIcons
                name="phone-off"
                size={64}
                color={theme.colors.onSurfaceVariant}
              />
              <Text
                variant="titleMedium"
                style={[styles.emptyTitle, { color: theme.colors.onSurface }]}
              >
                No Call History
              </Text>
              <Text
                variant="bodyMedium"
                style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}
              >
                Your call history will appear here once you start making calls.
              </Text>
            </View>
          ) : (
            groupedCalls.map(group => (
              <View key={group.title} style={styles.groupSection}>
                <Text
                  variant="titleSmall"
                  style={[styles.groupTitle, { color: theme.colors.onSurfaceVariant }]}
                >
                  {group.title}
                </Text>
                {group.data.map(call => renderCallItem(call))}
              </View>
            ))
          )}
        </Animated.ScrollView>
      </View>

      {/* Floating Action Button */}
      <FAB
        icon="plus"
        style={[styles.fab, { backgroundColor: theme.colors.primary }]}
        onPress={() => {
          lightHaptic();
          navigation.goBack();
        }}
        label="New Call"
      />
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingTop: 70,
    paddingBottom: 100,
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyHeaderGlass: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
  },
  headerContainer: {
    paddingHorizontal: 8,
    paddingBottom: 16,
  },
  headerTitle: {
    fontWeight: 'bold',
  },
  searchContainer: {
    marginBottom: 16,
  },
  searchBar: {
    elevation: 0,
    borderRadius: 12,
  },
  filterContainer: {
    marginBottom: 16,
  },
  segmentedButtons: {
    borderRadius: 12,
  },
  statsCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 24,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statDivider: {
    width: 1,
    height: 40,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  groupSection: {
    marginBottom: 20,
  },
  groupTitle: {
    fontWeight: 'bold',
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  callItem: {
    borderRadius: 16,
    padding: 12,
    marginBottom: 8,
  },
  callItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  callInfo: {
    flex: 1,
    marginLeft: 12,
  },
  callHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  callName: {
    fontWeight: '600',
    flex: 1,
  },
  groupChip: {
    marginLeft: 8,
    height: 20,
  },
  callMeta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusIcon: {
    marginRight: 4,
  },
  typeIcon: {
    marginRight: 4,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    marginTop: 16,
    fontWeight: 'bold',
  },
  emptyText: {
    marginTop: 8,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    borderRadius: 16,
  },
});
