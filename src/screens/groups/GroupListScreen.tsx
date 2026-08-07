import { FloatingLabelInput } from '@/components/FloatingLabelInput';
import { GlassView } from '@/components/GlassView';
import { GlassCard, ListSeparator, StickyHeaderPill } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { PrimaryButton } from '@/components/PrimaryButton';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { GroupCardSkeleton } from '@/components/SkeletonLoader';
import { SwipeableGroupCard } from '@/components/SwipeableGroupCard';
import { ArchivedFolderRow } from '@/components/ArchivedFolderRow';
import { GroupFilterSortSheet, GroupSortField, GroupSortOrder } from '@/components/GroupFilterSortSheet';
import {
  getFloatingTabBarContentPadding,
  getFloatingTabBarEnvelopeHeight,
} from '@/components/tabbar/tabBarMetrics';
import { CURRENCIES } from '@/constants/currencies';
import { ROUTES } from '@/constants/routes';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { archiveGroup } from '@/services/archiveService';
import { useTheme } from '@/context/ThemeContext';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import type { Group } from '@/models';
import { ROOT_SCREEN_TITLES } from '@/navigation/screenTitles';
import { useSyncRootStackTitle } from '@/navigation/useSyncRootStackTitle';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { appAlert } from '@/utils/appAlert';
import { Button, Text, IconButton, Chip, TouchableRipple } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface GroupListScreenProps {
  onOpenGroup: (group: Group) => void;
}

export const GroupListScreen = ({ onOpenGroup }: GroupListScreenProps) => {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { groups, loading, createGroup, joinGroup } = useGroups();
  const { user } = useAuth();
  const { isOnline } = useOfflineSync();
  const { theme, isDark } = useTheme();
  const { isShielded: guardIsShielded, isVanished: guardIsVanished, duress: guardDuress } = usePrivacyGuard();
  // Creating/joining expense groups is blocked while expenses are hidden —
  // but not in duress, where a disabled button would betray the fake unlock.
  const groupsShielded = guardIsShielded('expenses') && !guardDuress;
  const [dialog, setDialog] = useState<'create' | 'join' | null>(null);
  const [name, setName] = useState('');
  const [currencyInput, setCurrencyInput] = useState('USD');
  const [showCurrencyList, setShowCurrencyList] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const scrollY = useRef(new Animated.Value(0)).current;
  const [openingGroupId, setOpeningGroupId] = useState<string | null>(null);

  // Filter & Sort State
  const [filterVisible, setFilterVisible] = useState(false);
  const [sortField, setSortField] = useState<GroupSortField>('updatedAt');
  const [sortOrder, setSortOrder] = useState<GroupSortOrder>('desc');
  const [selectedCurrencies, setSelectedCurrencies] = useState<string[]>([]);
  useSyncRootStackTitle(ROOT_SCREEN_TITLES.groups);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
    });
  }, [navigation]);

  // Slide the glass pill in with a TRANSFORM (not opacity): fractional alpha
  // on an ancestor kills UIVisualEffectView materials (see StickyHeaderPill).
  const headerTranslate = scrollY.interpolate({
    inputRange: [0, 60],
    outputRange: [-160, 0],
    extrapolate: 'clamp',
  });
  const tabBarEnvelopeHeight = getFloatingTabBarEnvelopeHeight(insets.bottom);
  const listBottomPadding = getFloatingTabBarContentPadding(insets.bottom, 56);

  useEffect(() => {
    const showSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardVisible(true)
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardVisible(false)
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      setOpeningGroupId(null);
    });

    return unsubscribe;
  }, [navigation]);

  const filteredCurrencies = useMemo(() => {
    const input = currencyInput.toUpperCase();
    return CURRENCIES.filter(c => c.code.includes(input) || c.name.toUpperCase().includes(input));
  }, [currencyInput]);

  // Derived state: Available currencies in existing groups
  const availableCurrencies = useMemo(() => {
    const currencies = new Set(groups.map(g => g.currency));
    return Array.from(currencies).sort();
  }, [groups]);

  // Filter and Sort Logic
  const processedGroups = useMemo(() => {
    // Scoped-sensitive groups VANISH while shielded — removed outright, no
    // masked placeholder row advertising that something is hidden.
    // Hidden 2-person ledgers (doc 21) never surface in the groups list.
    let result = groups.filter((g) => !g.hidden && !guardIsVanished('expenses', g.groupId));

    // Filter by Currency
    if (selectedCurrencies.length > 0) {
      result = result.filter(g => selectedCurrencies.includes(g.currency));
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'createdAt':
          comparison = a.createdAt - b.createdAt;
          break;
        case 'updatedAt':
          // Fallback to createdAt if updatedAt is missing
          const timeA = a.updatedAt || a.createdAt;
          const timeB = b.updatedAt || b.createdAt;
          comparison = timeA - timeB;
          break;
        case 'totalSpent':
          const totalA = a.expenses.reduce((sum, e) => sum + e.amount, 0);
          const totalB = b.expenses.reduce((sum, e) => sum + e.amount, 0);
          comparison = totalA - totalB;
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [groups, selectedCurrencies, sortField, sortOrder, guardIsVanished]);

  // Per-user archive: archived groups stay fully functional (balances count),
  // they're just collapsed into a section below the active list.
  const archivedIds = useMemo(
    () => new Set(user?.archivedGroupIds ?? []),
    [user?.archivedGroupIds],
  );
  const activeGroups = useMemo(
    () => processedGroups.filter(g => !archivedIds.has(g.groupId)),
    [processedGroups, archivedIds],
  );
  const archivedGroups = useMemo(
    () => processedGroups.filter(g => archivedIds.has(g.groupId)),
    [processedGroups, archivedIds],
  );

  const handleCreate = async (requestId: string) => {
    const selectedCurrency = CURRENCIES.find(c => c.code === currencyInput.toUpperCase());

    if (!selectedCurrency) {
      appAlert('Invalid Currency', 'Please select a valid currency from the list.');
      return;
    }

    if (!isOnline) {
      // createGroup is a direct Firestore write — offline it never resolves.
      appAlert("You're offline", 'Creating a group needs an internet connection. Try again when you reconnect.');
      return;
    }
    try {
      await createGroup(name.trim(), selectedCurrency.code, requestId);
      successHaptic();
      setDialog(null);
      setName('');
      setCurrencyInput('USD');
      setShowCurrencyList(false);
    } catch (error) {
      console.error('Failed to create group', error);
      appAlert('Error', 'Failed to create group');
    }
  };

  const handleJoin = async (requestId: string) => {
    if (!isOnline) {
      appAlert("You're offline", 'Joining a group needs an internet connection. Try again when you reconnect.');
      return;
    }
    try {
      await joinGroup(inviteCode.trim().toUpperCase(), requestId);
      successHaptic();
      setDialog(null);
      setInviteCode('');
    } catch (error) {
      console.error('Failed to join group', error);
      appAlert('Error', 'Failed to join group');
    }
  };

  // Long-press a group card: quick-actions menu — the fastest paths into the
  // things people do most, without opening the group first.
  const handleGroupQuickActions = (group: Group) => {
    appAlert(group.name, undefined, [
      {
        text: 'Add expense',
        onPress: () => navigation.navigate(ROUTES.APP.ADD_EXPENSE, { groupId: group.groupId }),
      },
      {
        text: 'Settle up',
        onPress: () => navigation.navigate(ROUTES.APP.SETTLEMENTS, { groupId: group.groupId }),
      },
      {
        text: 'Stats',
        onPress: () => navigation.navigate(ROUTES.APP.GROUP_STATS, { groupId: group.groupId, backTitle: group.name }),
      },
      {
        text: 'Archive',
        style: 'destructive',
        onPress: () => handleArchive(group),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleArchive = (group: Group) => {
    if (!user) return;
    if (!isOnline) {
      appAlert("You're offline", 'Archiving needs an internet connection. Try again when you reconnect.');
      return;
    }
    appAlert(
      'Archive Group',
      `"${group.name}" will move to your Archived section. Balances and expenses are unaffected, and only you see it as archived.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          onPress: async () => {
            try {
              await archiveGroup(user.userId, group.groupId);
              successHaptic();
            } catch (error) {
              console.error('Failed to archive group', error);
              appAlert('Error', 'Failed to archive group. Please try again.');
            }
          },
        },
      ]
    );
  };

  const toggleCurrency = (currency: string) => {
    setSelectedCurrencies(prev =>
      prev.includes(currency)
        ? prev.filter(c => c !== currency)
        : [...prev, currency]
    );
  };

  const handleOpenGroup = (group: Group) => {
    if (openingGroupId) return;

    lightHaptic();
    setOpeningGroupId(group.groupId);

    // Delay navigation by one frame so React can paint the loading
    // spinner on the card before the heavy navigation transition begins.
    requestAnimationFrame(() => {
      onOpenGroup(group);
    });
  };

  return (
    <LiquidBackground style={styles.container}>
      <Animated.View
        style={[
          styles.stickyHeader,
          { transform: [{ translateY: headerTranslate }], paddingTop: insets.top + 8 },
        ]}
      >
        <StickyHeaderPill style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}>Expenses</Text>
        </StickyHeaderPill>
      </Animated.View>

      <Animated.FlatList
        data={activeGroups}
        keyExtractor={(item) => item.groupId}
        renderItem={({ item, index }) => (
          <SwipeableGroupCard
            group={item}
            onPress={openingGroupId ? undefined : () => handleOpenGroup(item)}
            onLongPress={handleGroupQuickActions}
            onArchive={handleArchive}
            index={index}
            loading={openingGroupId === item.groupId}
          />
        )}
        // Renders only in flat mode — in glass mode the gap between the
        // floating cards already separates the rows.
        ItemSeparatorComponent={() => <ListSeparator inset={16} />}
        contentContainerStyle={[
          groups.length === 0 && !loading ? styles.emptyContainer : undefined,
          { paddingTop: insets.top + 32, paddingBottom: listBottomPadding, paddingHorizontal: 16 }
        ]}
        ListHeaderComponent={
          <View>
            <View style={styles.headerContainer}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text variant="displaySmall" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>Expenses</Text>
                <TouchableRipple
                  onPress={() => { lightHaptic(); setFilterVisible(true); }}
                  style={styles.filterButton}
                  borderless
                >
                  <GlassView role="floating" intensity={40} style={styles.filterButtonContent}>
                    <IconButton icon="filter-variant" size={24} iconColor={theme.colors.onSurface} style={{ margin: 0 }} />
                    {(selectedCurrencies.length > 0) && (
                      <View style={[styles.filterBadge, { backgroundColor: theme.colors.primary, borderColor: theme.colors.background }]}>
                        <Text style={{ color: theme.colors.onPrimary, fontSize: 10, fontWeight: 'bold' }}>
                          {selectedCurrencies.length}
                        </Text>
                      </View>
                    )}
                  </GlassView>
                </TouchableRipple>
              </View>
            </View>

            {archivedGroups.length > 0 && (
              <View style={styles.archivedSection}>
                {/* WhatsApp-style: navigate to a dedicated Archived screen
                    instead of expanding inline, so archived groups never
                    mingle with the active list. */}
                <ArchivedFolderRow
                  icon="archive-outline"
                  label="Archived"
                  count={archivedGroups.length}
                  expanded={false}
                  locked
                  onPress={() => { lightHaptic(); navigation.navigate(ROUTES.APP.ARCHIVED_GROUPS); }}
                />
              </View>
            )}
          </View>
        }
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
        scrollEventThrottle={16}
        removeClippedSubviews={true}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        ListEmptyComponent={
          loading ? (
            <View>
              <GroupCardSkeleton />
              <GroupCardSkeleton />
              <GroupCardSkeleton />
            </View>
          ) : (
            <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>
              {archivedGroups.length > 0
                ? 'All your groups are archived.'
                : groups.length > 0
                  ? 'No expense groups match your filters.'
                  : 'No expenses yet. Create a group to start splitting.'}
            </Text>
          )
        }
      />

      {!groupsShielded && <View style={[styles.actions, { bottom: tabBarEnvelopeHeight + 12 }]}>
        <Button mode="contained" compact style={styles.primaryAction} onPress={() => { lightHaptic(); setDialog('create'); }}>
          New group
        </Button>

        <TouchableOpacity
          onPress={() => { lightHaptic(); navigation.navigate(ROUTES.APP.FRIENDS, { backTitle: 'Expenses' }); }}
          activeOpacity={0.8}
          style={styles.glassAction}
        >
          <GlassView role="floating" style={styles.glassActionInner}>
            <Text style={{ color: theme.colors.primary, fontWeight: '600' }}>Friends</Text>
          </GlassView>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => { lightHaptic(); setDialog('join'); }}
          activeOpacity={0.8}
          style={styles.glassAction}
        >
          {/* GlassView provides the blurred/frosted fill inside the button */}
          <GlassView role="floating" style={styles.glassActionInner}>
            <Text style={{ color: theme.colors.primary, fontWeight: '600' }}>Join via code</Text>
          </GlassView>
        </TouchableOpacity>
      </View>}

      <GroupFilterSortSheet
        visible={filterVisible}
        onClose={() => setFilterVisible(false)}
        sortField={sortField}
        sortOrder={sortOrder}
        selectedCurrencies={selectedCurrencies}
        availableCurrencies={availableCurrencies}
        onSortFieldChange={setSortField}
        onSortOrderChange={setSortOrder}
        onCurrencyToggle={toggleCurrency}
      />

      {/* react-native-paper's own Modal wraps its content in a Surface with an
          animated `opacity` style — exactly the "ancestor with fractional
          opacity" that kills the native iOS 26 glass material (DESIGN.md's
          native-material kill list). Every other sheet in this app already
          uses RN core Modal for this reason; these two dialogs were the one
          place still on paper's Modal, and it read as a fully bare/unstyled
          overlay on a real device. */}
      <Modal
        visible={dialog === 'create'}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setDialog(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setDialog(null)} accessibilityLabel="Close create group" />
        <View
          style={[styles.modalContainer, keyboardVisible && { marginBottom: 300 }]}
          pointerEvents="box-none"
        >
          <GlassCard role="floating" style={styles.glassCard}>
            <Text variant="headlineSmall" style={[styles.modalTitle, { color: theme.colors.onSurface }]}>Create group</Text>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 4 }} keyboardShouldPersistTaps="handled">
              <FloatingLabelInput
                label="Name"
                value={name}
                onChangeText={setName}
                style={styles.field}
              />
              <View>
                <FloatingLabelInput
                  label="Currency"
                  value={currencyInput}
                  onChangeText={(text: string) => {
                    setCurrencyInput(text);
                    setShowCurrencyList(true);
                  }}
                  onFocus={() => setShowCurrencyList(true)}
                  autoCapitalize="characters"
                  style={showCurrencyList ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : undefined}
                />
                {showCurrencyList && (
                  <GlassCard role="floating"
                    style={[styles.currencyList, { borderTopLeftRadius: 0, borderTopRightRadius: 0 }]}
                    radius={20}
                  >
                    <ScrollView nestedScrollEnabled={true} keyboardShouldPersistTaps="handled">
                      {filteredCurrencies.slice(0, 50).map((item) => (
                        <TouchableOpacity
                          key={item.code}
                          style={[styles.currencyItem, { borderBottomColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)' }]}
                          onPress={() => {
                            setCurrencyInput(item.code);
                            setShowCurrencyList(false);
                          }}
                        >
                          <Text style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>{item.code}</Text>
                          <Text numberOfLines={1} style={{ flex: 1, marginLeft: 8, color: theme.colors.onSurfaceVariant }}>{item.name}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </GlassCard>
                )}
              </View>
            </ScrollView>
            <View style={styles.modalActions}>
              <Button onPress={() => setDialog(null)} textColor={theme.colors.primary}>Cancel</Button>
              <PrimaryButton
                onPress={handleCreate}
                disabled={!name}
                requestKey="group-create"
                loadingMessage="Creating group..."
                showGlobalOverlay
              >
                Create
              </PrimaryButton>
            </View>
          </GlassCard>
        </View>
      </Modal>

      <Modal
        visible={dialog === 'join'}
        transparent
        statusBarTranslucent
        animationType="fade"
        onRequestClose={() => setDialog(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setDialog(null)} accessibilityLabel="Close join group" />
        <View
          style={[styles.modalContainer, keyboardVisible && { marginBottom: 150 }]}
          pointerEvents="box-none"
        >
          <GlassCard role="floating" style={styles.glassCard}>
            <Text variant="headlineSmall" style={[styles.modalTitle, { color: theme.colors.onSurface }]}>Join group</Text>
            <FloatingLabelInput
              label="Invite code"
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="characters"
            />
            <View style={styles.modalActions}>
              <Button onPress={() => setDialog(null)} textColor={theme.colors.primary}>Cancel</Button>
              <PrimaryButton
                onPress={handleJoin}
                disabled={!inviteCode || !isOnline}
                requestKey="group-join"
                loadingMessage="Joining group..."
                showGlobalOverlay
              >
                {isOnline ? 'Join' : 'Offline'}
              </PrimaryButton>
            </View>
          </GlassCard>
        </View>
      </Modal>

    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  actions: {
    position: 'absolute',
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    zIndex: 10,
  },
  primaryAction: {
    flex: 1,
    minWidth: 0,
  },
  glassAction: {
    flex: 1,
    minWidth: 0,
    borderRadius: 15,
    overflow: 'hidden',
    borderWidth: 0,
    borderColor: 'rgba(0,0,0,0.08)',
  },
  glassActionInner: {
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  empty: {
    textAlign: 'center',
  },
  archivedSection: {
    marginTop: 4,
  },
  field: {
    marginBottom: 0,
  },
  currencyList: {
    maxHeight: 150,
  },
  currencyItem: {
    flexDirection: 'row',
    padding: 12,
    borderBottomWidth: 1,
    alignItems: 'center',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  modalContainer: {
    flex: 1,
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glassCard: {
    width: '100%',
    maxWidth: 400,
    padding: 24,
    borderRadius: 28,
  },
  modalTitle: {
    marginBottom: 0, // Spacing between title and first field
    textAlign: 'center',
    fontWeight: 'bold',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 20,
    gap: 10,
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
  },
  headerContainer: {
    paddingHorizontal: 8,
    paddingBottom: 16,
    marginTop: 16,
  },
  headerTitle: {
    fontWeight: 'bold',
  },
  filterButton: {
    borderRadius: 50,
    width: 44,
    height: 44,
    overflow: 'hidden',
  },
  filterButtonContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
