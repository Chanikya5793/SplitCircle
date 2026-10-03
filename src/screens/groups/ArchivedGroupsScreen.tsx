import { EmptyState } from '@/components/ui/EmptyState';
// ArchivedGroupsScreen — dedicated destination for the Expenses list's
// "Archived" folder. WhatsApp-style: the folder row navigates here instead of
// expanding inline, so archived groups never mingle with the active list. Rows
// reuse SwipeableGroupCard (identical swipe-to-restore behavior).

import { LiquidBackground } from '@/components/LiquidBackground';
import { SwipeableGroupCard } from '@/components/SwipeableGroupCard';
import { FloatingDetailHeader, floatingDetailHeaderHeight } from '@/components/ui';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import type { Group } from '@/models';
import { unarchiveGroup } from '@/services/archiveService';
import { appAlert } from '@/utils/appAlert';
import { lightHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const ArchivedGroupsScreen = () => {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
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
      appAlert('Could not restore group', 'The group is still archived. Try again.');
    }
  };

  const headerHeight = floatingDetailHeaderHeight(insets.top);

  return (
    <LiquidBackground>
      <FloatingDetailHeader title="Archived groups" />

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
          { paddingTop: headerHeight + 12, paddingBottom: insets.bottom + 24 },
        ]}
        ListEmptyComponent={
          <EmptyState
            icon="archive-outline"
            title="No archived groups"
            hint="Swipe left on a group and choose Archive to move it here."
          />
        }
      />
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  list: { padding: 16 },
});

export default ArchivedGroupsScreen;
