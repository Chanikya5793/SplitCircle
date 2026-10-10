import { FONT_CAP } from '@/utils/a11yText';
import { BalanceHeadline } from '@/components/BalanceHeadline';
import { GlassView } from '@/components/GlassView';
import { clearOpenSwipeable, setOpenSwipeable } from '@/utils/swipeableRegistry';
import { StickyHeaderPill, TRANSPARENT_HEADER_CLEARANCE } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { getFloatingTabBarContentPadding } from '@/components/tabbar/tabBarMetrics';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useCallContext } from '@/context/CallContext';
import { useChat } from '@/context/ChatContext';
import { useGroups, useRealGroups } from '@/context/GroupContext';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import { useTheme } from '@/context/ThemeContext';
import { usePressFeedback } from '@/hooks/usePressFeedback';
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
import { resolveDisplayName, resolveInitials } from '@/utils/identity';
import { formatCurrency } from '@/utils/currency';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { appAlert } from '@/utils/appAlert';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { Avatar, Icon, IconButton, Text } from 'react-native-paper';
import { Shield } from '@/components/ui';
import { TouchableRipple } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface FriendRow {
  friend: Friend;
  /** What the screen shows — disguised while the Privacy Guard says so. */
  displayName: string;
  /** The real name, for writes only (chat participants). Never rendered. */
  realName: string;
  photoURL?: string;
  balances: CurrencyAmount[];
}

const formatBalance = (amount: number, currency: string): string => {
  const abs = Math.abs(amount);
  // Whole units from 10 up keeps the row short; below that the cents matter.
  // Locale-formatted with the currency's own symbol ("₹14,958", "$13") — the
  // old "INR 14958" had neither a symbol nor digit grouping.
  if (abs < 10) return formatCurrency(abs, currency);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(Math.round(abs));
  } catch {
    return formatCurrency(abs, currency);
  }
};

const compareLastInteraction = (a: FriendRow, b: FriendRow): number => {
  const ax = a.friend.lastInteractionAt ?? a.friend.since;
  const bx = b.friend.lastInteractionAt ?? b.friend.since;
  return bx - ax;
};

/**
 * Swipe-left wrapper for a friend row. Reveals Pin/Unpin and Remove actions —
 * mirrors the SwipeableChatRow gesture so the whole app speaks the same swipe
 * language. Both actions call the exact same handlers as the inline UI.
 */
const SwipeableFriendRow = ({
  isPinned,
  onTogglePin,
  onRemove,
  children,
}: {
  isPinned: boolean;
  onTogglePin: () => void;
  onRemove: () => void;
  children: ReactNode;
}) => {
  const swipeableRef = useRef<Swipeable>(null);
  const { theme } = useTheme();

  const renderRightActions = () => (
    <View style={styles.rowActionContainer}>
      <RectButton
        style={[styles.rowActionButton, { backgroundColor: theme.colors.primary }]}
        accessibilityLabel={isPinned ? 'Unpin friend' : 'Pin friend'}
        accessibilityRole="button"
        onPress={() => {
          swipeableRef.current?.close();
          onTogglePin();
        }}
      >
        <Icon source={isPinned ? 'pin' : 'pin-outline'} color={theme.colors.onPrimary} size={22} />
        <Text style={[styles.rowActionText, { color: theme.colors.onPrimary }]}>{isPinned ? 'Unpin' : 'Pin'}</Text>
      </RectButton>
      <RectButton
        style={[styles.rowActionButton, { backgroundColor: theme.colors.danger }]}
        accessibilityLabel="Remove friend"
        accessibilityRole="button"
        onPress={() => {
          swipeableRef.current?.close();
          onRemove();
        }}
      >
        <Icon source="trash-can-outline" color={theme.colors.onDanger} size={22} />
        <Text style={[styles.rowActionText, { color: theme.colors.onDanger }]}>Remove</Text>
      </RectButton>
    </View>
  );

  return (
    <Swipeable
      ref={swipeableRef}
      onSwipeableClose={() => clearOpenSwipeable(swipeableRef.current)}
      renderRightActions={renderRightActions}
      friction={2}
      rightThreshold={40}
      overshootFriction={8}
      onSwipeableWillOpen={() => { lightHaptic(); setOpenSwipeable(swipeableRef.current); }}
    >
      {children}
    </Swipeable>
  );
};

export const FriendsScreen = () => {
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const { theme } = useTheme();
  const { pressHighlightStyle, touchableProps } = usePressFeedback();
  // Names come from the REAL groups and go through maskPersonName (so a friend
  // reads the same as in every group, and nothing is masked twice); balances
  // come from useGroups, which in the duress decoy world is already the scaled
  // decoy ledger, so they add up to what the group screens show.
  const { groups } = useGroups();
  const { groups: realGroups } = useRealGroups();
  const { duress: guardDuress, isShielded: guardIsShielded } = usePrivacyGuard();
  const { maskPersonName, hidePhoto } = usePrivacyMask();
  const fmtMoney = useMoneyDisplay();
  const maskAmounts = guardIsShielded('expenses') && !guardDuress;
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
    // Offline cold start: RTDB may never call back — stop the spinner after a
    // grace period so the screen shows its empty state instead of hanging.
    const timeout = setTimeout(() => setLoading(false), 8000);
    const unsubscribe = subscribeToFriends(user.userId, (next) => {
      setFriends(next.filter((f) => !f.hidden));
      setLoading(false);
      clearTimeout(timeout);
    });
    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [user?.userId]);

  // Lookup name + photo for each friend across ALL groups, including
  // groups where they're now an archived (former) member. Without falling
  // back to archivedMembers, someone removed from your last shared group
  // would render as the literal string "Friend" with their balance still
  // intact — exactly the inconsistency we're closing.
  const memberLookup = useMemo(() => {
    const map = new Map<string, GroupMember>();
    for (const group of realGroups) {
      for (const member of group.members ?? []) {
        if (!map.has(member.userId)) map.set(member.userId, member);
      }
    }
    // Archived members are a fallback only — never overwrite an active
    // membership which has fresher displayName/photo.
    for (const group of realGroups) {
      for (const member of group.archivedMembers ?? []) {
        if (!map.has(member.userId)) map.set(member.userId, member);
      }
    }
    return map;
  }, [realGroups]);

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
      const realName = resolveDisplayName(member, resolveDisplayName(friend, 'Removed user'));
      const displayName = maskPersonName(realName);
      const photoURL = hidePhoto() ? undefined : member?.photoURL || friend.photoURL;
      return {
        friend,
        displayName,
        realName,
        photoURL,
        balances: balanceMap[friend.userId] ?? [],
      };
    });
  }, [friends, memberLookup, balanceMap, maskPersonName, hidePhoto]);

  // Opportunistically refresh the denormalized snapshot on the friend record
  // whenever we see fresher info from a current group. Runs at most once per
  // (friendUid, name, photo) tuple to keep RTDB writes minimal.
  const lastSnapshotRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!user?.userId) return;
    // In the duress decoy world the group members are disguised — writing
    // them back would store fake names on the real friend records.
    if (guardDuress) return;
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
  }, [rows, memberLookup, user?.userId, guardDuress]);

  const sections = useMemo(() => {
    const pinned: FriendRow[] = [];
    const owesYou: FriendRow[] = [];
    const youOwe: FriendRow[] = [];
    const settled: FriendRow[] = [];
    for (const row of rows) {
      if (row.friend.isPinned) {
        pinned.push(row);
        continue;
      }
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

  // Slide the glass pill in with a TRANSFORM (not opacity): fractional alpha
  // on an ancestor kills UIVisualEffectView materials (see StickyHeaderPill).
  const headerTranslate = scrollY.interpolate({
    inputRange: [0, 60],
    outputRange: [-160, 0],
    extrapolate: 'clamp',
  });

  const openDirectChat = async (row: FriendRow) => {
    if (!user) return;
    lightHaptic();
    try {
      const chatId = await ensureDirectThread({
        userId: row.friend.userId,
        // Real name: this may create the chat doc both people share.
        displayName: row.realName,
        photoURL: row.photoURL,
        status: 'online',
      });
      navigation.navigate(ROUTES.APP.GROUP_CHAT, {
        chatId,
        initialTitle: row.displayName,
        backTitle: ROOT_SCREEN_TITLES.friends,
      });
    } catch (error) {
      // console.error, not warn: a Release bundle drops warn entirely
      // (CLAUDE.md), and this failure was reported from a TestFlight build with
      // no log to go on.
      console.error('Failed to open direct chat', error);
      // The real reason, not "try again in a moment" — retrying could never
      // help for the malformed-write failure this used to hide, and telling
      // someone to retry a thing that cannot succeed wastes their time and
      // buries the bug.
      appAlert(
        'Could not open chat',
        'The conversation could not be prepared. Try again from this person’s row.',
      );
    }
  };

  const callFriend = async (row: FriendRow, type: 'audio' | 'video') => {
    if (!user) return;
    selectionHaptic();
    try {
      const chatId = await ensureDirectThread({
        userId: row.friend.userId,
        // Real name: this may create the chat doc both people share.
        displayName: row.realName,
        photoURL: row.photoURL,
        status: 'online',
      });
      startCallSession({ chatId, type });
    } catch (error) {
      // Calling a friend also goes through `ensureDirectThread`, so the
      // undefined-photoURL write failure broke CALLS to anyone you had never
      // chatted with too — a third symptom of the same root cause, hidden
      // behind the same unhelpful "try again" copy.
      console.error('Failed to start call to friend', error);
      appAlert(
        'Could not place call',
        'The call could not start. Check your connection and try again.',
      );
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
    appAlert(
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
        ? theme.colors.moneyPositive
        : theme.colors.moneyNegative;
    const balanceText = row.balances.length === 0
      ? 'Settled up'
      : row.balances
        .map((b) => (maskAmounts ? fmtMoney(Math.abs(b.amount), b.currency) : formatBalance(b.amount, b.currency)))
        .join(' · ');

    return (
      <SwipeableFriendRow
        key={row.friend.userId}
        isPinned={!!row.friend.isPinned}
        onTogglePin={() => togglePin(row)}
        onRemove={() => handleRemove(row)}
      >
      <GlassView style={styles.rowCard}>
        <Reanimated.View style={[styles.row, pressHighlightStyle]}>
          {/* Avatar opens the friend profile — previously FriendInfoScreen
              had no entry point from this list at all. */}
          <TouchableRipple
            onPress={() => {
              lightHaptic();
              navigation.navigate(ROUTES.APP.FRIEND_INFO, {
                userId: row.friend.userId,
                displayName: row.displayName,
                photoURL: row.photoURL,
                backTitle: ROOT_SCREEN_TITLES.friends,
              });
            }}
            accessibilityRole="button"
            accessibilityLabel={`View ${row.displayName}'s profile`}
            borderless
            style={{ borderRadius: 24 }}
          >
            {row.photoURL ? (
              <Avatar.Image size={48} source={{ uri: row.photoURL }} />
            ) : (
              <Avatar.Text
                size={48}
                label={resolveInitials(row.displayName)}
                style={{ backgroundColor: theme.colors.primary }}
                color={theme.colors.onPrimary}
                maxFontSizeMultiplier={FONT_CAP.avatarMonogram}
              />
            )}
          </TouchableRipple>
          <TouchableRipple
            onPress={() => openDirectChat(row)}
            onLongPress={() => handleRemove(row)}
            borderless
            style={styles.rowText}
            accessibilityRole="button"
            accessibilityLabel={`Open chat with ${row.displayName}, ${sum > 0 ? `owes you ${balanceText}` : sum < 0 ? `you owe ${balanceText}` : balanceText}`}
            {...touchableProps}
          >
            <View>
              <Text variant="titleMedium" style={[styles.rowName, { color: theme.colors.onSurface }]} numberOfLines={1}>
                {row.displayName}
              </Text>
              <Text variant="bodySmall" style={[styles.rowSub, { color: balanceColor }]} numberOfLines={2}>
                {sum > 0 ? `Owes you ${balanceText}` : sum < 0 ? `You owe ${balanceText}` : balanceText}
              </Text>
            </View>
          </TouchableRipple>
          <View style={styles.rowActions}>
              <IconButton
                icon={row.friend.isPinned ? 'pin' : 'pin-outline'}
                size={20}
                style={styles.rowIconButton}
                onPress={() => togglePin(row)}
                accessibilityLabel={row.friend.isPinned ? 'Unpin friend' : 'Pin friend'}
              />
              <IconButton
                icon="phone"
                size={20}
                style={styles.rowIconButton}
                onPress={() => callFriend(row, 'audio')}
                accessibilityLabel="Audio call"
              />
              <IconButton
                icon="video"
                size={20}
                style={styles.rowIconButton}
                onPress={() => callFriend(row, 'video')}
                accessibilityLabel="Video call"
              />
          </View>
        </Reanimated.View>
      </GlassView>
      </SwipeableFriendRow>
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

  const friendList = (
    <Animated.ScrollView
      contentContainerStyle={[
        styles.container,
        { paddingTop: insets.top + TRANSPARENT_HEADER_CLEARANCE, paddingBottom: bottomPadding },
      ]}
      onScroll={Animated.event(
        [{ nativeEvent: { contentOffset: { y: scrollY } } }],
        { useNativeDriver: true },
      )}
      scrollEventThrottle={16}
    >
      <View style={styles.headerContainer}>
        <Text variant="displaySmall" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
          Friends
        </Text>
        {/* Same on-device computation as the Expenses screen — see
            components/BalanceHeadline. */}
        <BalanceHeadline style={{ marginTop: 8 }} />
      </View>

      {rows.length === 0 && !loading ? (
        <GlassView style={styles.emptyCard}>
          <Text style={[styles.emptyTitle, { color: theme.colors.onSurface }]}>No friends yet</Text>
          <Text style={[styles.emptyBody, { color: theme.colors.onSurfaceVariant }]}>
            People appear here after you share a group or split an expense with them.
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
  );

  return (
    <LiquidBackground>
      <Animated.View
        style={[styles.stickyHeader, { transform: [{ translateY: headerTranslate }], paddingTop: insets.top + 8 }]}
      >
        <StickyHeaderPill style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
            Friends
          </Text>
        </StickyHeaderPill>
      </Animated.View>

      {/* Duress: the list renders — names, photos and balances below are all
      disguised (maskPersonName / decoy ledger), and an empty Friends page next
      to groups full of people would contradict the decoy world. */}
      <Shield
        target="friends"
        duressFallback={friendList}
      >
      {friendList}
      </Shield>
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
    // Tightened 8 -> 6 (2026-08-07, compact density pass), matching the
    // baseline set on SwipeableGroupCard/ChatThreadRow.
    marginBottom: 6,
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
  // Paper's default 6pt margin around each 40pt button took 156pt from three
  // of them, cutting names to "Alexandria Mo…". The 40pt target stays.
  rowIconButton: {
    margin: 0,
  },
  rowActionContainer: {
    flexDirection: 'row',
    // Must stay equal to rowCard's marginBottom or the swipe action drifts
    // out of alignment with the row.
    marginBottom: 6,
    borderRadius: 18,
    overflow: 'hidden',
  },
  rowActionButton: {
    width: 76,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rowActionText: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
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
