// ArchivedGroupsScreen — dedicated destination for the Expenses list's
// "Archived" folder. WhatsApp-style: the folder row navigates here instead of
// expanding inline, so archived groups never mingle with the active list. Rows
// reuse SwipeableGroupCard (identical swipe-to-restore behavior).

import { LiquidBackground } from '@/components/LiquidBackground';
import { SwipeableGroupCard } from '@/components/SwipeableGroupCard';
import { GlassBackButton } from '@/components/ui';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import type { Group } from '@/models';
import { unarchiveGroup } from '@/services/archiveService';
import { appAlert } from '@/utils/appAlert';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const ArchivedGroupsScreen = () => {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useTheme();
  const { groups } = useGroups();
  const { user } = useAuth();
  const { isOnline } = useOfflineSync();
  const [openingGroupId, setOpeningGroupId] = useState<string | null>(null);

  // Reset the "opening" guard whenever we return here, so cards re-enable
  // after navigating into (and back out of) a group's details.
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => setOpeningGroupId(null));
    return unsubscribe;
  }, [navigation]);

  const archivedIds = useMemo(() => new Set(user?.archivedGroupIds ?? []), [user?.archivedGroupIds]);
  const archivedGroups = useMemo(
    () => groups.filter((g) => archivedIds.has(g.groupId)),
    [groups, archivedIds],
  );

  const handleOpenGroup = (group: Group) => {
    if (openingGroupId) return;
    lightHaptic();
    setOpeningGroupId(group.groupId);
    requestAnimationFrame(() => {
      navigation.navigate(ROUTES.APP.GROUP_DETAILS, {
        groupId: group.groupId,
        initialTitle: group.name,
        backTitle: 'Archived',
      });
    });
  };

  const handleUnarchive = async (group: Group) => {
    if (!user) return;
    if (!isOnline) {
      appAlert("You're offline", 'Restoring needs an internet connection. Try again when you reconnect.');
      return;
    }
    try {
      await unarchiveGroup(user.userId, group.groupId);
      successHaptic();
    } catch (error) {
      console.error('Failed to unarchive group', error);
      appAlert('Error', 'Failed to restore group. Please try again.');
    }
  };

  const HEADER_TOP_PAD = insets.top + 18;
  const HEADER_HEIGHT = HEADER_TOP_PAD + 44 + 12;

  return (
    <LiquidBackground>
      <View
        style={[
          styles.headerRow,
          {
            paddingTop: HEADER_TOP_PAD,
            borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          },
        ]}
      >
        <View style={styles.headerBtn}>
          <GlassBackButton />
        </View>
        <Text numberOfLines={1} style={[styles.titleText, { color: theme.colors.onSurface }]}>
          Archived
        </Text>
        <View style={styles.headerBtn} />
      </View>

      <FlatList
        data={archivedGroups}
        keyExtractor={(item) => item.groupId}
        renderItem={({ item, index }) => (
          <SwipeableGroupCard
            group={item}
            onPress={openingGroupId ? undefined : () => handleOpenGroup(item)}
            onArchive={handleUnarchive}
            archived
            index={index}
            loading={openingGroupId === item.groupId}
          />
        )}
        contentContainerStyle={[
          styles.list,
          { paddingTop: HEADER_HEIGHT + 12, paddingBottom: insets.bottom + 24 },
        ]}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>
            No archived groups.
          </Text>
        }
      />
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  headerRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  titleText: { flex: 1, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  list: { padding: 16 },
  empty: { textAlign: 'center', marginTop: 32 },
});

export default ArchivedGroupsScreen;
