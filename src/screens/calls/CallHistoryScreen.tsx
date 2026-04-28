import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { getFloatingTabBarContentPadding } from '@/components/tabbar/tabBarMetrics';
import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ChatThread } from '@/models';
import { ROOT_SCREEN_TITLES } from '@/navigation/screenTitles';
import { useSyncRootStackTitle } from '@/navigation/useSyncRootStackTitle';
import {
    clearCallHistory,
    deleteCallFromHistory,
    getCallHistory,
    type CallHistoryEntry,
} from '@/services/localCallStorage';
import { formatCallDuration, formatCallTime, getCallDateSection } from '@/utils/format';
import { lightHaptic, mediumHaptic, warningHaptic } from '@/utils/haptics';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    ActionSheetIOS,
    Alert,
    FlatList,
    Modal,
    Platform,
    Pressable,
    Animated as RNAnimated,
    StyleSheet,
    TouchableOpacity,
    View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar, Text, TextInput, TouchableRipple } from 'react-native-paper';
import Animated, {
    FadeIn,
    FadeOut,
    Layout,
    SlideInDown,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

type CallFilter = 'all' | 'missed';

interface CallHistorySection {
  title: string;
  data: CallHistoryEntry[];
}

interface CallHistoryScreenProps {
  onStartCall: (thread: ChatThread, type: 'audio' | 'video') => void;
  onOpenCallInfo: (entry: CallHistoryEntry) => void;
}

export const CallHistoryScreen = ({ onStartCall, onOpenCallInfo }: CallHistoryScreenProps) => {
  const navigation = useNavigation();
  const { user } = useAuth();
  const { threads } = useChat();
  const { groups } = useGroups();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const listBottomPadding = getFloatingTabBarContentPadding(insets.bottom, 56);

  const [callHistory, setCallHistory] = useState<CallHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [filter, setFilter] = useState<CallFilter>('all');
  const [showNewCallSheet, setShowNewCallSheet] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  useSyncRootStackTitle(ROOT_SCREEN_TITLES.calls);

  const scrollY = useRef(new RNAnimated.Value(0)).current;
  const openSwipeableRef = useRef<Swipeable | null>(null);
  const sheetTranslateY = useSharedValue(0);
  const sheetContext = useSharedValue({ y: 0 });

  const dismissSheet = useCallback(() => {
    setShowNewCallSheet(false);
  }, []);

  const sheetGesture = Gesture.Pan()
    .onStart(() => {
      sheetContext.value = { y: sheetTranslateY.value };
    })
    .onUpdate((event) => {
      sheetTranslateY.value = Math.max(0, event.translationY + sheetContext.value.y);
    })
    .onEnd((event) => {
      if (sheetTranslateY.value > 100 || event.velocityY > 500) {
        sheetTranslateY.value = withTiming(1000, { duration: 200 }, () => {
          runOnJS(dismissSheet)();
        });
      } else {
        sheetTranslateY.value = withSpring(0, { damping: 50 });
      }
    });

  const sheetAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTranslateY.value }],
  }));

  // Load call history on screen focus
  useFocusEffect(
    useCallback(() => {
      loadHistory();
    }, [])
  );

  const loadHistory = async () => {
    setIsLoading(true);
    const history = await getCallHistory();
    setCallHistory(history);
    setIsLoading(false);
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
    });
  }, [navigation]);

  useEffect(() => {
    if (showNewCallSheet) {
      sheetTranslateY.value = 0;
    }
  }, [showNewCallSheet]);

  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 40],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  // Filter calls
  const filteredCalls = useMemo(() => {
    if (filter === 'missed') {
      return callHistory.filter(
        (c) => c.status === 'missed' || c.status === 'declined'
      );
    }
    return callHistory;
  }, [callHistory, filter]);

  // Group calls into sections by date (Apple phone style)
  const sections: CallHistorySection[] = useMemo(() => {
    const sectionMap = new Map<string, CallHistoryEntry[]>();
    for (const call of filteredCalls) {
      const section = getCallDateSection(call.startedAt);
      if (!sectionMap.has(section)) {
        sectionMap.set(section, []);
      }
      sectionMap.get(section)!.push(call);
    }
    return Array.from(sectionMap.entries()).map(([title, data]) => ({ title, data }));
  }, [filteredCalls]);

  // -- Helpers --

  const isMissedOrDeclined = (entry: CallHistoryEntry) =>
    entry.status === 'missed' || entry.status === 'declined';

  const getCallIcon = (entry: CallHistoryEntry): IconName => {
    if (isMissedOrDeclined(entry)) {
      return 'phone-missed';
    }
    if (entry.direction === 'incoming') return 'phone-incoming';
    return 'phone-outgoing';
  };

  const getCallIconColor = (entry: CallHistoryEntry): string => {
    if (isMissedOrDeclined(entry)) return theme.colors.error;
    return theme.colors.primary;
  };

  const getCallStatusLabel = (entry: CallHistoryEntry): string => {
    if (entry.status === 'missed') return 'Missed';
    if (entry.status === 'declined') return 'Declined';
    if (entry.status === 'failed') return 'Failed';
    return entry.direction === 'incoming' ? 'Incoming' : 'Outgoing';
  };

  const getSubtitle = (entry: CallHistoryEntry): string => {
    const direction = getCallStatusLabel(entry);
    const typeIcon = entry.type === 'video' ? 'Video' : 'Audio';
    if (entry.status === 'completed' && entry.duration > 0) {
      return `${direction} ${typeIcon} \u00B7 ${formatCallDuration(entry.duration)}`;
    }
    return `${direction} ${typeIcon}`;
  };

  // Find matching thread to initiate a callback
  const findThread = (entry: CallHistoryEntry): ChatThread | undefined => {
    return threads.find((t) => t.chatId === entry.chatId);
  };

  // Get display name for a thread (other participant's name, or group name)
  const getThreadDisplayName = (thread: ChatThread): string => {
    if (thread.groupId) {
      const group = groups.find((g) => g.groupId === thread.groupId);
      return group?.name || 'Group';
    }
    const other = thread.participants.find((p) => p.userId !== user?.userId);
    return other?.displayName || 'Unknown';
  };

  const getThreadPhoto = (thread: ChatThread): string | undefined => {
    if (thread.groupId) return undefined;
    const other = thread.participants.find((p) => p.userId !== user?.userId);
    return other?.photoURL;
  };

  const getThreadInitials = (thread: ChatThread): string => {
    return getThreadDisplayName(thread).slice(0, 2).toUpperCase();
  };

  // Threads filtered by search query for new call sheet
  const filteredThreads = useMemo(() => {
    if (!searchQuery.trim()) return threads;
    const q = searchQuery.toLowerCase();
    return threads.filter((t) => getThreadDisplayName(t).toLowerCase().includes(q));
  }, [threads, searchQuery, user, groups]);

  const handleCallBack = (entry: CallHistoryEntry) => {
    lightHaptic();
    const thread = findThread(entry);
    if (thread) {
      onStartCall(thread, entry.type);
    }
  };

  const handleDeleteCall = async (callId: string) => {
    mediumHaptic();
    await deleteCallFromHistory(callId);
    setCallHistory((prev) => prev.filter((c) => c.callId !== callId));
  };

  const handleClearAll = () => {
    const performClear = async () => {
      warningHaptic();
      await clearCallHistory();
      setCallHistory([]);
      setIsEditing(false);
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Clear All Recents'],
          destructiveButtonIndex: 1,
          cancelButtonIndex: 0,
          title: 'Clear all call history?',
          message: 'This action cannot be undone.',
        },
        (buttonIndex) => {
          if (buttonIndex === 1) {
            performClear();
          }
        }
      );
    } else {
      Alert.alert(
        'Clear All Recents',
        'This action cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Clear All', style: 'destructive', onPress: performClear },
        ]
      );
    }
  };

  const toggleEdit = () => {
    lightHaptic();
    if (isEditing && openSwipeableRef.current) {
      openSwipeableRef.current.close();
      openSwipeableRef.current = null;
    }
    setIsEditing((prev) => !prev);
  };

  // -- Render Helpers --

  const renderRightActions = (
    _progress: RNAnimated.AnimatedInterpolation<number>,
    _dragX: RNAnimated.AnimatedInterpolation<number>,
    callId: string
  ) => {
    return (
      <TouchableOpacity
        style={styles.deleteAction}
        onPress={() => handleDeleteCall(callId)}
        activeOpacity={0.7}
      >
        <MaterialCommunityIcons name="delete" size={24} color="#fff" />
        <Text style={styles.deleteActionText}>Delete</Text>
      </TouchableOpacity>
    );
  };

  const renderCallItem = ({ item }: { item: CallHistoryEntry }) => {
    const missed = isMissedOrDeclined(item);
    const nameColor = missed ? theme.colors.error : theme.colors.onSurface;
    const initials = (item.otherParticipant.displayName || 'U').slice(0, 2).toUpperCase();

    return (
      <Swipeable
        ref={(ref) => {
          // Close previous if opening a new one
          if (ref && openSwipeableRef.current && openSwipeableRef.current !== ref) {
            openSwipeableRef.current.close();
          }
        }}
        onSwipeableOpen={(_direction, swipeable) => {
          openSwipeableRef.current = swipeable;
        }}
        renderRightActions={(progress, dragX) =>
          renderRightActions(progress, dragX, item.callId)
        }
        overshootRight={false}
        friction={2}
      >
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          layout={Layout.springify()}
        >
          <GlassView style={styles.callItem}>
            <TouchableRipple
              onPress={() => {
                lightHaptic();
                onOpenCallInfo(item);
              }}
              style={styles.callItemContent}
              borderless
            >
              <View style={styles.callRow}>
                {/* Left: Avatar + Delete button in edit mode */}
                <View style={styles.leftSection}>
                  {isEditing && (
                    <Animated.View
                      entering={FadeIn.duration(200)}
                      exiting={FadeOut.duration(150)}
                    >
                      <TouchableOpacity
                        onPress={() => handleDeleteCall(item.callId)}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        style={styles.deleteCircle}
                      >
                        <MaterialCommunityIcons
                          name="minus-circle"
                          size={22}
                          color={theme.colors.error}
                        />
                      </TouchableOpacity>
                    </Animated.View>
                  )}

                  {item.otherParticipant.photoURL ? (
                    <Avatar.Image
                      size={44}
                      source={{ uri: item.otherParticipant.photoURL }}
                    />
                  ) : (
                    <Avatar.Text
                      size={44}
                      label={initials}
                      style={{ backgroundColor: theme.colors.primary }}
                      color={theme.colors.onPrimary}
                    />
                  )}
                </View>

                {/* Center: Name + call info */}
                <View style={styles.centerSection}>
                  <Text
                    style={[styles.callName, { color: nameColor }]}
                    numberOfLines={1}
                  >
                    {item.otherParticipant.displayName || 'Unknown'}
                  </Text>
                  <View style={styles.callMeta}>
                    <MaterialCommunityIcons
                      name={getCallIcon(item)}
                      size={14}
                      color={getCallIconColor(item)}
                    />
                    <Text
                      style={[styles.callSubtitle, { color: theme.colors.onSurfaceVariant }]}
                      numberOfLines={1}
                    >
                      {getSubtitle(item)}
                    </Text>
                  </View>
                </View>

                {/* Right: Time + callback button */}
                <View style={styles.rightSection}>
                  <Text style={[styles.callTime, { color: theme.colors.onSurfaceVariant }]}>
                    {formatCallTime(item.startedAt)}
                  </Text>
                  {!isEditing && (
                    <TouchableOpacity
                      onPress={() => handleCallBack(item)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <MaterialCommunityIcons
                        name={item.type === 'video' ? 'video-outline' : 'phone-outline'}
                        size={22}
                        color={theme.colors.primary}
                      />
                    </TouchableOpacity>
                  )}
                  {!isEditing && (
                    <TouchableOpacity
                      onPress={() => {
                        lightHaptic();
                        onOpenCallInfo(item);
                      }}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <MaterialCommunityIcons
                        name="information-outline"
                        size={20}
                        color={theme.colors.primary}
                      />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </TouchableRipple>
          </GlassView>
        </Animated.View>
      </Swipeable>
    );
  };

  const renderSectionHeader = ({ section }: { section: CallHistorySection }) => (
    <View style={styles.sectionHeader}>
      <Text
        style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}
      >
        {section.title}
      </Text>
    </View>
  );

  return (
    <LiquidBackground>
      {/* Sticky header on scroll (like existing screens) */}
      <RNAnimated.View
        pointerEvents="none"
        style={[
          styles.stickyHeader,
          { opacity: headerOpacity, paddingTop: insets.top + 8 },
        ]}
      >
        <GlassView style={styles.stickyHeaderGlass}>
          <Text
            variant="titleMedium"
            style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}
          >
            Calls
          </Text>
        </GlassView>
      </RNAnimated.View>

      <View style={styles.container}>
        <RNAnimated.SectionList
          sections={sections}
          keyExtractor={(item) => item.callId}
          renderItem={renderCallItem}
          renderSectionHeader={renderSectionHeader}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={[
            styles.listContent,
            { paddingTop: insets.top + 24, paddingBottom: listBottomPadding },
          ]}
          ListHeaderComponent={
            <View style={styles.headerContainer}>
              {/* Title row: Edit button + "Calls" + new call icon */}
              <View style={styles.titleRow}>
                <TouchableOpacity
                  onPress={toggleEdit}
                  style={[
                    styles.editButton,
                    {
                      backgroundColor: isDark
                        ? 'rgba(255,255,255,0.12)'
                        : 'rgba(0,0,0,0.06)',
                    },
                  ]}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.editButtonText,
                      { color: theme.colors.primary },
                    ]}
                  >
                    {isEditing ? 'Done' : 'Edit'}
                  </Text>
                </TouchableOpacity>

                <Text
                  variant="displaySmall"
                  style={[styles.headerTitle, { color: theme.colors.onSurface }]}
                >
                  Calls
                </Text>

                <TouchableOpacity
                  onPress={() => {
                    lightHaptic();
                    setSearchQuery('');
                    setShowNewCallSheet(true);
                  }}
                  style={[
                    styles.newCallButton,
                    {
                      backgroundColor: isDark
                        ? 'rgba(255,255,255,0.12)'
                        : 'rgba(0,0,0,0.06)',
                    },
                  ]}
                  activeOpacity={0.7}
                >
                  <MaterialCommunityIcons
                    name="phone-plus-outline"
                    size={22}
                    color={theme.colors.primary}
                  />
                </TouchableOpacity>
              </View>

              {/* Filter chips: All | Missed (Apple style segmented) */}
              <View style={styles.filterRow}>
                <View
                  style={[
                    styles.segmentedControl,
                    {
                      backgroundColor: isDark
                        ? 'rgba(255,255,255,0.08)'
                        : 'rgba(0,0,0,0.06)',
                    },
                  ]}
                >
                  <TouchableOpacity
                    onPress={() => {
                      lightHaptic();
                      setFilter('all');
                    }}
                    style={[
                      styles.segment,
                      filter === 'all' && {
                        backgroundColor: isDark
                          ? 'rgba(255,255,255,0.15)'
                          : 'rgba(255,255,255,0.9)',
                      },
                      filter === 'all' && styles.segmentActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        {
                          color:
                            filter === 'all'
                              ? theme.colors.primary
                              : theme.colors.onSurfaceVariant,
                        },
                        filter === 'all' && styles.segmentTextActive,
                      ]}
                    >
                      All
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      lightHaptic();
                      setFilter('missed');
                    }}
                    style={[
                      styles.segment,
                      filter === 'missed' && {
                        backgroundColor: isDark
                          ? 'rgba(255,255,255,0.15)'
                          : 'rgba(255,255,255,0.9)',
                      },
                      filter === 'missed' && styles.segmentActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        {
                          color:
                            filter === 'missed'
                              ? theme.colors.primary
                              : theme.colors.onSurfaceVariant,
                        },
                        filter === 'missed' && styles.segmentTextActive,
                      ]}
                    >
                      Missed
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Clear all button in edit mode */}
              {isEditing && callHistory.length > 0 && (
                <Animated.View
                  entering={FadeIn.duration(200)}
                  exiting={FadeOut.duration(150)}
                >
                  <TouchableOpacity
                    onPress={handleClearAll}
                    style={styles.clearAllButton}
                  >
                    <Text style={{ color: theme.colors.error, fontWeight: '600' }}>
                      Clear All Recents
                    </Text>
                  </TouchableOpacity>
                </Animated.View>
              )}
            </View>
          }
          onScroll={RNAnimated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <MaterialCommunityIcons
                name="phone-off"
                size={64}
                color={theme.colors.onSurfaceVariant}
                style={{ opacity: 0.5 }}
              />
              <Text
                style={[styles.emptyTitle, { color: theme.colors.onSurface }]}
              >
                No Recent Calls
              </Text>
              <Text
                style={[
                  styles.emptySubtitle,
                  { color: theme.colors.onSurfaceVariant },
                ]}
              >
                {filter === 'missed'
                  ? 'No missed calls to show.'
                  : 'Your call history will appear here.'}
              </Text>
            </View>
          }
        />
      </View>

      {/* New Call Bottom Sheet */}
      <Modal
        visible={showNewCallSheet}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setShowNewCallSheet(false)}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
          <View style={styles.sheetOverlay}>
            <Pressable
              style={styles.sheetBackdrop}
              onPress={() => setShowNewCallSheet(false)}
            />

            <GestureDetector gesture={sheetGesture}>
              <Animated.View
                entering={SlideInDown.springify().damping(30).stiffness(350).mass(1)}
                style={[styles.sheetContainer, sheetAnimatedStyle]}
              >
                {Platform.OS === 'ios' && (
                  <BlurView
                    intensity={80}
                    tint={isDark ? 'dark' : 'light'}
                    style={StyleSheet.absoluteFill}
                    pointerEvents="none"
                  />
                )}
                <View
                  style={[
                    styles.sheetInner,
                    {
                      backgroundColor: isDark
                        ? Platform.OS === 'ios' ? 'rgba(30,30,40,0.35)' : 'rgba(30,30,40,0.92)'
                        : Platform.OS === 'ios' ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.95)',
                    },
                  ]}
                >
                  {/* Handle bar */}
                  <View style={styles.sheetHandle}>
                    <View
                      style={[
                        styles.sheetHandleBar,
                        {
                          backgroundColor: isDark
                            ? 'rgba(255,255,255,0.3)'
                            : 'rgba(0,0,0,0.2)',
                        },
                      ]}
                    />
                  </View>

                  {/* Sheet header */}
                  <View style={styles.sheetHeader}>
                    <Text style={[styles.sheetTitle, { color: theme.colors.onSurface }]}>
                      New Call
                    </Text>
                    <TouchableOpacity
                      onPress={() => setShowNewCallSheet(false)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <MaterialCommunityIcons
                        name="close-circle"
                        size={26}
                        color={theme.colors.onSurfaceVariant}
                      />
                    </TouchableOpacity>
                  </View>

                  {/* Search bar */}
                  <View style={styles.sheetSearchRow}>
                    <TextInput
                      placeholder="Search contacts..."
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      mode="outlined"
                      dense
                      left={<TextInput.Icon icon="magnify" />}
                      style={styles.sheetSearchInput}
                      outlineStyle={{ borderRadius: 12 }}
                    />
                  </View>

                  {/* Thread list */}
                  <FlatList
                    data={filteredThreads}
                    keyExtractor={(item) => item.chatId}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={styles.sheetListContent}
                    ListEmptyComponent={
                      <View style={styles.sheetEmpty}>
                        <Text style={{ color: theme.colors.onSurfaceVariant }}>
                          {searchQuery
                            ? 'No contacts found.'
                            : 'No conversations yet. Start a chat first.'}
                        </Text>
                      </View>
                    }
                    renderItem={({ item: thread }) => {
                      const name = getThreadDisplayName(thread);
                      const photo = getThreadPhoto(thread);
                      const initials = getThreadInitials(thread);

                      return (
                        <View style={styles.sheetItem}>
                          {photo ? (
                            <Avatar.Image size={44} source={{ uri: photo }} />
                          ) : (
                            <Avatar.Text
                              size={44}
                              label={initials}
                              style={{ backgroundColor: theme.colors.primary }}
                              color={theme.colors.onPrimary}
                            />
                          )}
                          <View style={styles.sheetItemCenter}>
                            <Text
                              style={[styles.sheetItemName, { color: theme.colors.onSurface }]}
                              numberOfLines={1}
                            >
                              {name}
                            </Text>
                            {thread.groupId && (
                              <Text
                                style={[styles.sheetItemSub, { color: theme.colors.onSurfaceVariant }]}
                                numberOfLines={1}
                              >
                                Group · {thread.participants.length} members
                              </Text>
                            )}
                          </View>
                          <TouchableOpacity
                            onPress={() => {
                              lightHaptic();
                              setShowNewCallSheet(false);
                              onStartCall(thread, 'audio');
                            }}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={styles.sheetCallBtn}
                          >
                            <MaterialCommunityIcons
                              name="phone-outline"
                              size={22}
                              color={theme.colors.primary}
                            />
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => {
                              lightHaptic();
                              setShowNewCallSheet(false);
                              onStartCall(thread, 'video');
                            }}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={styles.sheetCallBtn}
                          >
                            <MaterialCommunityIcons
                              name="video-outline"
                              size={22}
                              color={theme.colors.primary}
                            />
                          </TouchableOpacity>
                        </View>
                      );
                    }}
                  />
                </View>
              </Animated.View>
            </GestureDetector>
          </View>
        </GestureHandlerRootView>
      </Modal>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    padding: 16,
  },
  // -- Header --
  headerContainer: {
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    zIndex: 10,
  },
  headerTitle: {
    fontWeight: 'bold',
  },
  editButton: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 50,
    zIndex: 10,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  editButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  newCallButton: {
    width: 42,
    height: 42,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  // -- Segmented Control --
  filterRow: {
    alignItems: 'center',
    marginBottom: 16,
  },
  segmentedControl: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
    width: 200,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 7,
    borderRadius: 8,
  },
  segmentActive: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '500',
  },
  segmentTextActive: {
    fontWeight: '600',
  },
  // -- Clear All --
  clearAllButton: {
    alignItems: 'center',
    paddingVertical: 10,
    marginBottom: 8,
  },
  // -- Section --
  sectionHeader: {
    paddingHorizontal: 8,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  // -- Call Item --
  callItem: {
    marginBottom: 2,
    borderRadius: 14,
    overflow: 'hidden',
  },
  callItemContent: {
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  callRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  leftSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  deleteCircle: {
    marginRight: 2,
  },
  centerSection: {
    flex: 1,
    marginLeft: 12,
    justifyContent: 'center',
  },
  callName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 2,
  },
  callMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  callSubtitle: {
    fontSize: 13,
  },
  rightSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  callTime: {
    fontSize: 14,
  },
  // -- Swipe Delete --
  deleteAction: {
    backgroundColor: '#E03C31',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    borderRadius: 14,
    marginBottom: 2,
    marginLeft: 8,
  },
  deleteActionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  // -- Sticky Header --
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
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
  // -- Empty State --
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  emptySubtitle: {
    fontSize: 15,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  // -- New Call Sheet --
  sheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheetContainer: {
    maxHeight: '75%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderBottomWidth: 0,
  },
  sheetInner: {
    paddingBottom: 40,
  },
  sheetHandle: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 4,
  },
  sheetHandleBar: {
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  sheetSearchRow: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  sheetSearchInput: {
    fontSize: 15,
  },
  sheetListContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 12,
  },
  sheetItemCenter: {
    flex: 1,
  },
  sheetItemName: {
    fontSize: 16,
    fontWeight: '600',
  },
  sheetItemSub: {
    fontSize: 13,
    marginTop: 1,
  },
  sheetCallBtn: {
    padding: 8,
  },
  sheetEmpty: {
    alignItems: 'center',
    paddingTop: 40,
  },
});
