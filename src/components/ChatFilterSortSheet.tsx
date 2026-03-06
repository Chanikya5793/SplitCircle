import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { IconButton, Text } from 'react-native-paper';
import { BlurView } from 'expo-blur';
import { useTheme } from '@/context/ThemeContext';
import Animated, {
    SlideInDown,
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    withSpring,
    runOnJS
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

export type ChatSortField = 'updatedAt' | 'unread' | 'name';
export type ChatSortOrder = 'asc' | 'desc';

interface ChatFilterSortSheetProps {
    visible: boolean;
    onClose: () => void;
    sortField: ChatSortField;
    sortOrder: ChatSortOrder;
    onSortFieldChange: (field: ChatSortField) => void;
    onSortOrderChange: (order: ChatSortOrder) => void;
    // Chat might not need currency filter, but could have "Type" filter (Direct/Group)?
    // For now, minimizing scope to sorting as requested + basic structure.
    showTypeFilter?: boolean;
    filterType?: 'all' | 'direct' | 'group';
    onFilterTypeChange?: (type: 'all' | 'direct' | 'group') => void;
}

export const ChatFilterSortSheet: React.FC<ChatFilterSortSheetProps> = ({
    visible,
    onClose,
    sortField,
    sortOrder,
    onSortFieldChange,
    onSortOrderChange,
    filterType,
    onFilterTypeChange,
}) => {
    const { theme, isDark } = useTheme();
    const translateY = useSharedValue(0);
    const context = useSharedValue({ y: 0 });

    const gesture = Gesture.Pan()
        .onStart(() => {
            context.value = { y: translateY.value };
        })
        .onUpdate((event) => {
            translateY.value = Math.max(0, event.translationY + context.value.y);
        })
        .onEnd((event) => {
            if (translateY.value > 100 || event.velocityY > 500) {
                translateY.value = withTiming(1000, { duration: 200 }, () => {
                    runOnJS(onClose)();
                });
            } else {
                translateY.value = withSpring(0, { damping: 50 });
            }
        });

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: translateY.value }],
    }));

    React.useEffect(() => {
        if (visible) {
            translateY.value = 0;
        }
    }, [visible]);

    const Chip = ({
        label,
        selected,
        onPress,
        icon,
        disabled = false
    }: {
        label: string;
        selected: boolean;
        onPress: () => void;
        icon?: string;
        disabled?: boolean;
    }) => (
        <Pressable
            onPress={disabled ? undefined : onPress}
            style={[
                styles.chip,
                {
                    backgroundColor: selected
                        ? theme.colors.primary
                        : isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
                    borderColor: selected ? theme.colors.primary : 'transparent',
                    opacity: disabled ? 0.4 : 1,
                },
            ]}
        >
            {icon && (
                <IconButton
                    icon={icon}
                    size={16}
                    iconColor={selected ? '#fff' : theme.colors.onSurface}
                    style={{ margin: 0, marginRight: -4 }}
                />
            )}
            <Text
                variant="labelMedium"
                style={{
                    color: selected ? '#fff' : theme.colors.onSurface,
                    fontWeight: selected ? '600' : '500',
                }}
            >
                {label}
            </Text>
        </Pressable>
    );

    if (!visible) return null;

    return (
        <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
            <View style={styles.overlay}>
                <Pressable style={styles.backdrop} onPress={onClose} />

                <GestureDetector gesture={gesture}>
                    <Animated.View
                        entering={SlideInDown.springify().damping(30).stiffness(350).mass(1)}
                        style={[styles.sheetContainer, animatedStyle]}
                    >
                        <BlurView
                            intensity={80}
                            tint={isDark ? 'dark' : 'light'}
                            style={StyleSheet.absoluteFill}
                        />
                        <View style={[styles.sheet, { backgroundColor: isDark ? 'rgba(30,30,40,0.35)' : 'rgba(255,255,255,0.4)' }]}>
                            {/* Handle bar */}
                            <View style={styles.handleContainer}>
                                <View style={[styles.handle, { backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)' }]} />
                            </View>

                            {/* Header */}
                            <View style={styles.header}>
                                <Text variant="titleLarge" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                                    Filters
                                </Text>
                                <IconButton
                                    icon="close"
                                    size={22}
                                    onPress={onClose}
                                    iconColor={theme.colors.onSurfaceVariant}
                                />
                            </View>

                            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
                                {/* Sort by */}
                                <View style={styles.section}>
                                    <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                        Sort by
                                    </Text>
                                    <View style={styles.chipWrap}>
                                        <Chip label="Activity" selected={sortField === 'updatedAt'} onPress={() => onSortFieldChange('updatedAt')} icon="clock-outline" />
                                        <Chip label="Unread" selected={sortField === 'unread'} onPress={() => onSortFieldChange('unread')} icon="email-outline" />
                                        <Chip label="Name" selected={sortField === 'name'} onPress={() => onSortFieldChange('name')} icon="alphabetical" />
                                    </View>
                                </View>

                                {/* Order */}
                                <View style={styles.section}>
                                    <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                        Order
                                    </Text>
                                    <View style={styles.chipWrap}>
                                        <Chip
                                            label={
                                                sortField === 'updatedAt' ? 'Newest first' :
                                                    sortField === 'unread' ? 'Most unread' :
                                                        'Z to A'
                                            }
                                            selected={sortOrder === 'desc'}
                                            onPress={() => onSortOrderChange('desc')}
                                            icon="arrow-down"
                                        />
                                        <Chip
                                            label={
                                                sortField === 'updatedAt' ? 'Oldest first' :
                                                    sortField === 'unread' ? 'Least unread' :
                                                        'A to Z'
                                            }
                                            selected={sortOrder === 'asc'}
                                            onPress={() => onSortOrderChange('asc')}
                                            icon="arrow-up"
                                        />
                                    </View>
                                </View>

                                {/* Filter Type */}
                                {onFilterTypeChange && filterType && (
                                    <View style={styles.section}>
                                        <Text variant="titleSmall" style={[styles.sectionTitle, { color: theme.colors.onSurfaceVariant }]}>
                                            Type
                                        </Text>
                                        <View style={styles.chipWrap}>
                                            <Chip label="All" selected={filterType === 'all'} onPress={() => onFilterTypeChange('all')} />
                                            <Chip label="Direct" selected={filterType === 'direct'} onPress={() => onFilterTypeChange('direct')} icon="account" />
                                            <Chip label="Groups" selected={filterType === 'group'} onPress={() => onFilterTypeChange('group')} icon="account-group" />
                                        </View>
                                    </View>
                                )}
                            </ScrollView>
                        </View>
                    </Animated.View>
                </GestureDetector>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.4)',
    },
    sheetContainer: {
        maxHeight: '70%',
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.15)',
        borderBottomWidth: 0,
    },
    sheet: {
        paddingBottom: 40,
    },
    handleContainer: {
        alignItems: 'center',
        paddingTop: 12,
        paddingBottom: 4,
    },
    handle: {
        width: 40,
        height: 4,
        borderRadius: 2,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingBottom: 8,
    },
    content: {
        paddingHorizontal: 20,
        paddingBottom: 80,
    },
    section: {
        marginBottom: 20,
    },
    sectionTitle: {
        marginBottom: 10,
        fontWeight: '600',
    },
    chipWrap: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 50,
        borderWidth: 1,
    },
});
