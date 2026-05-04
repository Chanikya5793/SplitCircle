import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ROUTES } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { GroupMember } from '@/models';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { SCREEN_TITLES } from '@/navigation/screenTitles';
import { errorHaptic, lightHaptic, selectionHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Avatar, Button, Divider, IconButton, List, Text, TextInput } from 'react-native-paper';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const errorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message.trim()) return error.message;
    return fallback;
};

export const GroupInfoScreen = () => {
    const insets = useSafeAreaInsets();
    const navigation = useNavigation<any>();
    const route = useRoute();
    const { groupId } = route.params as { groupId: string };
    const { user } = useAuth();
    const { groups, updateGroup, updateMemberRole, removeMember, leaveGroup, deleteGroup } = useGroups();
    const { theme } = useTheme();
    const [isEditingName, setIsEditingName] = useState(false);
    const [editedName, setEditedName] = useState('');
    const [isEditingDescription, setIsEditingDescription] = useState(false);
    const [editedDescription, setEditedDescription] = useState('');
    const [busy, setBusy] = useState(false);
    const scrollY = useRef(new Animated.Value(0)).current;
    const hasLeftRef = useRef(false);

    const group = useMemo(() => groups.find((g) => g.groupId === groupId), [groups, groupId]);

    useLayoutEffect(() => {
        navigation.setOptions({
            title: SCREEN_TITLES.groupInfo,
            headerTitle: '',
            headerTransparent: true,
        });
    }, [navigation]);

    // If the group disappears after a leave/delete, pop the screen — otherwise
    // the user is stuck looking at the "Group not found" placeholder.
    useEffect(() => {
        if (!group && hasLeftRef.current && navigation.canGoBack()) {
            navigation.goBack();
        }
    }, [group, navigation]);

    if (!group) {
        return (
            <LiquidBackground>
                <SafeAreaView style={styles.container}>
                    <Text style={{ color: theme.colors.onSurface, padding: 24 }}>
                        Group not found
                    </Text>
                </SafeAreaView>
            </LiquidBackground>
        );
    }

    const me = group.members.find((m) => m.userId === user?.userId);
    const isOwner = me?.role === 'owner';
    const isAdmin = isOwner || me?.role === 'admin';
    const groupInitials = group.name.slice(0, 2).toUpperCase();

    const headerOpacity = scrollY.interpolate({
        inputRange: [0, 100],
        outputRange: [0, 1],
        extrapolate: 'clamp',
    });
    const titleOpacity = scrollY.interpolate({
        inputRange: [0, 100],
        outputRange: [1, 0],
        extrapolate: 'clamp',
    });

    const startEditName = () => {
        if (!isAdmin) return;
        setEditedName(group.name);
        setIsEditingName(true);
    };

    const cancelEditName = () => {
        setIsEditingName(false);
        setEditedName('');
    };

    const handleSaveName = async () => {
        const trimmed = editedName.trim();
        if (!trimmed) {
            Alert.alert('Group name required', 'Please enter a name.');
            return;
        }
        if (trimmed === group.name) {
            cancelEditName();
            return;
        }
        setBusy(true);
        try {
            await updateGroup(group.groupId, { name: trimmed });
            successHaptic();
            cancelEditName();
        } catch (error) {
            errorHaptic();
            Alert.alert('Could not rename group', errorMessage(error, 'Please try again.'));
        } finally {
            setBusy(false);
        }
    };

    const startEditDescription = () => {
        if (!isAdmin) return;
        setEditedDescription(group.description ?? '');
        setIsEditingDescription(true);
    };

    const cancelEditDescription = () => {
        setIsEditingDescription(false);
        setEditedDescription('');
    };

    const handleSaveDescription = async () => {
        const trimmed = editedDescription.trim();
        if (trimmed === (group.description ?? '').trim()) {
            cancelEditDescription();
            return;
        }
        setBusy(true);
        try {
            await updateGroup(group.groupId, { description: trimmed });
            successHaptic();
            cancelEditDescription();
        } catch (error) {
            errorHaptic();
            Alert.alert('Could not update description', errorMessage(error, 'Please try again.'));
        } finally {
            setBusy(false);
        }
    };

    const handleAddExpense = () => {
        navigation.navigate(ROUTES.APP.ADD_EXPENSE, { groupId: group.groupId });
    };

    const handleViewStats = () => {
        navigation.navigate(ROUTES.APP.GROUP_STATS, {
            groupId: group.groupId,
            backTitle: SCREEN_TITLES.groupInfo,
        });
    };

    const handleViewSplits = () => {
        navigation.navigate(ROUTES.APP.ROOT, {
            screen: ROUTES.APP.GROUPS_TAB,
            params: {
                screen: ROUTES.APP.GROUP_DETAILS,
                params: { groupId: group.groupId, initialTitle: group.name },
            },
        });
    };

    const performMemberAction = async (
        member: GroupMember,
        action: 'promote' | 'demote' | 'remove',
    ) => {
        setBusy(true);
        try {
            if (action === 'promote') {
                await updateMemberRole(group.groupId, member.userId, 'admin');
            } else if (action === 'demote') {
                await updateMemberRole(group.groupId, member.userId, 'member');
            } else if (action === 'remove') {
                await removeMember(group.groupId, member.userId);
            }
            successHaptic();
        } catch (error) {
            errorHaptic();
            Alert.alert('Action failed', errorMessage(error, 'Please try again.'));
        } finally {
            setBusy(false);
        }
    };

    const openMemberMenu = (member: GroupMember) => {
        if (!me) return;
        if (member.userId === user?.userId) return; // Self-row → no-op
        if (!isAdmin) return; // Non-admins: viewing only

        const options: { text: string; style?: 'default' | 'destructive' | 'cancel'; onPress?: () => void }[] = [];

        if (isOwner && member.role === 'member') {
            options.push({
                text: 'Make admin',
                onPress: () => void performMemberAction(member, 'promote'),
            });
        }
        if (isOwner && member.role === 'admin') {
            options.push({
                text: 'Remove admin role',
                onPress: () => void performMemberAction(member, 'demote'),
            });
        }

        const canRemove = member.role !== 'owner' && !(me.role === 'admin' && member.role === 'admin');
        if (canRemove) {
            options.push({
                text: 'Remove from group',
                style: 'destructive',
                onPress: () =>
                    Alert.alert(
                        'Remove member',
                        `Remove ${member.displayName} from "${group.name}"? Their balance history stays in the group ledger.`,
                        [
                            { text: 'Cancel', style: 'cancel' },
                            {
                                text: 'Remove',
                                style: 'destructive',
                                onPress: () => void performMemberAction(member, 'remove'),
                            },
                        ],
                    ),
            });
        }

        if (options.length === 0) return;

        lightHaptic();
        Alert.alert(member.displayName, member.role.charAt(0).toUpperCase() + member.role.slice(1), [
            ...options,
            { text: 'Cancel', style: 'cancel' },
        ]);
    };

    const handleLeaveGroup = () => {
        if (!me) return;
        if (me.role === 'owner') {
            Alert.alert(
                'Transfer ownership first',
                'Promote another member to admin and ask the group to give you a successor before leaving.',
            );
            return;
        }
        Alert.alert(
            'Leave group',
            `Leave "${group.name}"? Your balance history will remain visible to other members.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Leave',
                    style: 'destructive',
                    onPress: async () => {
                        setBusy(true);
                        hasLeftRef.current = true;
                        try {
                            await leaveGroup(group.groupId);
                            successHaptic();
                        } catch (error) {
                            hasLeftRef.current = false;
                            errorHaptic();
                            Alert.alert('Could not leave group', errorMessage(error, 'Please try again.'));
                        } finally {
                            setBusy(false);
                        }
                    },
                },
            ],
        );
    };

    const handleDeleteGroup = () => {
        if (!isOwner) return;
        Alert.alert(
            'Delete group',
            `Permanently delete "${group.name}"? Expenses, settlements, and the group chat will be removed for everyone. This cannot be undone.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        setBusy(true);
                        hasLeftRef.current = true;
                        try {
                            await deleteGroup(group.groupId);
                            successHaptic();
                        } catch (error) {
                            hasLeftRef.current = false;
                            errorHaptic();
                            Alert.alert('Could not delete group', errorMessage(error, 'Please try again.'));
                        } finally {
                            setBusy(false);
                        }
                    },
                },
            ],
        );
    };

    const renderMemberRight = (member: GroupMember) => {
        const items: React.ReactNode[] = [];
        if (member.userId === group.createdBy) {
            items.push(
                <View key="owner" style={styles.roleBadge}>
                    <MaterialCommunityIcons name="crown" size={14} color="#FFD700" />
                    <Text variant="labelSmall" style={[styles.roleBadgeText, { color: '#B8860B' }]}>
                        Owner
                    </Text>
                </View>,
            );
        } else if (member.role === 'admin') {
            items.push(
                <View key="admin" style={[styles.roleBadge, { backgroundColor: theme.colors.primaryContainer }]}>
                    <MaterialCommunityIcons name="shield-star" size={14} color={theme.colors.primary} />
                    <Text variant="labelSmall" style={[styles.roleBadgeText, { color: theme.colors.primary }]}>
                        Admin
                    </Text>
                </View>,
            );
        }

        if (isAdmin && member.userId !== user?.userId && member.role !== 'owner') {
            items.push(
                <IconButton
                    key="menu"
                    icon="dots-vertical"
                    size={18}
                    onPress={() => openMemberMenu(member)}
                    style={{ margin: 0 }}
                />,
            );
        }

        if (items.length === 0) return null;
        return <View style={styles.memberRightCluster}>{items}</View>;
    };

    return (
        <LiquidBackground>
            <SafeAreaView style={styles.container} edges={['bottom']}>
                <Animated.View
                    style={[styles.stickyHeader, { opacity: headerOpacity, paddingTop: insets.top }]}
                    pointerEvents="none"
                >
                    <GlassView style={styles.stickyHeaderGlass}>
                        <View style={styles.stickyHeaderContent}>
                            <Avatar.Text
                                size={32}
                                label={groupInitials}
                                style={{ backgroundColor: theme.colors.primary }}
                                color={theme.colors.onPrimary}
                            />
                            <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]} numberOfLines={1}>
                                {group.name}
                            </Text>
                        </View>
                    </GlassView>
                </Animated.View>

                <Animated.ScrollView
                    style={styles.scrollView}
                    contentContainerStyle={{ paddingBottom: 100 }}
                    onScroll={Animated.event(
                        [{ nativeEvent: { contentOffset: { y: scrollY } } }],
                        { useNativeDriver: true },
                    )}
                    scrollEventThrottle={16}
                >
                    <Animated.View style={[styles.titleContainer, { opacity: titleOpacity, marginTop: insets.top + 40 }]}>
                        <Text variant="headlineSmall" style={[styles.screenTitle, { color: theme.colors.onSurface }]}>
                            Group Info
                        </Text>
                    </Animated.View>

                    <View style={styles.profileSection}>
                        <Avatar.Text
                            size={120}
                            label={groupInitials}
                            style={{ backgroundColor: theme.colors.primary }}
                            color={theme.colors.onPrimary}
                        />

                        <View style={styles.nameSection}>
                            {isEditingName ? (
                                <View style={styles.nameEditRow}>
                                    <TextInput
                                        mode="outlined"
                                        value={editedName}
                                        onChangeText={setEditedName}
                                        style={styles.nameInput}
                                        autoFocus
                                        maxLength={60}
                                    />
                                    <Button mode="contained" onPress={handleSaveName} disabled={busy} loading={busy} compact>
                                        Save
                                    </Button>
                                    <Button mode="text" onPress={cancelEditName} disabled={busy} compact>
                                        Cancel
                                    </Button>
                                </View>
                            ) : (
                                <TouchableOpacity onPress={startEditName} activeOpacity={isAdmin ? 0.7 : 1}>
                                    <View style={styles.nameRow}>
                                        <Text variant="headlineSmall" style={[styles.groupName, { color: theme.colors.onSurface }]}>
                                            {group.name}
                                        </Text>
                                        {isAdmin && (
                                            <MaterialCommunityIcons name="pencil" size={20} color={theme.colors.primary} />
                                        )}
                                    </View>
                                </TouchableOpacity>
                            )}

                            {isEditingDescription ? (
                                <View style={styles.descriptionEditRow}>
                                    <TextInput
                                        mode="outlined"
                                        value={editedDescription}
                                        onChangeText={setEditedDescription}
                                        style={styles.descriptionInput}
                                        placeholder="Add a description"
                                        autoFocus
                                        multiline
                                        maxLength={200}
                                    />
                                    <View style={styles.descriptionEditActions}>
                                        <Button mode="contained" onPress={handleSaveDescription} disabled={busy} loading={busy} compact>
                                            Save
                                        </Button>
                                        <Button mode="text" onPress={cancelEditDescription} disabled={busy} compact>
                                            Cancel
                                        </Button>
                                    </View>
                                </View>
                            ) : (
                                <TouchableOpacity
                                    onPress={startEditDescription}
                                    activeOpacity={isAdmin ? 0.7 : 1}
                                    style={styles.descriptionRow}
                                >
                                    <Text
                                        variant="bodyMedium"
                                        style={[styles.description, { color: theme.colors.onSurfaceVariant }]}
                                    >
                                        {group.description?.trim()
                                            ? group.description
                                            : isAdmin
                                                ? 'Add a description'
                                                : 'No description'}
                                    </Text>
                                    {isAdmin && (
                                        <MaterialCommunityIcons name="pencil" size={16} color={theme.colors.primary} />
                                    )}
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>

                    <GlassView style={styles.section}>
                        <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                            Quick Actions
                        </Text>
                        <View style={styles.actionButtons}>
                            <TouchableOpacity style={styles.actionButton} onPress={handleAddExpense} activeOpacity={0.7}>
                                <View style={[styles.actionIcon, { backgroundColor: theme.colors.secondaryContainer }]}>
                                    <MaterialCommunityIcons name="plus-circle" size={32} color={theme.colors.onSecondaryContainer} />
                                </View>
                                <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>Add Expense</Text>
                            </TouchableOpacity>

                            <TouchableOpacity style={styles.actionButton} onPress={handleViewStats} activeOpacity={0.7}>
                                <View style={[styles.actionIcon, { backgroundColor: theme.colors.secondaryContainer }]}>
                                    <MaterialCommunityIcons name="chart-bar" size={32} color={theme.colors.onSecondaryContainer} />
                                </View>
                                <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>Stats</Text>
                            </TouchableOpacity>

                            <TouchableOpacity style={styles.actionButton} onPress={handleViewSplits} activeOpacity={0.7}>
                                <View style={[styles.actionIcon, { backgroundColor: theme.colors.secondaryContainer }]}>
                                    <MaterialCommunityIcons name="receipt" size={32} color={theme.colors.onSecondaryContainer} />
                                </View>
                                <Text variant="labelMedium" style={{ color: theme.colors.onSurface }}>View Splits</Text>
                            </TouchableOpacity>
                        </View>
                    </GlassView>

                    <GlassView style={styles.section}>
                        <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                            Group Information
                        </Text>
                        <List.Item
                            title="Created by"
                            description={group.members.find((m) => m.userId === group.createdBy)?.displayName || 'Unknown'}
                            left={(props) => <List.Icon {...props} icon="account" />}
                        />
                        <Divider />
                        <List.Item
                            title="Created on"
                            description={new Date(group.createdAt).toLocaleDateString()}
                            left={(props) => <List.Icon {...props} icon="calendar" />}
                        />
                        <Divider />
                        <List.Item
                            title="Currency"
                            description={group.currency}
                            left={(props) => <List.Icon {...props} icon="currency-usd" />}
                        />
                        <Divider />
                        <List.Item
                            title="Invite code"
                            description={group.inviteCode}
                            left={(props) => <List.Icon {...props} icon="ticket-confirmation-outline" />}
                        />
                    </GlassView>

                    <GlassView style={styles.section}>
                        <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                            Members ({group.members.length})
                        </Text>
                        {group.members.map((member, index) => {
                            const isSelf = member.userId === user?.userId;
                            const isInteractive = isAdmin && !isSelf && member.role !== 'owner';
                            return (
                                <View key={member.userId}>
                                    <List.Item
                                        title={isSelf ? `${member.displayName} (you)` : member.displayName}
                                        description={member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                                        onPress={isInteractive ? () => openMemberMenu(member) : undefined}
                                        left={() => (
                                            <Avatar.Text
                                                size={40}
                                                label={member.displayName.slice(0, 2).toUpperCase()}
                                                style={{ backgroundColor: theme.colors.primary }}
                                                color={theme.colors.onPrimary}
                                            />
                                        )}
                                        right={() => renderMemberRight(member)}
                                    />
                                    {index < group.members.length - 1 && <Divider />}
                                </View>
                            );
                        })}
                    </GlassView>

                    {(group.archivedMembers ?? []).length > 0 && (
                        <GlassView style={styles.section}>
                            <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                                Former members ({group.archivedMembers!.length})
                            </Text>
                            <Text
                                variant="bodySmall"
                                style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}
                            >
                                Kept here so historical balances and debts still resolve to a real name.
                            </Text>
                            {group.archivedMembers!.map((member, index) => {
                                const balanceLabel = Math.abs(member.balance) >= 0.005
                                    ? member.balance > 0
                                        ? `Owed ${group.currency} ${member.balance.toFixed(2)}`
                                        : `Owes ${group.currency} ${Math.abs(member.balance).toFixed(2)}`
                                    : 'Settled up';
                                return (
                                    <View key={member.userId}>
                                        <List.Item
                                            title={member.displayName}
                                            description={`${member.archivedReason === 'left' ? 'Left' : 'Removed'} • ${balanceLabel}`}
                                            titleStyle={{ color: theme.colors.onSurfaceVariant }}
                                            left={() => (
                                                <Avatar.Text
                                                    size={40}
                                                    label={member.displayName.slice(0, 2).toUpperCase()}
                                                    style={{ backgroundColor: theme.colors.surfaceVariant }}
                                                    color={theme.colors.onSurfaceVariant}
                                                />
                                            )}
                                        />
                                        {index < group.archivedMembers!.length - 1 && <Divider />}
                                    </View>
                                );
                            })}
                        </GlassView>
                    )}

                    <GlassView style={styles.section}>
                        <Button
                            mode="outlined"
                            textColor={theme.colors.error}
                            style={[styles.dangerButton, { borderColor: theme.colors.error }]}
                            onPress={() => {
                                selectionHaptic();
                                handleLeaveGroup();
                            }}
                            disabled={busy || isOwner}
                        >
                            Leave Group
                        </Button>
                        {isOwner && (
                            <>
                                <Text
                                    variant="bodySmall"
                                    style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
                                >
                                    Owners must transfer ownership before leaving.
                                </Text>
                                <Button
                                    mode="contained"
                                    buttonColor={theme.colors.error}
                                    textColor={theme.colors.onError}
                                    style={styles.deleteButton}
                                    onPress={() => {
                                        selectionHaptic();
                                        handleDeleteGroup();
                                    }}
                                    disabled={busy}
                                >
                                    Delete Group
                                </Button>
                            </>
                        )}
                    </GlassView>
                </Animated.ScrollView>
            </SafeAreaView>
        </LiquidBackground>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    scrollView: {
        flex: 1,
    },
    stickyHeader: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        paddingTop: 8,
        paddingHorizontal: 16,
        paddingBottom: 10,
        alignItems: 'center',
    },
    stickyHeaderGlass: {
        paddingVertical: 6,
        paddingHorizontal: 16,
        borderRadius: 30,
    },
    stickyHeaderContent: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    stickyHeaderTitle: {
        fontWeight: 'bold',
    },
    titleContainer: {
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 8,
        alignItems: 'center',
    },
    screenTitle: {
        fontWeight: 'bold',
    },
    profileSection: {
        alignItems: 'center',
        paddingVertical: 32,
        paddingHorizontal: 16,
    },
    nameSection: {
        marginTop: 16,
        alignItems: 'center',
        width: '100%',
    },
    nameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    nameEditRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        width: '100%',
    },
    nameInput: {
        flex: 1,
    },
    groupName: {
        fontWeight: 'bold',
    },
    descriptionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 8,
        paddingHorizontal: 12,
    },
    description: {
        textAlign: 'center',
        flexShrink: 1,
    },
    descriptionEditRow: {
        marginTop: 12,
        width: '100%',
        gap: 8,
    },
    descriptionInput: {
        width: '100%',
    },
    descriptionEditActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
    },
    section: {
        marginHorizontal: 16,
        marginBottom: 16,
        padding: 16,
        borderRadius: 16,
    },
    sectionTitle: {
        fontWeight: 'bold',
        marginBottom: 12,
    },
    actionButtons: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        marginTop: 8,
    },
    actionButton: {
        alignItems: 'center',
        gap: 8,
    },
    actionIcon: {
        width: 60,
        height: 60,
        borderRadius: 30,
        alignItems: 'center',
        justifyContent: 'center',
    },
    memberRightCluster: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    roleBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
        backgroundColor: 'rgba(255, 215, 0, 0.18)',
    },
    roleBadgeText: {
        fontWeight: '700',
    },
    dangerButton: {},
    deleteButton: {
        marginTop: 16,
    },
});

export default GroupInfoScreen;
