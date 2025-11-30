import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ROUTES } from '@/constants';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Avatar, Button, Divider, List, Text, TextInput } from 'react-native-paper';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

export const GroupInfoScreen = () => {
    const insets = useSafeAreaInsets();
    const navigation = useNavigation();
    const route = useRoute();
    const { groupId } = route.params as { groupId: string };
    const { groups } = useGroups();
    const { theme, isDark } = useTheme();
    const [isEditingName, setIsEditingName] = useState(false);
    const [editedName, setEditedName] = useState('');
    const scrollY = useRef(new Animated.Value(0)).current;

    const group = useMemo(() => {
        return groups.find(g => g.groupId === groupId);
    }, [groups, groupId]);

    if (!group) {
        return (
            <LiquidBackground>
                <SafeAreaView style={styles.container}>
                    <Text style={{ color: theme.colors.onSurface }}>Group not found</Text>
                </SafeAreaView>
            </LiquidBackground>
        );
    }

    const groupInitials = group.name.slice(0, 2).toUpperCase();

    const handleEditName = () => {
        setEditedName(group.name);
        setIsEditingName(true);
    };

    const handleSaveName = () => {
        // TODO: Implement save name functionality
        setIsEditingName(false);
    };

    const handleViewProfilePic = () => {
        // TODO: Implement full screen profile picture view
        console.log('View profile picture in full screen');
    };

    const handleChangeProfilePic = () => {
        // TODO: Implement change profile picture functionality
        console.log('Change profile picture');
    };

    const handleAddExpense = () => {
        // @ts-ignore
        navigation.navigate(ROUTES.APP.ADD_EXPENSE, { groupId: group.groupId });
    };

    const handleViewStats = () => {
        // @ts-ignore
        navigation.navigate(ROUTES.APP.GROUP_STATS, { groupId: group.groupId });
    };

    const handleViewSplits = () => {
        // @ts-ignore
        navigation.navigate(ROUTES.APP.GROUP_DETAILS, { groupId: group.groupId });
    };

    // Animated header opacity
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

    return (
        <LiquidBackground>
            <SafeAreaView style={styles.container} edges={['bottom']}>
                {/* Sticky Header - Appears on scroll */}
                <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity, paddingTop: insets.top }]}>
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
                        { useNativeDriver: true }
                    )}
                    scrollEventThrottle={16}
                >
                    {/* Group Info Title - Fades out on scroll */}
                    <Animated.View style={[styles.titleContainer, { opacity: titleOpacity, marginTop: insets.top + 40 }]}>
                        <Text variant="headlineSmall" style={[styles.screenTitle, { color: theme.colors.onSurface }]}>
                            Group Info
                        </Text>
                    </Animated.View>

                    {/* Group Profile Section */}
                    <View style={styles.profileSection}>
                        <TouchableOpacity onPress={handleViewProfilePic} activeOpacity={0.7}>
                            <Avatar.Text
                                size={120}
                                label={groupInitials}
                                style={{ backgroundColor: theme.colors.primary }}
                                color={theme.colors.onPrimary}
                            />
                            <TouchableOpacity
                                style={[styles.editPicButton, { backgroundColor: theme.colors.primary, borderColor: theme.colors.surface }]}
                                onPress={handleChangeProfilePic}
                                activeOpacity={0.8}
                            >
                                <MaterialCommunityIcons name="camera" size={20} color={theme.colors.onPrimary} />
                            </TouchableOpacity>
                        </TouchableOpacity>

                        <View style={styles.nameSection}>
                            {isEditingName ? (
                                <View style={styles.nameEditRow}>
                                    <TextInput
                                        mode="outlined"
                                        value={editedName}
                                        onChangeText={setEditedName}
                                        style={styles.nameInput}
                                        autoFocus
                                    />
                                    <Button mode="contained" onPress={handleSaveName} compact>
                                        Save
                                    </Button>
                                </View>
                            ) : (
                                <TouchableOpacity onPress={handleEditName} activeOpacity={0.7}>
                                    <View style={styles.nameRow}>
                                        <Text variant="headlineSmall" style={[styles.groupName, { color: theme.colors.onSurface }]}>
                                            {group.name}
                                        </Text>
                                        <MaterialCommunityIcons name="pencil" size={20} color={theme.colors.primary} />
                                    </View>
                                </TouchableOpacity>
                            )}
                            {group.description && (
                                <Text variant="bodyMedium" style={[styles.description, { color: theme.colors.onSurfaceVariant }]}>
                                    {group.description}
                                </Text>
                            )}
                        </View>
                    </View>

                    {/* Quick Actions */}
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

                    {/* Group Info */}
                    <GlassView style={styles.section}>
                        <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                            Group Information
                        </Text>
                        <List.Item
                            title="Created by"
                            description={group.members.find(m => m.userId === group.createdBy)?.displayName || 'Unknown'}
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
                    </GlassView>

                    {/* Members Section */}
                    <GlassView style={styles.section}>
                        <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
                            Members ({group.members.length})
                        </Text>
                        {group.members.map((member, index) => (
                            <View key={member.userId}>
                                <List.Item
                                    title={member.displayName}
                                    description={member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                                    left={() => (
                                        <Avatar.Text
                                            size={40}
                                            label={member.displayName.slice(0, 2).toUpperCase()}
                                            style={{ backgroundColor: theme.colors.primary }}
                                            color={theme.colors.onPrimary}
                                        />
                                    )}
                                    right={() =>
                                        member.userId === group.createdBy ? (
                                            <View style={styles.ownerBadge}>
                                                <MaterialCommunityIcons name="crown" size={16} color="#FFD700" />
                                            </View>
                                        ) : null
                                    }
                                />
                                {index < group.members.length - 1 && <Divider />}
                            </View>
                        ))}
                    </GlassView>

                    {/* Danger Zone */}
                    <GlassView style={styles.section}>
                        <Button
                            mode="outlined"
                            textColor={theme.colors.error}
                            style={[styles.dangerButton, { borderColor: theme.colors.error }]}
                            onPress={() => { }}
                        >
                            Leave Group
                        </Button>
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
    editPicButton: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 3,
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
    description: {
        marginTop: 4,
        textAlign: 'center',
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
    ownerBadge: {
        alignSelf: 'center',
    },
    dangerButton: {
        // borderColor handled dynamically
    },
});

export default GroupInfoScreen;
