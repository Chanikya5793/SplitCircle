import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { getFloatingTabBarContentPadding } from '@/components/tabbar/tabBarMetrics';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useCallContext } from '@/context/CallContext';
import { useChat } from '@/context/ChatContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { GroupMember } from '@/models';
import { ROOT_SCREEN_TITLES } from '@/navigation/screenTitles';
import { useSyncRootStackTitle } from '@/navigation/useSyncRootStackTitle';
import {
  removeFriend,
  setFriendPinned,
  subscribeToFriends,
  updateFriendSnapshot,
  type Friend,
} from '@/services/friendsService';
import { computeFriendBalances, type CurrencyAmount } from '@/utils/friendBalances';
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, RefreshControl, StyleSheet, View } from 'react-native';
import { Avatar, IconButton, Text } from 'react-native-paper';
import { TouchableRipple } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface FriendRow {
  friend: Friend;
  displayName: string;
  photoURL?: string;
  balances: CurrencyAmount[];
}

const formatBalance = (amount: number, currency: string): string => {
  const abs = Math.abs(amount);
  // Two decimal places only for sub-$10 amounts; otherwise integer for cleanliness.
  const formatted = abs >= 10 ? abs.toFixed(0) : abs.toFixed(2);
  return `${currency} ${formatted}`;
};

const compareLastInteraction = (a: FriendRow, b: FriendRow): number => {
  const ax = a.friend.lastInteractionAt ?? a.friend.since;
  const bx = b.friend.lastInteractionAt ?? b.friend.since;
  return bx - ax;
};

export const FriendsScreen = () => {
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const { theme } = useTheme();
  const { groups } = useGroups();
  const { ensureDirectThread } = useChat();
  const { startCallSession } = useCallContext();
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const bottomPadding = getFloatingTabBarContentPadding(insets.bottom, 56);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);

  useSyncRootStackTitle(ROOT_SCREEN_TITLES.friends);

  useLayoutEffect(() => {
    navigation.setOptions({ headerTitle: '', headerTransparent: true });
  }, [navigation]);

  useEffect(() => {
    if (!user?.userId) {
      setFriends([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsubscribe = subscribeToFriends(user.userId, (next) => {
      setFriends(next.filter((f) => !f.hidden));
      setLoading(false);
    });
    return unsubscribe;
  }, [user?.userId]);

  // Lookup name + photo for each friend across ALL groups, including
  // groups where they're now an archived (former) member. Without falling
  // back to archivedMembers, someone removed from your last shared group
  // would render as the literal string "Friend" with their balance still
  // intact — exactly the inconsistency we're closing.
  const memberLookup = useMemo(() => {
    const map = new Map<string, GroupMember>();
    for (const group of groups) {
      for (const member of group.members ?? []) {
        if (!map.has(member.userId)) map.set(member.userId, member);
      }
    }
    // Archived members are a fallback only — never overwrite an active
    // membership which has fresher displayName/photo.
    for (const group of groups) {
      for (const member of group.archivedMembers ?? []) {
        if (!map.has(member.userId)) map.set(member.userId, member);
      }
    }
    return map;
  }, [groups]);

  const balanceMap = useMemo(
    () => (user?.userId ? computeFriendBalances(user.userId, groups) : {}),
    [user?.userId, groups],
  );

  const rows = useMemo<FriendRow[]>(() => {
    return friends.map((friend) => {
      const member = memberLookup.get(friend.userId);
      // Resolution order: live group member > archived group member (already
      // folded into memberLookup) > the snapshot stored on the friend record
      // itself > a final last-resort label so we never render the literal
      // string "Friend" as a name.
      const displayName =
        member?.displayName?.trim() ||
        friend.displayName?.trim() ||
        'Removed user';
      const photoURL = member?.photoURL || friend.photoURL;
      return {
        friend,
        displayName,
        photoURL,
        balances: balanceMap[friend.userId] ?? [],
      };
    });
  }, [friends, memberLookup, balanceMap]);

  // Opportunistically refresh the denormalized snapshot on the friend record
  // whenever we see fresher info from a current group. Runs at most once per
  // (friendUid, name, photo) tuple to keep RTDB writes minimal.
  const lastSnapshotRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!user?.userId) return;
    for (const row of rows) {
      const live = memberLookup.get(row.friend.userId);
      const liveName = live?.displayName?.trim();
      const livePhoto = live?.photoURL?.trim();
      if (!liveName) continue; // Nothing better than what's already stored.
      const fingerprint = `${liveName}|${livePhoto ?? ''}`;
      const last = lastSnapshotRef.current.get(row.friend.userId);
      if (last === fingerprint) continue;
      const stored = `${row.friend.displayName ?? ''}|${row.friend.photoURL ?? ''}`;
      if (stored === fingerprint) {
        // Already in sync — record so we don't re-check next render.
        lastSnapshotRef.current.set(row.friend.userId, fingerprint);
        continue;
      }
      lastSnapshotRef.current.set(row.friend.userId, fingerprint);
      void updateFriendSnapshot(user.userId, row.friend.userId, {
        displayName: liveName,
        photoURL: livePhoto,
      });
    }
  }, [rows, memberLookup, user?.userId]);

  const sections = useMemo(() => {
    const pinned: FriendRow[] = [];
    const owesYou: FriendRow[] = [];
    const youOwe: FriendRow[] = [];
    const settled: FriendRow[] = [];
    for (const row of rows) {
      if (row.friend.isPinned) pinned.push(row);
      const sum = row.balances.reduce((s, b) => s + b.amount, 0);
      if (Math.abs(sum) < 0.01) settled.push(row);
      else if (sum > 0) owesYou.push(row);
      else youOwe.push(row);
    }
    return {
      pinned: pinned.sort(compareLastInteraction),
      owesYou: owesYou.sort(compareLastInteraction),
      youOwe: youOwe.sort(compareLastInteraction),
      settled: settled.sort(compareLastInteraction),
    };
  }, [rows]);

  const headerOpacity = scrollY.interpolate({ inputRange: [0, 40], outputRange: [0, 1], extrapolate: 'clamp' });

  const openDirectChat = async (row: FriendRow) => {
    if (!user) return;
    lightHaptic();
    try {
      const chatId = await ensureDirectThread({
        userId: row.friend.userId,
        displayName: row.displayName,
        photoURL: row.photoURL,
        status: 'online',
      });
      navigation.navigate(ROUTES.APP.GROUP_CHAT, {
        chatId,
        initialTitle: row.displayName,
        backTitle: ROOT_SCREEN_TITLES.friends,
      });
    } catch (error) {
      console.warn('Failed to open direct chat', error);
      Alert.alert('Could not open chat', 'Please try again in a moment.');
    }
  };

  const callFriend = async (row: FriendRow, type: 'audio' | 'video') => {
    if (!user) return;
    selectionHaptic();
    try {
      const chatId = await ensureDirectThread({
        userId: row.friend.userId,
        displayName: row.displayName,
        photoURL: row.photoURL,
        status: 'online',
      });
      startCallSession({ chatId, type });
    } catch (error) {
      console.warn('Failed to start call to friend', error);
      Alert.alert('Could not place call', 'Please try again in a moment.');
    }
  };

  const togglePin = async (row: FriendRow) => {
    if (!user) return;
    selectionHaptic();
    try {
      await setFriendPinned(user.userId, row.friend.userId, !row.friend.isPinned);
    } catch (error) {
      console.warn('Failed to toggle pin', error);
    }
  };

  const handleRemove = (row: FriendRow) => {
    if (!user) return;
    Alert.alert(
      `Remove ${row.displayName}?`,
      'They’ll be removed from your friends list. If you share groups or have outstanding balances, they’ll come back as soon as those are recorded again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try { await removeFriend(user.userId, row.friend.userId); }
            catch (error) { console.warn('removeFriend failed', error); }
          },
        },
      ],
    );
  };

  const renderRow = (row: FriendRow) => {
    const sum = row.balances.reduce((s, b) => s + b.amount, 0);
    const balanceColor = Math.abs(sum) < 0.01
      ? theme.colors.onSurfaceVariant
      : sum > 0
        ? '#10B981'
        : '#EF4444';
    const balanceText = row.balances.length === 0
      ? 'Settled up'
      : row.balances.map((b) => formatBalance(b.amount, b.currency)).join(' · ');

    return (
      <GlassView key={row.friend.userId} style={styles.rowCard}>
        <TouchableRipple onPress={() => openDirectChat(row)} onLongPress={() => handleRemove(row)} borderless>
          <View style={styles.row}>
            {row.photoURL ? (
              <Avatar.Image size={48} source={{ uri: row.photoURL }} />
            ) : (
              <Avatar.Text
                size={48}
                label={(row.displayName || 'F').slice(0, 2).toUpperCase()}
                style={{ backgroundColor: theme.colors.primary }}
                color={theme.colors.onPrimary}
              />
            )}
            <View style={styles.rowText}>
              <Text variant="titleMedium" style={[styles.rowName, { color: theme.colors.onSurface }]} numberOfLines={1}>
                {row.displayName}
              </Text>
              <Text variant="bodySmall" style={[styles.rowSub, { color: balanceColor }]} numberOfLines={1}>
                {sum > 0 ? `Owes you ${balanceText}` : sum < 0 ? `You owe ${balanceText}` : balanceText}
              </Text>
            </View>
            <View style={styles.rowActions}>
              <IconButton
                icon={row.friend.isPinned ? 'pin' : 'pin-outline'}
                size={20}
                onPress={() => togglePin(row)}
                accessibilityLabel={row.friend.isPinned ? 'Unpin friend' : 'Pin friend'}
              />
              <IconButton
                icon="phone"
                size={20}
                onPress={() => callFriend(row, 'audio')}
                accessibilityLabel="Audio call"
              />
              <IconButton
                icon="video"
                size={20}
                onPress={() => callFriend(row, 'video')}
                accessibilityLabel="Video call"
              />
            </View>
          </View>
        </TouchableRipple>
      </GlassView>
    );
  };

  const renderSection = (title: string, items: FriendRow[]) => {
    if (items.length === 0) return null;
    return (
      <View style={styles.section}>
        <Text variant="labelLarge" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
          {title}
        </Text>
        {items.map(renderRow)}
      </View>
    );
  };

  return (
    <LiquidBackground>
      <Animated.View
        style={[styles.stickyHeader, { opacity: headerOpacity, paddingTop: insets.top + 8 }]}
      >
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
            Friends
          </Text>
        </GlassView>
      </Animated.View>

      <Animated.ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingTop: insets.top + 24, paddingBottom: bottomPadding },
        ]}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
        scrollEventThrottle={16}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => undefined} tintColor={theme.colors.primary} />}
      >
        <View style={styles.headerContainer}>
          <Text variant="displaySmall" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
            Friends
          </Text>
        </View>

        {rows.length === 0 && !loading ? (
          <GlassView style={styles.emptyCard}>
            <Text style={[styles.emptyTitle, { color: theme.colors.onSurface }]}>No friends yet</Text>
            <Text style={[styles.emptyBody, { color: theme.colors.onSurfaceVariant }]}>
              You’ll see people here once you share a group, split an expense, or add someone manually.
            </Text>
          </GlassView>
        ) : (
          <>
            {renderSection('Pinned', sections.pinned)}
            {renderSection('Owes you', sections.owesYou)}
            {renderSection('You owe', sections.youOwe)}
            {renderSection('Settled up', sections.settled)}
          </>
        )}
      </Animated.ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
  },
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
  headerContainer: {
    paddingBottom: 16,
  },
  section: {
    marginBottom: 18,
  },
  sectionTitle: {
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginLeft: 4,
  },
  rowCard: {
    borderRadius: 18,
    overflow: 'hidden',
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 12,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontWeight: '600',
  },
  rowSub: {
    marginTop: 2,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  emptyCard: {
    borderRadius: 18,
    padding: 20,
    alignItems: 'center',
    gap: 6,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  emptyBody: {
    textAlign: 'center',
    lineHeight: 20,
  },
});
